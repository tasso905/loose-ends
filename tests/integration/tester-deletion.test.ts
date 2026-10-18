/**
 * Lead-tester deletion checks (rule 8), rounds 5-8. Runs the real supabase/migrations in PGlite via
 * ./pglite. Tests marked `it.fails` document an OPEN DEFECT: they assert the required behaviour and
 * currently fail. Flip to `it` once fixed and relabel the comment REGRESSION GUARD.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, migratedDb } from "./pglite";

const U = "00000000-0000-0000-0000-0000000000a1";
const SECRET = /zebrafish|quillon/i;
const TABLES = ["sources", "extractions", "threads", "extraction_items", "evidence", "thread_events", "decisions", "suppressions"];

let db: PGlite;

async function tablesWithContent(): Promise<string[]> {
  const hit: string[] = [];
  for (const t of TABLES) {
    const rows = await db.query<{ j: string }>(`select row_to_json(x)::text as j from public.${t} x`);
    if (rows.rows.some((r) => SECRET.test(r.j))) hit.push(t);
  }
  return hit;
}

interface Graph {
  source: string;
  extraction: string;
  thread: string;
  item: string;
}

async function seed(opts: { itemIndex?: number | null; proposalEvidence?: boolean; brief?: boolean } = {}): Promise<Graph> {
  const q = <T,>(sql: string, params: unknown[]) => db.query<T>(sql, params);
  const source = (
    await q<{ id: string }>(
      `insert into public.sources (user_id, kind, text_content, reference_date, reference_date_source) values ($1,'paste',$2,'2026-10-05','user') returning id`,
      [U, "I'll send Quillon the zebrafish proposal Friday."],
    )
  ).rows[0]!.id;
  const raw = { items: [{ title: "Send zebrafish proposal to Quillon", evidence: [{ quote: "I'll send Quillon the zebrafish proposal Friday" }] }] };
  const brief = opts.brief ? { what_to_do: [{ text: "Send the zebrafish proposal", basis: "source", quote: "send Quillon the zebrafish proposal" }] } : null;
  const extraction = (
    await q<{ id: string }>(
      `insert into public.extractions (user_id, source_id, status, model, prompt_version, schema_version, raw_output, brief)
       values ($1,$2,'succeeded','fake:recorded','extract.v1','extraction.v1',$3,$4) returning id`,
      [U, source, JSON.stringify(raw), brief === null ? null : JSON.stringify(brief)],
    )
  ).rows[0]!.id;
  const thread = (
    await q<{ id: string }>(
      `insert into public.threads (user_id, title, kind, primary_source_id) values ($1,'Send zebrafish proposal to Quillon','commitment',$2) returning id`,
      [U, source],
    )
  ).rows[0]!.id;
  const item = (
    await q<{ id: string }>(
      `insert into public.extraction_items (user_id, extraction_id, payload, confidence, band, review_status, thread_id, suppression_hash, item_index)
       values ($1,$2,$3,0.95,'high','accepted',$4,'h1',$5) returning id`,
      [U, extraction, JSON.stringify(raw.items[0]), thread, opts.itemIndex === undefined ? 0 : opts.itemIndex],
    )
  ).rows[0]!.id;
  await q(`insert into public.evidence (user_id, source_id, thread_id, extraction_item_id, quote, match_kind) values ($1,$2,$3,$4,$5,'exact')`, [
    U,
    source,
    thread,
    item,
    "I'll send Quillon the zebrafish proposal Friday",
  ]);
  if (opts.proposalEvidence) {
    // Evidence recorded for the proposal (before accept), not re-pointed at the thread.
    await q(`insert into public.evidence (user_id, source_id, thread_id, extraction_item_id, quote, match_kind) values ($1,$2,null,$3,$4,'exact')`, [
      U,
      source,
      item,
      "send Quillon the zebrafish proposal",
    ]);
  }
  return { source, extraction, thread, item };
}

const forget = (thread: string, deleteSource: boolean) => asUser(db, U, () => db.query(`select public.forget_thread($1, $2)`, [thread, deleteSource]));

beforeEach(async () => {
  db = await migratedDb();
  await db.exec(`insert into auth.users values ('${U}', 'u@example.com', '{}')`);
});

describe("rule 8: deletion leaves no quote text behind", () => {
  it("forget + delete source on a plain graph leaves nothing", async () => {
    const g = await seed();
    await forget(g.thread, true);
    expect(await tablesWithContent()).toEqual([]);
  });

  // REGRESSION GUARD (high, rule 8, fixed round 6): evidence.extraction_item_id is ON DELETE SET NULL (round-3 N1 fix), so
  // evidence that belonged to a proposal but not to a thread became an orphan when the source was deleted.
  // Now a BEFORE DELETE trigger on extraction_items removes it, and a check constraint forbids orphans.
  // (Round 6, lead-developer: the insert below now sets item_index, which is NOT NULL since round 6.)
  it("deleting the source of a pending proposal removes that proposal's evidence", async () => {
    const source = (
      await db.query<{ id: string }>(
        `insert into public.sources (user_id, kind, text_content, reference_date, reference_date_source) values ($1,'paste','zebrafish memo','2026-10-05','user') returning id`,
        [U],
      )
    ).rows[0]!.id;
    const ex = (
      await db.query<{ id: string }>(
        `insert into public.extractions (user_id, source_id, status, model, prompt_version, schema_version) values ($1,$2,'succeeded','m','p','s') returning id`,
        [U, source],
      )
    ).rows[0]!.id;
    const item = (
      await db.query<{ id: string }>(`insert into public.extraction_items (user_id, extraction_id, payload, confidence, band, item_index) values ($1,$2,'{}',0.6,'medium',0) returning id`, [U, ex])
    ).rows[0]!.id;
    await db.query(`insert into public.evidence (user_id, source_id, extraction_item_id, quote, match_kind) values ($1,$2,$3,'zebrafish memo','exact')`, [U, source, item]);
    await asUser(db, U, () => db.query(`delete from public.sources where id = $1`, [source]));
    expect(await tablesWithContent()).toEqual([]);
  });

  // REGRESSION GUARD (high, rule 8, fixed round 6): forget_thread deleted evidence by thread_id only, then deletes the
  // extraction_items, which nulls extraction_item_id on proposal-level evidence. The quote survives as an
  // orphan, with or without "also delete source".
  it.each([[true], [false]])("forget (delete source = %s) removes proposal-level evidence too", async (deleteSource) => {
    const g = await seed({ proposalEvidence: true });
    await forget(g.thread, deleteSource);
    const left = await db.query<{ n: number }>(`select count(*)::int n from public.evidence where quote ilike '%zebrafish%'`);
    expect(left.rows[0]!.n).toBe(0);
  });

  // REGRESSION GUARD (medium, D29, fixed round 6; changed round 7 by lead-developer): item_index is NOT NULL,
  // and when the raw copy cannot be blanked item-by-item (malformed raw_output, out-of-range index) forget_thread
  // discards the whole raw_output and still completes, so the user can always forget.
  it("item_index is required, and forget discards a raw copy it cannot blank", async () => {
    await expect(seed({ itemIndex: null })).rejects.toThrow(/item_index/);
    const g = await seed({ itemIndex: 5 });
    await forget(g.thread, false);
    const raw = await db.query<{ raw: unknown }>(`select raw_output as raw from public.extractions where id = $1`, [g.extraction]);
    expect(raw.rows[0]!.raw).toBeNull();
    const left = await db.query<{ n: number }>(`select count(*)::int n from public.threads where id = $1`, [g.thread]);
    expect(left.rows[0]!.n).toBe(0);
  });

  it.each([['"just a string"'], ['{"source_summary":"x"}'], ['{"items":[]}'], ['[1,2]']])(
    "malformed raw_output %s is discarded and forget completes (round 7, lead-developer)",
    async (rawJson) => {
      const g = await seed();
      await db.query(`update public.extractions set raw_output = $1::jsonb where id = $2`, [rawJson, g.extraction]);
      await forget(g.thread, false);
      const raw = await db.query<{ raw: unknown }>(`select raw_output as raw from public.extractions where id = $1`, [g.extraction]);
      expect(raw.rows[0]!.raw).toBeNull();
      expect((await db.query(`select id from public.threads where id = $1`, [g.thread])).rows).toHaveLength(0);
    },
  );

  // REGRESSION GUARD (round 6 R6-1, F13, fixed round 7): evidence that references only its source is deleted
  // with the source (BEFORE DELETE trigger on sources), so evidence_has_reference no longer aborts the delete.
  it("a source whose evidence references only the source can still be deleted", async () => {
    const source = (
      await db.query<{ id: string }>(
        `insert into public.sources (user_id, kind, text_content, reference_date, reference_date_source) values ($1,'paste','zebrafish note','2026-10-05','user') returning id`,
        [U],
      )
    ).rows[0]!.id;
    await db.query(`insert into public.evidence (user_id, source_id, quote, match_kind) values ($1,$2,'zebrafish note','exact')`, [U, source]);
    await asUser(db, U, () => db.query(`delete from public.sources where id = $1`, [source]));
    expect(await tablesWithContent()).toEqual([]);
  });

  // REGRESSION GUARD (medium, D29 scope, fixed round 8 per user decision Oct 18): with the source kept,
  // extractions.brief (the Explain card) used to keep quoting the forgotten item. forget_thread now drops
  // every brief line whose quote or text overlaps a forgotten quote, in extractions.brief and raw_output.brief.
  it("forget keeping the source leaves content only in sources", async () => {
    const g = await seed({ brief: true });
    await forget(g.thread, false);
    expect((await tablesWithContent()).filter((t) => t !== "sources")).toEqual([]);
  });
});

/* Round 8: scrub_brief (D35) precision. scrub_brief is pure, so these call it directly. */
describe("D35 scrub_brief: removes only lines that quote the forgotten item", () => {
  const brief = {
    what_this_is: [{ text: "A renewal notice from Provider A", basis: "interpretation", quote: null }],
    what_to_do: [
      { text: "Pay", basis: "source", quote: "Pay the $1,470 premium" },
      { text: "Renew", basis: "source", quote: "renew by Oct 31" },
    ],
    by_when: [{ text: "Oct 31", basis: "source", quote: "renew by Oct 31" }],
    if_you_dont: [{ text: "Policy lapses", basis: "source", quote: "the policy lapses on Nov 1" }],
    worth_considering: [],
    not_sure_about: ["Is Oct 31 the deadline?"],
  };
  const kept = async (quotes: string[]) => {
    const r = await db.query<{ b: Record<string, Array<{ text?: string } | string>> }>(`select public.scrub_brief($1::jsonb, $2::text[]) as b`, [
      JSON.stringify(brief),
      quotes,
    ]);
    // jsonb reorders object keys, so compare as sorted lists
    return Object.values(r.rows[0]!.b).flat().map((l) => (typeof l === "string" ? l : l.text)).sort();
  };
  const ALL = ["A renewal notice from Provider A", "Pay", "Renew", "Oct 31", "Policy lapses", "Is Oct 31 the deadline?"].sort();

  it("a quote that matches a line's quote removes that line and keeps the rest", async () => {
    expect(await kept(["Pay the $1,470 premium"])).toEqual(ALL.filter((t) => t !== "Pay"));
  });

  it("empty and whitespace quotes remove nothing", async () => {
    expect(await kept([""])).toEqual(ALL);
    expect(await kept(["   "])).toEqual(ALL);
  });

  // OPEN DEFECT (medium, D35 over-removal): overlap is plain containment in either direction, on both the
  // line's quote and its text. A short forgotten quote (Zod allows 3 characters) is "contained" in many
  // unrelated lines, so it wipes most of the Explain card.
  it.fails.each([["the"], ["Oct"], ["a"]])("a very short forgotten quote %j does not remove unrelated lines", async (q) => {
    expect(await kept([q])).toEqual(ALL);
  });

  // OPEN DEFECT (medium, D35 over-removal): a short line text ("Renew", "Pay") is contained in an unrelated
  // forgotten quote, so the line is removed although its own quote has nothing to do with the forgotten item.
  it.fails("an unrelated quote that happens to contain a short line text does not remove that line", async () => {
    expect(await kept(["Please renew your gym membership and pay the trainer"])).toEqual(ALL);
  });
});
