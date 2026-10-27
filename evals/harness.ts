/**
 * Extraction eval harness, imported by evals/run.ts (the `pnpm eval` entry) and by unit tests.
 * Importing this module has no side effects: it never reads env files, resolves a provider or
 * makes a call on its own.
 *
 * Fixture layout (synthetic only, never real personal documents):
 *   <fixturesDir>/<name>/input.txt
 *   <fixturesDir>/<name>/meta.json      { "reference_date": "2026-10-05",
 *                                         "reference_date_source": "user" | "detected" | "defaulted",
 *                                         "timezone": "America/New_York",
 *                                         "source_kind": "paste" | "upload" | "quick_add",
 *                                         "user": { "display_name": "Sam", "aliases": ["sam@example.com"] },
 *                                         "ambiguous": true | false,
 *                                         "page_offsets": [0, 812] }   (optional, uploads: start
 *                                         offset of each page in input.txt, as lib/capture/document.ts
 *                                         joinPages() records them; passed to the pipeline so evidence
 *                                         carries a page)
 *   <fixturesDir>/<name>/expected.json  { "items": [ { "type": "...", "owner": "user|other|unknown",
 *                                         "quote": "<substring of input.txt>",
 *                                         "due_date": "YYYY-MM-DD" | null,
 *                                         "band": "high|medium|low|ignore" } ] }
 *                                         (optional, scored when present: "due_certainty",
 *                                         "certainty", "page" (informational); other tester
 *                                         extensions are ignored)
 * A predicted item matches an expected one when one quote contains the other (normalized,
 * case-insensitive) AND the shorter covers at least MIN_QUOTE_COVERAGE of the longer's words, so a
 * fragment ("Ravi") or a blob spanning several sentences matches nothing on its own. Matching is
 * one-to-one: each golden item takes at most one predicted item and vice versa (best coverage
 * first), so duplicates and blobs count as extras. Items with expected band "ignore" must not be
 * shown.
 *
 * Scoring (see EvalReport.scores): a failed fixture is scored as if the model returned nothing, so
 * its golden items are misses; any failure, any null gated metric, or any F19 sub-threshold miss
 * means the run does not pass. Only-quota failures give result "incomplete_quota" (not judged),
 * unless a zero-tolerance gate (unverified quote shown, F19 speculative-as-High or
 * explicit-dated-as-Low) is already violated: missing fixtures cannot undo that, so it is "fail".
 *
 * Rule 9: per-fixture failures record only the classification (kind, status, attempts, error
 * class name) via safeErrorFields(); never the provider message, the model's raw text or the input.
 * Per-item detail identifies items by golden index and a short quote hash, never by text.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { AiFailureKind } from "@/lib/ai/errors";
import { extract } from "@/lib/ai/extract";
import { EXTRACT_PROMPT_VERSION } from "@/lib/ai/prompts";
import { safeErrorFields } from "@/lib/ai/safeError";
import { EXTRACTION_SCHEMA_VERSION } from "@/lib/ai/schema";
import { normalizeText } from "@/lib/pipeline/normalize";
import { processExtraction, type Proposal } from "@/lib/pipeline/proposals";
import type { Band, DueCertainty } from "@/lib/schemas";

export const THRESHOLDS = { recall: 0.8, precision: 0.75, date: 0.95, owner: 0.9, band: 0.85 };

/**
 * Default requests per minute for live providers. The Gemini free tier allows roughly 5 RPM on
 * Pro models and 10–15 RPM on Flash / Flash-Lite (per model, per project; Google changes these, so
 * check AI Studio's rate-limit page). 5 RPM is under every free-tier model's limit, and leaves
 * headroom for extract()'s one retry and for a dev server sharing the same key. A 40-fixture run
 * takes about 8 minutes at this rate (up to 16 if every fixture retries).
 */
export const DEFAULT_EVAL_RPM = 5;

