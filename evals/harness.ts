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
 *                                         "ambiguous": true | false }
 *   <fixturesDir>/<name>/expected.json  { "items": [ { "type": "...", "owner": "user|other|unknown",
 *                                         "quote": "<substring of input.txt>",
 *                                         "due_date": "YYYY-MM-DD" | null,
 *                                         "band": "high|medium|low|ignore" } ] }
 * A predicted item matches an expected one when one quote contains the other (normalized,
 * case-insensitive). Items with expected band "ignore" must not be shown.
 *
 * Rule 9: per-fixture failures record only the classification (kind, status, attempts, error
 * class name) via safeErrorFields(); never the provider message, the model's raw text or the input.
 */
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

/**
 * EVAL_RPM from the environment. Unset → DEFAULT_EVAL_RPM for a live provider, no throttle for
 * the recorded fake. "0" or "off" → no throttle. Anything else must be a positive number.
 */
export function evalRpm(env: Record<string, string | undefined>): number | null {
  const raw = env.EVAL_RPM?.trim();
  if (!raw) return env.AI_PROVIDER?.trim() === "fake" ? null : DEFAULT_EVAL_RPM;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`EVAL_RPM must be a positive number, 0 or "off" (got "${raw}").`);
  return n;
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
  band: "high" | "medium" | "low" | "ignore";
}

export interface FixtureResult {
  name: string;
  ok: boolean;
  expected: number;
  shown: number | null;
  attempts: number | null;
  /** Set when the fixture failed; "quota" means the provider limit, not the model, failed it. */
  failure: { kind: AiFailureKind; status: number | null; error: string } | null;
}

export interface EvalReport {
  model: string;
  prompt_version: string;
  schema_version: string;
  run_at: string;
  rpm: number | null;
  fixtures: number;
  scores: {
    recall: number | null;
    precision: number | null;
    date: number | null;
    owner: number | null;
    band: number | null;
    unverified_quotes_shown: number;
    extraction_failures: number;
  };
  failures_by_kind: Partial<Record<AiFailureKind, number>>;
  /** False when any fixture failed on provider quota: the scores then undercount the model. */
  complete: boolean;
  thresholds: typeof THRESHOLDS;
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
const overlaps = (a: string, b: string) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));
const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

export function listFixtures(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "expected.json")))
    .map((d) => d.name)
    .sort();
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const throttle = opts.throttle ?? NO_THROTTLE;
  const model = throttledModel(opts.model, throttle);
  const names = listFixtures(opts.fixturesDir);

  const t = { expected: 0, matched: 0, shown: 0, shownMatched: 0, dated: 0, dateOk: 0, owner: 0, ownerOk: 0, band: 0, bandOk: 0, unverifiedShown: 0, failures: 0 };
  const failuresByKind: Partial<Record<AiFailureKind, number>> = {};
  const perFixture: FixtureResult[] = [];

  for (const name of names) {
    const dir = join(opts.fixturesDir, name);
    const text = readFileSync(join(dir, "input.txt"), "utf8");
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    const expected: Expected[] = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")).items;

    let proposals: Proposal[] = [];
    let attempts: number | null = null;
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
        logger: () => {},
      }).proposals.filter((p) => p.item.type !== "key_fact");
    } catch (err) {
      const f = safeErrorFields(err);
      t.failures++;
      failuresByKind[f.kind] = (failuresByKind[f.kind] ?? 0) + 1;
      perFixture.push({ name, ok: false, expected: expected.length, shown: null, attempts: f.attempts, failure: { kind: f.kind, status: f.status, error: f.error } });
      continue;
    }

    const shown = proposals.filter((p) => p.band !== "ignore");
    t.shown += shown.length;
    for (const p of shown) {
      if (p.evidence.some((e) => text.slice(e.start_offset, e.end_offset) !== e.quote)) t.unverifiedShown++;
      if (expected.some((e) => e.band !== "ignore" && p.evidence.some((ev) => overlaps(ev.quote, e.quote)))) t.shownMatched++;
    }

    for (const e of expected) {
      const p = proposals.find((x) => x.evidence.some((ev) => overlaps(ev.quote, e.quote)));
      t.band++;
      if (e.band === "ignore") {
        if (!p || p.band === "ignore") t.bandOk++;
        continue;
      }
      t.expected++;
      if (!p || p.band === "ignore") continue;
      t.matched++;
      if (p.band === e.band) t.bandOk++;
      t.owner++;
      if (p.item.owner === e.owner) t.ownerOk++;
      if (e.due_date) {
        t.dated++;
        if (p.date.due_date === e.due_date) t.dateOk++;
      }
    }
    perFixture.push({ name, ok: true, expected: expected.length, shown: shown.length, attempts, failure: null });
  }

  const scores = {
    recall: ratio(t.matched, t.expected),
    precision: ratio(t.shownMatched, t.shown),
    date: ratio(t.dateOk, t.dated),
    owner: ratio(t.ownerOk, t.owner),
    band: ratio(t.bandOk, t.band),
    unverified_quotes_shown: t.unverifiedShown,
    extraction_failures: t.failures,
  };
  const pass =
    t.unverifiedShown === 0 &&
    (Object.keys(THRESHOLDS) as (keyof typeof THRESHOLDS)[]).every((k) => scores[k] === null || (scores[k] as number) >= THRESHOLDS[k]);

  return {
    model: opts.modelLabel,
    prompt_version: EXTRACT_PROMPT_VERSION,
    schema_version: EXTRACTION_SCHEMA_VERSION,
    run_at: opts.runAt,
    rpm: throttle.rpm,
    fixtures: names.length,
    scores,
    failures_by_kind: failuresByKind,
    complete: !failuresByKind.quota,
    thresholds: THRESHOLDS,
    pass,
    perFixture,
  };
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

/** Markdown scorecard. The header always names model, prompt version, schema version and run date (PRD scorecard). */
export function renderScorecard(r: EvalReport): string {
  const header = [
    "# Extraction eval scorecard",
    "",
    `- Model: ${r.model}`,
    `- Prompt version: ${r.prompt_version}`,
    `- Schema version: ${r.schema_version}`,
    `- Run date: ${r.run_at}`,
    `- Fixtures: ${r.fixtures}`,
    `- Throttle: ${r.rpm === null ? "off" : `${r.rpm} requests/min`}`,
  ];
  const rows = [
    "",
    "| Metric | Score | Threshold |",
    "| --- | --- | --- |",
    `| Recall | ${pct(r.scores.recall)} | ≥ ${pct(r.thresholds.recall)} |`,
    `| Precision | ${pct(r.scores.precision)} | ≥ ${pct(r.thresholds.precision)} |`,
    `| Date accuracy | ${pct(r.scores.date)} | ≥ ${pct(r.thresholds.date)} |`,
    `| Owner accuracy | ${pct(r.scores.owner)} | ≥ ${pct(r.thresholds.owner)} |`,
    `| Band accuracy | ${pct(r.scores.band)} | ≥ ${pct(r.thresholds.band)} |`,
    `| Unverified quotes shown | ${r.scores.unverified_quotes_shown} | 0 |`,
    `| Extraction failures | ${r.scores.extraction_failures} | |`,
    "",
    `Result: ${r.pass ? "PASS" : "FAIL"}`,
  ];
  const failures = Object.entries(r.failures_by_kind);
  if (failures.length) rows.push("", `Failures by kind: ${failures.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (!r.complete) rows.push("", "Incomplete run: some fixtures hit the provider quota, so scores undercount the model. Re-run with a lower EVAL_RPM.");
  return [...header, ...rows, ""].join("\n");
}
