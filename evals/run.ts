/**
 * Extraction eval (`pnpm eval`). Runs the real extract() + deterministic pipeline over every
 * fixture in evals/fixtures and scores it against the golden output.
 *
 * Uses the configured AI_PROVIDER / AI_MODEL. With a real provider this makes live calls and
 * costs money. AI_PROVIDER=fake replays recordings and only checks the harness itself.
 *
 * Fixture layout (synthetic only, never real personal documents):
 *   evals/fixtures/<name>/input.txt
 *   evals/fixtures/<name>/meta.json      { "reference_date": "2026-10-05",
 *                                          "reference_date_source": "user" | "detected" | "defaulted",
 *                                          "timezone": "America/New_York",
 *                                          "source_kind": "paste" | "upload" | "quick_add",
 *                                          "user": { "display_name": "Sam", "aliases": ["sam@example.com"] },
 *                                          "ambiguous": true | false }
 *   evals/fixtures/<name>/expected.json  { "items": [ { "type": "...", "owner": "user|other|unknown",
 *                                          "quote": "<substring of input.txt>",
 *                                          "due_date": "YYYY-MM-DD" | null,
 *                                          "band": "high|medium|low|ignore" } ] }
 * A predicted item matches an expected one when one quote contains the other (normalized,
 * case-insensitive). Items with expected band "ignore" must not be shown.
 *
 * Ask-why eval (10 answerable + 10 unanswerable questions) is not wired yet.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extract } from "@/lib/ai/extract";
import { normalizeText } from "@/lib/pipeline/normalize";
import { processExtraction, type Proposal } from "@/lib/pipeline/proposals";

const THRESHOLDS = { recall: 0.8, precision: 0.75, date: 0.95, owner: 0.9, band: 0.85 };

interface Expected {
  type: string;
  owner: "user" | "other" | "unknown";
  quote: string;
  due_date: string | null;
  band: "high" | "medium" | "low" | "ignore";
}

const root = join(process.cwd(), "evals", "fixtures");
const norm = (s: string) => normalizeText(s).toLowerCase();
const overlaps = (a: string, b: string) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));
const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

async function main() {
  if (!process.env.AI_PROVIDER || !process.env.AI_MODEL) {
    console.error("Set AI_PROVIDER and AI_MODEL. A real provider makes live calls and costs money.");
    process.exit(2);
  }
  const names = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(root, d.name, "expected.json"))).map((d) => d.name)
    : [];
  if (names.length === 0) {
    console.log("No fixtures in evals/fixtures yet.");
    return;
  }

  const t = { expected: 0, matched: 0, shown: 0, shownMatched: 0, dated: 0, dateOk: 0, owner: 0, ownerOk: 0, band: 0, bandOk: 0, unverifiedShown: 0, failures: 0 };
  const perFixture: Array<Record<string, unknown>> = [];

  for (const name of names) {
    const dir = join(root, name);
    const text = readFileSync(join(dir, "input.txt"), "utf8");
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    const expected: Expected[] = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")).items;

    let proposals: Proposal[] = [];
    try {
      const run = await extract({
        sourceText: text,
        sourceKind: meta.source_kind ?? "paste",
        referenceDate: meta.reference_date,
        referenceDateSource: meta.reference_date_source ?? "user",
        timezone: meta.timezone ?? "America/New_York",
        user: { displayName: meta.user?.display_name ?? "", aliases: meta.user?.aliases ?? [] },
      }, { logger: () => {} });
      proposals = processExtraction(run.output, {
        sourceText: text,
        referenceDate: meta.reference_date,
        referenceDateSource: meta.reference_date_source ?? "user",
        timezone: meta.timezone ?? "America/New_York",
        logger: () => {},
      }).proposals.filter((p) => p.item.type !== "key_fact");
    } catch (err) {
      t.failures++;
      perFixture.push({ name, error: err instanceof Error ? err.name : String(err) });
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
    perFixture.push({ name, expected: expected.length, shown: shown.length });
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

  const report = { model: `${process.env.AI_PROVIDER}:${process.env.AI_MODEL}`, fixtures: names.length, scores, thresholds: THRESHOLDS, pass, perFixture };
  mkdirSync(join(process.cwd(), "evals", "results"), { recursive: true });
  const out = join(process.cwd(), "evals", "results", `extract-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, perFixture: undefined }, null, 2));
  console.log(`Full report: ${out}`);
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