export interface Throttle {
  /** null when calls are not throttled. */
  readonly rpm: number | null;
  /** Resolves when the next call may start. */
  wait(): Promise<void>;
}

export interface ThrottleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: ThrottleClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const NO_THROTTLE: Throttle = { rpm: null, wait: async () => {} };

/** Spaces call starts at least 60 000 / rpm ms apart (the first call starts at once). */
export function createThrottle(rpm: number, clock: ThrottleClock = realClock): Throttle {
  if (!(rpm > 0) || !Number.isFinite(rpm)) throw new RangeError("rpm must be a positive number");
  const interval = 60_000 / rpm;
  let next = Number.NEGATIVE_INFINITY;
  return {
    rpm,
    async wait() {
      const now = clock.now();
      const at = Math.max(now, next);
      next = at + interval; // reserved synchronously, so concurrent callers queue too
      if (at > now) await clock.sleep(at - now);
    },
  };
}

/** Thrown by evalRpm() for a malformed EVAL_RPM. Its message names the variable, never the value. */
export class EvalRpmError extends RangeError {
  constructor() {
    super('EVAL_RPM must be a positive decimal number (e.g. 5 or 2.5), 0 or "off".');
    this.name = "EvalRpmError";
  }
}

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * EVAL_RPM from the environment. Unset → DEFAULT_EVAL_RPM for a live provider, no throttle for
 * the recorded fake. "off" or any decimal zero ("0", "00", "0.0") → no throttle. Anything else must
 * be a plain positive decimal: hex ("0x10"), exponents ("1e1"), signs and units are rejected.
 */
export function evalRpm(env: Record<string, string | undefined>): number | null {
  const raw = env.EVAL_RPM?.trim();
  if (!raw) return env.AI_PROVIDER?.trim() === "fake" ? null : DEFAULT_EVAL_RPM;
  if (raw.toLowerCase() === "off") return null;
  if (!DECIMAL.test(raw)) throw new EvalRpmError();
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new EvalRpmError();
  return n === 0 ? null : n;
}

/** Wraps a model so that every provider call, retries included, waits for the throttle first. */
export function throttledModel(model: LanguageModel, throttle: Throttle): LanguageModel {
  if (throttle.rpm === null) return model;
  if (typeof model === "string") throw new TypeError("Pass a resolved model object, not a model ID string.");
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        await throttle.wait();
        return doGenerate();
      },
    },
  });
}

interface Expected {
  type: string;
  owner: "user" | "other" | "unknown";
  quote: string;
  due_date: string | null;
  band: Band;
  /** Tester extension; "none" iff due_date is null. Scored when present. */
  due_certainty?: DueCertainty;
  /** Tester extension: the certainty a correct model gives (absent on "ignore" items). Used for F19. */
  certainty?: "explicit" | "implied" | "speculative";
  /** Tester extension: 1-based page of the quote in an upload with meta.page_offsets. Informational. */
  page?: number;
}

/**
 * One golden or predicted item's outcome. Content-free (rule 9): items are identified by their
 * index in expected.json and a short hash of the normalized quote, never by text; diffs carry
 * enum values only, and a date diff says how it was wrong, not which dates were involved.
 */
export interface ItemResult {
  /**
   * matched: golden item shown. missed: golden item absent or scored Ignore. extra: shown item
   * matching no golden item. ignore_ok / ignore_shown: a golden "ignore" item left out / shown.
   */
  status: "matched" | "missed" | "extra" | "ignore_ok" | "ignore_shown";
  golden_index: number | null;
  /** First 12 hex chars of sha256(normalized quote): the golden quote, or the predicted one for extras. */
  quote_sha256: string;
  /** Predicted band, null when nothing was predicted. */
  band: Band | null;
  diffs: ItemDiff[];
}

export type ItemDiff =
  | { field: "band" | "owner" | "type" | "due_certainty"; expected: string; got: string }
  | { field: "due_date"; error: "wrong" | "invented" | "missing" };

