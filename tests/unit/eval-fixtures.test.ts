import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extract } from "@/lib/ai/extract";
import { createRecordedModel, type Recording } from "@/lib/ai/fake";
import { Certainty, Extraction, ItemType, Owner, type Item } from "@/lib/ai/schema";
import { normalizeText } from "@/lib/pipeline/normalize";
import { processExtraction } from "@/lib/pipeline/proposals";
import { containsWholePhrase } from "@/lib/pipeline/verifyQuotes";
import { Band, DueCertainty } from "@/lib/schemas";

/**
 * Checks the eval fixtures in evals/fixtures without any live model call.
 *
 * 1. Format: meta.json and expected.json match the format evals/run.ts reads, plus the tester
 *    extensions (title, certainty, date_text, due_certainty, due_at, counterparty, amount_text, note).
 * 2. Every golden quote is a verbatim substring of input.txt, no two golden quotes overlap (the
 *    runner matches by quote containment), and golden date/amount/name phrases appear in the source.
 * 3. Synthetic only: every email address and web domain uses a reserved example domain, and
 *    phone numbers use the fictional 555-01xx range.
 * 4. "Perfect model" replay: the golden items are turned into a model response, replayed through
 *    extract() with the fake recorded provider (schema validation included), then through the real
 *    pipeline. Band, due date, date certainty and (where given) due_at must equal the golden values.
 *    This proves the goldens are reachable under the PRD scoring and date rules, so a live-eval miss
 *    is a model miss, not a golden error.
 *
 * Set EVAL_RECORDINGS_OUT=<dir> to also write those perfect responses as fake-provider recordings,
 * for `AI_PROVIDER=fake AI_MODEL=golden AI_RECORDINGS_DIR=<dir> pnpm eval` (harness self-check).
 */

const root = join(process.cwd(), "evals", "fixtures");
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Meta = z
  .object({
    description: z.string().min(10),
    covers: z.array(z.string()).min(1),
    reference_date: YMD,
    reference_date_source: z.enum(["user", "detected", "defaulted"]),
    timezone: z.string().min(3),
    source_kind: z.enum(["paste", "upload", "quick_add"]),
    user: z.object({ display_name: z.string().min(1), aliases: z.array(z.string().min(1)).max(20) }).strict(),
    ambiguous: z.boolean(),
  })
  .strict();

const ExpectedItem = z
  .object({
    // Read by evals/run.ts
    type: ItemType.exclude(["key_fact"]), // the runner drops key_fact proposals, so a golden key_fact could never match
    owner: Owner,
    quote: z.string().min(3).max(400),
    due_date: YMD.nullable(),
    band: Band,
    // Tester extensions (ignored by evals/run.ts)
    title: z.string().min(3).max(80),
    date_text: z.string().nullable(),
    due_certainty: DueCertainty,
    due_at: z.string().datetime().optional(),
    certainty: Certainty.optional(), // the certainty a correct model gives; omitted for "ignore" items a correct model leaves out
    counterparty: z.string().nullable().optional(),
    amount_text: z.string().nullable().optional(),
    note: z.string().optional(),
  })
  .strict()
  .refine((e) => e.band === "ignore" || e.certainty !== undefined, { message: "shown items need the expected model certainty" })
  .refine((e) => (e.due_date === null) === (e.due_certainty === "none"), { message: "due_certainty none iff due_date null" })
  .refine((e) => e.due_date === null || e.date_text !== null, { message: "a dated item needs its date_text" });

const Expected = z.object({ notes: z.string().optional(), items: z.array(ExpectedItem) }).strict();

type Fixture = { name: string; text: string; meta: z.infer<typeof Meta>; expected: z.infer<typeof Expected> };

const names = existsSync(root)
  ? readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : [];

function load(name: string): Fixture {
  const dir = join(root, name);
  return {
    name,
    text: readFileSync(join(dir, "input.txt"), "utf8"),
    meta: Meta.parse(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))),
    expected: Expected.parse(JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"))),
  };
}

const norm = (s: string) => normalizeText(s).toLowerCase();
const overlaps = (a: string, b: string) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));

/** The model response a perfect extractor would give for this fixture. */
function perfectOutput(f: Fixture) {
  const items: Item[] = f.expected.items
    .filter((e) => e.certainty !== undefined)
    .map((e) => ({
      type: e.type,
      title: e.title,
      owner: e.owner,
      counterparty: e.counterparty ?? null,
      action: null,
      date_text: e.date_text,
      date_iso: e.due_date,
      amount_text: e.amount_text ?? null,
      certainty: e.certainty!,
      uncertainty_notes: [],
      matches_thread_id: null,
      evidence: [{ quote: e.quote, speaker: null }],
    }));
  return Extraction.parse({ source_summary: `Golden replay for ${f.name}`, participants: [], items, brief: null });
}