export interface FixtureResult {
  name: string;
  /** False when extraction failed; the fixture is then scored as if the model returned nothing. */
  ok: boolean;
  ambiguous: boolean;
  expected: number;
  shown: number | null;
  attempts: number | null;
  /** Set when the fixture failed; "quota" means the provider limit, not the model, failed it. */
  failure: { kind: AiFailureKind; status: number | null; error: string } | null;
  counts: { matched: number; missed: number; extra: number; ignore_shown: number };
  items: ItemResult[];
}

/**
 * pass: every gate met. fail: a gate missed, a non-quota failure, or a zero-tolerance violation
 * (even alongside quota failures). incomplete_quota: only quota failures and no zero-tolerance
 * violation, so not judged.
 */
export type EvalResult = "pass" | "fail" | "incomplete_quota";

export interface EvalReport {
  model: string;
  prompt_version: string;
  schema_version: string;
  run_at: string;
  rpm: number | null;
  fixtures: number;
  ambiguous_fixtures: number;
  scores: {
    /** Golden items shown ÷ golden non-ignore items (failed fixtures' items count as missed). */
    recall: number | null;
    /** Shown items matching a golden non-ignore item ÷ shown items. */
    precision: number | null;
    /** 1 − precision. */
    false_positive_rate: number | null;
    /**
     * Matched items with a correct due_date ÷ matched items where the golden or the prediction has
     * a date. A date on a dateless golden is an error (rule 3: never fill a missing date).
     */
    date: number | null;
    owner: number | null;
    /** Band accuracy on ambiguous fixtures only (F19 uncertainty eval); this is the gated band score. */
    band: number | null;
    /** Band accuracy over every fixture (informational). */
    band_all: number | null;
    /** Matched items whose due_certainty (explicit / inferred / none) equals the golden (informational). */
    due_certainty: number | null;
    /** Matched items whose type equals the golden (informational). */
    type: number | null;
    /** Matched items with a golden page whose first evidence quote is on that page (informational). */
    page: number | null;
    /** Shown items with a verified quote ÷ shown items (PRD scorecard; must be 100%). */
    verified_quotes: number | null;
    unverified_quotes_shown: number;
    /** F19: golden speculative (or "ignore") items shown as High. Must be 0. */
    speculative_scored_high: number;
    /** F19: golden explicit, dated commitments scored Low or Ignore. Must be 0. */
    explicit_dated_scored_low: number;
    extraction_failures: number;
  };
  failures_by_kind: Partial<Record<AiFailureKind, number>>;
  /** False when any fixture failed (quota or otherwise): the scores then undercount the model. */
  complete: boolean;
  thresholds: typeof THRESHOLDS;
  result: EvalResult;
  pass: boolean;
  perFixture: FixtureResult[];
}

export interface RunEvalOptions {
  fixturesDir: string;
  model: LanguageModel;
  /** e.g. "google:gemini-3.5-flash"; recorded in the report and the scorecard header. */
  modelLabel: string;
  throttle?: Throttle;
  /** ISO timestamp of the run; supplied by the caller (the harness reads no clock). */
  runAt: string;
}

const norm = (s: string) => normalizeText(s).toLowerCase();
/**
 * Minimum share of the longer quote's words that the shorter one must cover. 0.5, not
 * verifyQuotes' 0.9: that threshold checks a quote against its source (it must be verbatim);
 * here the question is "same item?", and a model legitimately quotes a clause where the golden
 * has the sentence, or the reverse. Half the words rejects fragments and two-sentence blobs while
 * keeping those. Containment is still required, so the overlap is one contiguous span.
 */
export const MIN_QUOTE_COVERAGE = 0.5;
const words = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Coverage of the pair in [0, 1], or 0 when neither quote contains the other or coverage is too low. */
export function quoteMatch(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb || !(na.includes(nb) || nb.includes(na))) return 0;
  const wa = words(a).length;
  const wb = words(b).length;
  if (wa === 0 || wb === 0) return 0;
  const coverage = Math.min(wa, wb) / Math.max(wa, wb);
  return coverage >= MIN_QUOTE_COVERAGE ? coverage : 0;
}
const pairScore = (p: Proposal, e: Expected) => Math.max(0, ...p.evidence.map((ev) => quoteMatch(ev.quote, e.quote)));

/**
 * One-to-one assignment of proposals to golden items: every matching pair, best coverage first
 * (ties: golden order, then proposal order), each side used once. Returns golden index -> proposal.
 */
function assign(expected: Expected[], proposals: Proposal[]): Map<number, Proposal> {
  const pairs: { e: number; p: number; score: number }[] = [];
  expected.forEach((e, ei) =>
    proposals.forEach((p, pi) => {
      const score = pairScore(p, e);
      if (score > 0) pairs.push({ e: ei, p: pi, score });
    }),
  );
  pairs.sort((x, y) => y.score - x.score || x.e - y.e || x.p - y.p);
  const out = new Map<number, Proposal>();
  const used = new Set<number>();
  for (const { e, p } of pairs) {
    if (out.has(e) || used.has(p)) continue;
    out.set(e, proposals[p]!);
    used.add(p);
  }
  return out;
}
const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
export const quoteHash = (q: string) => createHash("sha256").update(norm(q)).digest("hex").slice(0, 12);

export function listFixtures(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "expected.json")))
    .map((d) => d.name)
    .sort();
}

type Tally = Record<
  | "expected" | "matched" | "shown" | "shownMatched" | "dated" | "dateOk" | "owner" | "ownerOk"
  | "bandAll" | "bandAllOk" | "bandAmb" | "bandAmbOk" | "dueCert" | "dueCertOk" | "type" | "typeOk" | "page" | "pageOk"
  | "unverifiedShown" | "specHigh" | "explicitLow" | "failures",
  number
>;

const isSpeculative = (e: Expected) => e.certainty === "speculative" || e.band === "ignore";
const isExplicitDatedCommitment = (e: Expected) => e.type === "commitment" && e.certainty === "explicit" && e.due_date !== null;