describe("eval fixtures", () => {
  it("there are fixtures, each with input.txt, meta.json and expected.json", () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const n of names) {
      for (const file of ["input.txt", "meta.json", "expected.json"]) {
        expect(existsSync(join(root, n, file)), `${n}/${file}`).toBe(true);
      }
    }
  });

  describe.each(names)("%s", (name) => {
    const f = load(name);

    it("golden quotes are verbatim, non-overlapping, and phrases appear in the source", () => {
      expect(f.text.length).toBeLessThanOrEqual(30_000); // MAX_INPUT_CHARS
      for (const e of f.expected.items) {
        expect(f.text.includes(e.quote), `quote not verbatim: ${e.quote}`).toBe(true);
        if (e.date_text) expect(containsWholePhrase(f.text, e.date_text, "date"), `date_text: ${e.date_text}`).toBe(true);
        if (e.amount_text) expect(containsWholePhrase(f.text, e.amount_text, "amount"), `amount_text: ${e.amount_text}`).toBe(true);
        if (e.counterparty) expect(containsWholePhrase(f.text, e.counterparty, "text"), `counterparty: ${e.counterparty}`).toBe(true);
      }
      const q = f.expected.items.map((e) => e.quote);
      for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++) expect(overlaps(q[i]!, q[j]!), `${q[i]} / ${q[j]}`).toBe(false);
    });

    it("is synthetic: reserved example domains and fictional phone numbers only", () => {
      const all = `${f.text}\n${JSON.stringify(f.meta)}`;
      const reserved = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;
      for (const m of all.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) expect(m[1], `email domain in ${m[0]}`).toMatch(reserved);
      for (const m of all.matchAll(/\b((?:[\w-]+\.)+(?:com|org|net|io|co|us|uk))\b/gi)) {
        expect(m[1], `domain ${m[1]}`).toMatch(/(^|\.)example\.(com|org|net)$/i);
      }
      for (const m of all.matchAll(/\(?\b\d{3}\)?[ .-]?(\d{3})[ .-]?(\d{4})\b/g)) {
        expect(`${m[1]}-${m[2]}`, `phone ${m[0]}`).toMatch(/^555-01\d\d$/);
      }
    });

    it("perfect-model replay through the fake provider and pipeline reproduces every golden value", async () => {
      const response = perfectOutput(f);
      const recording: Recording = { name: `golden-${name}`, task: "extract", input: f.text, responses: [response] };
      const ctx = {
        referenceDate: f.meta.reference_date,
        referenceDateSource: f.meta.reference_date_source,
        timezone: f.meta.timezone,
      };
      const run = await extract(
        { sourceText: f.text, sourceKind: f.meta.source_kind, ...ctx, user: { displayName: f.meta.user.display_name, aliases: f.meta.user.aliases } },
        { model: createRecordedModel({ recordings: [recording] }), logger: () => {} },
      );
      const out = processExtraction(run.output, { sourceText: f.text, ...ctx, logger: () => {} });
      expect(out.droppedItemIndexes).toEqual([]);
      expect(out.unverifiedQuoteCount).toBe(0);

      for (const e of f.expected.items) {
        const p = out.proposals.find((x) => x.evidence.some((ev) => overlaps(ev.quote, e.quote)));
        if (e.certainty === undefined) {
          expect(p, `ignore item should be absent: ${e.quote}`).toBeUndefined();
          continue;
        }
        expect(p, `no proposal for ${e.quote}`).toBeDefined();
        const got = { band: p!.band, due_date: p!.date.due_date, due_certainty: p!.date.due_certainty, owner: p!.item.owner };
        expect(got, e.quote).toEqual({ band: e.band, due_date: e.due_date, due_certainty: e.due_certainty, owner: e.owner });
        if (e.due_at) expect(p!.date.due_at, `due_at for ${e.quote}`).toBe(e.due_at);
        expect(p!.evidence[0]!.match_kind).toBe("exact");
        expect(p!.item.amount_text).toBe(e.amount_text ?? null);
        expect(p!.item.counterparty).toBe(e.counterparty ?? null);
      }

      const outDir = process.env.EVAL_RECORDINGS_OUT;
      if (outDir) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `golden-${name}.json`), JSON.stringify(recording, null, 2));
      }
    });
  });

  it("coverage summary (informational): ambiguous fixtures and band spread", () => {
    const all = names.map(load);
    const bands = all.flatMap((f) => f.expected.items.map((e) => e.band));
    const count = (b: string) => bands.filter((x) => x === b).length;
    // The 40-fixture target needs >= 12 ambiguous (PRD Testing Strategy); this set is 1-10.
    expect(all.filter((f) => f.meta.ambiguous).length).toBeGreaterThanOrEqual(1);
    expect(count("high") + count("medium") + count("low") + count("ignore")).toBe(bands.length);
    expect(all.some((f) => f.expected.items.length === 0)).toBe(true); // at least one no-item fixture
  });
});