/** Scores one fixture's proposals against its golden items, adding to `t`. Pure; no text leaves it. */
function scoreFixture(text: string, expected: Expected[], proposals: Proposal[], ambiguous: boolean, t: Tally): { items: ItemResult[]; shown: number } {
  const items: ItemResult[] = [];
  const shown = proposals.filter((p) => p.band !== "ignore");
  t.shown += shown.length;
  const assigned = assign(expected, proposals);

  expected.forEach((e, i) => {
    const p = assigned.get(i);
    const isShown = !!p && p.band !== "ignore";
    const r: ItemResult = { status: "missed", golden_index: i, quote_sha256: quoteHash(e.quote), band: p?.band ?? null, diffs: [] };
    items.push(r);
    t.bandAll++;
    if (ambiguous) t.bandAmb++;
    const bandOk = (ok: boolean) => {
      if (!ok) r.diffs.push({ field: "band", expected: e.band, got: p?.band ?? "absent" });
      if (ok) t.bandAllOk++;
      if (ok && ambiguous) t.bandAmbOk++;
    };
    if (isShown && p!.band === "high" && isSpeculative(e)) t.specHigh++;
    if (p && (p.band === "low" || p.band === "ignore") && isExplicitDatedCommitment(e)) t.explicitLow++;

    if (e.band === "ignore") {
      r.status = isShown ? "ignore_shown" : "ignore_ok";
      bandOk(!isShown);
      return;
    }
    t.expected++;
    if (!isShown) {
      bandOk(false);
      return;
    }
    r.status = "matched";
    t.matched++;
    bandOk(p!.band === e.band);
    t.owner++;
    if (p!.item.owner === e.owner) t.ownerOk++;
    else r.diffs.push({ field: "owner", expected: e.owner, got: p!.item.owner });
    t.type++;
    if (p!.item.type === e.type) t.typeOk++;
    else r.diffs.push({ field: "type", expected: e.type, got: p!.item.type });
    const goldCert: DueCertainty = e.due_certainty ?? (e.due_date === null ? "none" : "explicit");
    if (e.due_certainty !== undefined) {
      t.dueCert++;
      if (p!.date.due_certainty === goldCert) t.dueCertOk++;
      else r.diffs.push({ field: "due_certainty", expected: goldCert, got: p!.date.due_certainty });
    }
    if (e.page !== undefined) {
      t.page++;
      if (p!.evidence[0]?.page === e.page) t.pageOk++;
    }
    const got = p!.date.due_date;
    if (e.due_date !== null || got !== null) {
      t.dated++;
      if (got === e.due_date) t.dateOk++;
      else r.diffs.push({ field: "due_date", error: e.due_date === null ? "invented" : got === null ? "missing" : "wrong" });
    }
  });

  const goldenOf = new Map<Proposal, Expected>([...assigned].map(([i, p]) => [p, expected[i]!]));
  for (const p of shown) {
    if (p.evidence.some((e) => text.slice(e.start_offset, e.end_offset) !== e.quote)) t.unverifiedShown++;
    const g = goldenOf.get(p);
    if (g && g.band !== "ignore") {
      t.shownMatched++;
      continue;
    }
    if (g) continue; // recorded as ignore_shown
    items.push({ status: "extra", golden_index: null, quote_sha256: quoteHash(p.evidence[0]?.quote ?? ""), band: p.band, diffs: [] });
  }
  return { items, shown: shown.length };
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const throttle = opts.throttle ?? NO_THROTTLE;
  const model = throttledModel(opts.model, throttle);
  const names = listFixtures(opts.fixturesDir);

  const t = Object.fromEntries(
    ["expected", "matched", "shown", "shownMatched", "dated", "dateOk", "owner", "ownerOk", "bandAll", "bandAllOk", "bandAmb", "bandAmbOk", "dueCert", "dueCertOk", "type", "typeOk", "page", "pageOk", "unverifiedShown", "specHigh", "explicitLow", "failures"].map((k) => [k, 0]),
  ) as Tally;
  const failuresByKind: Partial<Record<AiFailureKind, number>> = {};
  const perFixture: FixtureResult[] = [];
  let ambiguousCount = 0;

  for (const name of names) {
    const dir = join(opts.fixturesDir, name);
    const text = readFileSync(join(dir, "input.txt"), "utf8");
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    const expected: Expected[] = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")).items;
    const ambiguous = meta.ambiguous === true;
    const pageOffsets: number[] | null = Array.isArray(meta.page_offsets) ? meta.page_offsets : null;
    if (ambiguous) ambiguousCount++;

    let proposals: Proposal[] = [];
    let attempts: number | null = null;
    let failure: FixtureResult["failure"] = null;
    try {
      const run = await extract(
        {
          sourceText: text,
          sourceKind: meta.source_kind ?? "paste",
          referenceDate: meta.reference_date,
          referenceDateSource: meta.reference_date_source ?? "user",
          timezone: meta.timezone ?? "America/New_York",
          user: { displayName: meta.user?.display_name ?? "", aliases: meta.user?.aliases ?? [] },
        },
        { model, modelLabel: opts.modelLabel, logger: () => {} },
      );
      attempts = run.attempts;
      proposals = processExtraction(run.output, {
        sourceText: text,
        referenceDate: meta.reference_date,
        referenceDateSource: meta.reference_date_source ?? "user",
        timezone: meta.timezone ?? "America/New_York",
        pageOffsets,
        logger: () => {},
      }).proposals.filter((p) => p.item.type !== "key_fact");
    } catch (err) {
      // A failed fixture is scored as if the model returned nothing: its golden items are misses.
      const f = safeErrorFields(err);
      t.failures++;
      failuresByKind[f.kind] = (failuresByKind[f.kind] ?? 0) + 1;
      attempts = f.attempts;
      failure = { kind: f.kind, status: f.status, error: f.error };
      proposals = [];
    }

    const { items, shown } = scoreFixture(text, expected, proposals, ambiguous, t);
    const count = (s: ItemResult["status"]) => items.filter((x) => x.status === s).length;
    perFixture.push({
      name,
      ok: failure === null,
      ambiguous,
      expected: expected.length,
      shown: failure === null ? shown : null,
      attempts,
      failure,
      counts: { matched: count("matched"), missed: count("missed"), extra: count("extra"), ignore_shown: count("ignore_shown") },
      items,
    });
  }

  const precision = ratio(t.shownMatched, t.shown);
  const scores: EvalReport["scores"] = {
    recall: ratio(t.matched, t.expected),
    precision,
    false_positive_rate: precision === null ? null : 1 - precision,
    date: ratio(t.dateOk, t.dated),
    owner: ratio(t.ownerOk, t.owner),
    band: ratio(t.bandAmbOk, t.bandAmb),
    band_all: ratio(t.bandAllOk, t.bandAll),
    due_certainty: ratio(t.dueCertOk, t.dueCert),
    type: ratio(t.typeOk, t.type),
    page: ratio(t.pageOk, t.page),
    verified_quotes: ratio(t.shown - t.unverifiedShown, t.shown),
    unverified_quotes_shown: t.unverifiedShown,
    speculative_scored_high: t.specHigh,
    explicit_dated_scored_low: t.explicitLow,
    extraction_failures: t.failures,
  };

  const result = judge(names.length, scores, failuresByKind);
  return {
    model: opts.modelLabel,
    prompt_version: EXTRACT_PROMPT_VERSION,
    schema_version: EXTRACTION_SCHEMA_VERSION,
    run_at: opts.runAt,
    rpm: throttle.rpm,
    fixtures: names.length,
    ambiguous_fixtures: ambiguousCount,
    scores,
    failures_by_kind: failuresByKind,
    complete: t.failures === 0,
    thresholds: THRESHOLDS,
    result,
    pass: result === "pass",
    perFixture,
  };
}

/** Names of the gates a report misses; empty means every gate is met. A null metric is a miss. */
export function failedGates(fixtures: number, s: EvalReport["scores"]): string[] {
  const missed: string[] = [];
  if (fixtures === 0) missed.push("no_fixtures");
  for (const k of Object.keys(THRESHOLDS) as (keyof typeof THRESHOLDS)[]) {
    const v = s[k];
    if (v === null) missed.push(`${k}_not_measured`);
    else if (v < THRESHOLDS[k]) missed.push(k);
  }
  if (s.unverified_quotes_shown !== 0) missed.push("unverified_quotes_shown");
  if (s.speculative_scored_high !== 0) missed.push("speculative_scored_high");
  if (s.explicit_dated_scored_low !== 0) missed.push("explicit_dated_scored_low");
  if (s.extraction_failures !== 0) missed.push("extraction_failures");
  return missed;
}

function judge(fixtures: number, s: EvalReport["scores"], byKind: Partial<Record<AiFailureKind, number>>): EvalResult {
  const failed = Object.values(byKind).reduce((a, b) => a + (b ?? 0), 0);
  // A zero-tolerance violation already seen stands whatever the quota-failed fixtures would add.
  const hard = s.unverified_quotes_shown !== 0 || s.speculative_scored_high !== 0 || s.explicit_dated_scored_low !== 0;
  if (failed > 0 && byKind.quota === failed && !hard) return "incomplete_quota";
  return failedGates(fixtures, s).length === 0 ? "pass" : "fail";
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const RESULT_LINE: Record<EvalResult, string> = {
  pass: "Result: PASS",
  fail: "Result: FAIL",
  incomplete_quota: "Result: INCOMPLETE (quota). Some fixtures hit the provider quota, so this run is not judged. Lower EVAL_RPM and re-run.",
};

/**
 * Markdown scorecard (evals/SCORECARD.md and the timestamped copy). The header always names model,
 * prompt version, schema version and run date (PRD Trust Scorecard). Content-free: fixture names,
 * counts, enums and percentages only.
 */
export function renderScorecard(r: EvalReport): string {
  const s = r.scores;
  const th = r.thresholds;
  const lines = [
    "# Trust Scorecard",
    "",
    `- Model: ${r.model}`,
    `- Prompt version: ${r.prompt_version}`,
    `- Schema version: ${r.schema_version}`,
    `- Run date: ${r.run_at}`,
    `- Fixtures: ${r.fixtures} (${r.ambiguous_fixtures} ambiguous)`,
    `- Throttle: ${r.rpm === null ? "off" : `${r.rpm} requests/min`}`,
    "",
    RESULT_LINE[r.result],
    "",
    "| Metric | Result | Threshold | How it's measured |",
    "| --- | --- | --- | --- |",
    `| Precision | ${pct(s.precision)} | ≥ ${pct(th.precision)} | Shown items matching a golden item ÷ all shown items (every type except key facts) |`,
    `| Recall | ${pct(s.recall)} | ≥ ${pct(th.recall)} | Golden items shown ÷ all golden items; a failed fixture's items count as missed |`,
    `| Date accuracy | ${pct(s.date)} | ≥ ${pct(th.date)} | Correct due dates ÷ matched items where the golden or the prediction has a date (an invented date is an error) |`,
    `| Owner accuracy | ${pct(s.owner)} | ≥ ${pct(th.owner)} | Correct owner ÷ matched items |`,
    `| Verified quotations | ${pct(s.verified_quotes)} | 100% | Shown items with a server-verified quote ÷ shown items |`,
    `| False-positive rate | ${pct(s.false_positive_rate)} | | Shown items not in the golden set ÷ all shown items |`,
    `| Uncertainty band accuracy | ${pct(s.band)} | ≥ ${pct(th.band)} | Golden items in ambiguous fixtures landing in their expected band |`,
    `| Speculative items scored High | ${s.speculative_scored_high} | 0 | Golden speculative or Ignore items shown as Likely |`,
    `| Explicit dated commitments scored Low | ${s.explicit_dated_scored_low} | 0 | Golden explicit, dated commitments scored Also noticed or Ignore |`,
    `| Ask-why fabrications | not run | 0 | The Ask-why eval is not wired yet |`,
    `| Extraction failures | ${s.extraction_failures} | 0 | Fixtures whose extraction call failed |`,
    `| Evaluation cases | ${r.fixtures} | 40 | Synthetic fixtures in \`evals/fixtures/\` |`,
    "",
    "Informational (not gated):",
    "",
    `- Band accuracy, all fixtures: ${pct(s.band_all)}`,
    `- Date certainty (explicit / inferred / none) accuracy: ${pct(s.due_certainty)}`,
    `- Item type accuracy: ${pct(s.type)}`,
    `- Evidence page accuracy (uploads with page offsets): ${pct(s.page)}`,
  ];
  const failures = Object.entries(r.failures_by_kind);
  if (failures.length) lines.push(`- Failures by kind: ${failures.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (r.result === "fail") lines.push(`- Gates missed: ${failedGates(r.fixtures, s).join(", ")}`);
  lines.push("", "## Per fixture", "", "| Fixture | Status | Matched | Missed | Extra | Ignore shown |", "| --- | --- | --- | --- | --- | --- |");
  for (const f of r.perFixture) {
    const status = f.failure ? `failed (${f.failure.kind})` : "ok";
    lines.push(`| ${f.name} | ${status} | ${f.counts.matched} | ${f.counts.missed} | ${f.counts.extra} | ${f.counts.ignore_shown} |`);
  }
  if (!r.complete) lines.push("", "Incomplete run: some fixtures failed, so the scores undercount the model.");
  return [...lines, ""].join("\n");
}
