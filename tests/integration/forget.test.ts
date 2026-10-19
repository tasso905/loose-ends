import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, migratedDb } from "./pglite";

/**
 * Forget permanently (F9, rule 8; user decision B, Oct 18): no title or quote text may remain
 * anywhere except the suppression hash. Runs the real migrations in PGlite.
 */
const A = "00000000-0000-0000-0000-00000000000a";
const SRC = "10000000-0000-0000-0000-0000000000f1";
const EX = "11000000-0000-0000-0000-0000000000f1";
const ITEM = "12000000-0000-0000-0000-0000000000f1";
const OTHER_ITEM = "12000000-0000-0000-0000-0000000000f2";
const THR = "20000000-0000-0000-0000-0000000000f1";

const TITLE = "Send zebrafish proposal to Quillon";
const QUOTE = "I'll send Quillon the zebrafish proposal Friday";
const HASH = "a".repeat(64);
const SOURCE_TEXT = `${QUOTE}. Also, the parrot memo is ready.`;

const TABLES = ["profiles", "user_settings", "sources", "extractions", "threads", "extraction_items", "evidence", "thread_events", "decisions", "usage_counters", "suppressions"];

let db: PGlite;

async function textEverywhere(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of TABLES) {
    const rows = await db.query<{ j: string }>(`select row_to_json(x)::text as j from public.${t} x`);
    out[t] = rows.rows.map((r) => r.j).join("\n");
  }
  return out;
}

const containsContent = (s: string) => /zebrafish|quillon/i.test(s);

beforeEach(async () => {
  db = await migratedDb();
  const raw = JSON.stringify({
    source_summary: "Note",
    participants: [],
    items: [
      { title: TITLE, evidence: [{ quote: QUOTE }] },
      { title: "Parrot memo", evidence: [{ quote: "the parrot memo is ready" }] },
    ],
    brief: null,
  }).replaceAll("'", "''");
  await db.exec(`
    insert into auth.users values ('${A}', 'a@example.com', '{}');
    insert into sources (id, user_id, kind, text_content, reference_date, reference_date_source)
      values ('${SRC}', '${A}', 'paste', '${SOURCE_TEXT.replaceAll("'", "''")}', '2026-10-05', 'user');
    insert into extractions (id, user_id, source_id, status, model, prompt_version, schema_version, raw_output)
      values ('${EX}', '${A}', '${SRC}', 'succeeded', 'fake:recorded', 'extract.v1', 'extraction.v1', '${raw}'::jsonb);
    insert into threads (id, user_id, title, kind, counterparty, primary_source_id)
      values ('${THR}', '${A}', '${TITLE}', 'commitment', 'Quillon', '${SRC}');
    insert into extraction_items (id, user_id, extraction_id, payload, confidence, band, review_status, thread_id, suppression_hash, item_index)
      values ('${ITEM}', '${A}', '${EX}', '${JSON.stringify({ title: TITLE, evidence: [{ quote: QUOTE }] }).replaceAll("'", "''")}'::jsonb,
              0.95, 'high', 'accepted', '${THR}', '${HASH}', 0),
             ('${OTHER_ITEM}', '${A}', '${EX}', '{"title":"Parrot memo"}'::jsonb, 0.6, 'medium', 'pending', null, '${"b".repeat(64)}', 1);
    insert into evidence (user_id, source_id, thread_id, extraction_item_id, quote, match_kind, quote_hash)
      values ('${A}', '${SRC}', '${THR}', '${ITEM}', '${QUOTE.replaceAll("'", "''")}', 'exact', '${"c".repeat(64)}');
    insert into thread_events (user_id, thread_id, actor, type, after)
      values ('${A}', '${THR}', 'user', 'created', '{"title": "${TITLE}"}');
    insert into decisions (user_id, thread_id, choice, reason_user) values ('${A}', '${THR}', 'Sent the zebrafish proposal', 'Quillon asked twice');
  `);
});

const forget = (deleteSource: boolean) =>
  asUser(db, A, () => db.query<{ r: Record<string, unknown> }>(`select public.forget_thread('${THR}', ${deleteSource}) as r`));

describe("forget_thread()", () => {
  it("with 'also delete source': no title or quote text remains anywhere; only the hash", async () => {
    expect(containsContent(Object.values(await textEverywhere()).join("\n"))).toBe(true);
    const res = await forget(true);
    expect(res.rows[0]!.r).toMatchObject({ threads: 1, extraction_items: 1, sources: 1 });

    const after = await textEverywhere();
    for (const [table, text] of Object.entries(after)) expect(containsContent(text), table).toBe(false);
    const sup = await db.query(`select suppression_hash, reason, thread_id from suppressions`);
    expect(sup.rows).toEqual([{ suppression_hash: HASH, reason: "forgotten", thread_id: null }]);
  });

  it("keeping the source: content remains only in the user's own source text", async () => {
    await forget(false);
    const after = await textEverywhere();
    for (const [table, text] of Object.entries(after)) {
      if (table === "sources") continue;
      expect(containsContent(text), table).toBe(false);
    }
    expect(containsContent(after.sources!)).toBe(true);
    // the other proposal from the same extraction is untouched, and its raw copy keeps its index
    expect((await db.query(`select id from extraction_items`)).rows).toEqual([{ id: OTHER_ITEM }]);
    const raw = await db.query<{ items: unknown[] }>(`select raw_output->'items' as items from extractions`);
    expect(raw.rows[0]!.items[0]).toBeNull();
    expect(raw.rows[0]!.items[1]).toMatchObject({ title: "Parrot memo" });
  });

  it("suppression survives without any extraction_items row", async () => {
    await forget(false);
    const n = await db.query<{ n: number }>(`select count(*)::int n from extraction_items where suppression_hash = '${HASH}'`);
    expect(n.rows[0]!.n).toBe(0);
    const s = await db.query<{ n: number }>(`select count(*)::int n from suppressions where suppression_hash = '${HASH}'`);
    expect(s.rows[0]!.n).toBe(1);
  });

  it("refuses another user's thread", async () => {
    const B = "00000000-0000-0000-0000-00000000000b";
    await db.exec(`insert into auth.users values ('${B}', 'b@example.com', '{}')`);
    await expect(asUser(db, B, () => db.query(`select public.forget_thread('${THR}', true)`))).rejects.toThrow(/thread not found/);
    expect((await db.query(`select id from threads`)).rows).toHaveLength(1);
  });
});

describe("forget_thread(): Explain card scrub (user decision, Oct 18)", () => {
  it("scrubs the stored brief (keeping unrelated lines) and drops the raw brief", async () => {
    const brief = {
      what_this_is: [{ text: "A note to Quillon", basis: "source", quote: "I’ll send  Quillon the zebrafish proposal Friday" }],
      what_to_do: [
        // Pre-release: a partial quote counts only from 12 characters and 3 words ("zebrafish proposal" no longer would).
        { text: "Send it", basis: "source", quote: "the zebrafish proposal" },
        { text: "Read the memo", basis: "source", quote: "the parrot memo is ready" },
      ],
      by_when: [],
      if_you_dont: [{ text: "Nothing stated", basis: "interpretation", quote: null }],
      worth_considering: [],
      not_sure_about: ["Which parrot memo"],
    };
    const json = JSON.stringify(brief).replaceAll("'", "''");
    await db.exec(`update extractions set brief = '${json}'::jsonb, raw_output = jsonb_set(raw_output, '{brief}', '${json}'::jsonb)`);

    await forget(false);

    const row = await db.query<{ brief: typeof brief; raw: { brief: typeof brief | null } }>(`select brief, raw_output as raw from extractions`);
    // Pre-release review: the model's raw brief (no offsets, never shown) is dropped entirely on Forget.
    expect(row.rows[0]!.raw.brief).toBeNull();
    for (const b of [row.rows[0]!.brief]) {
      expect(b.what_this_is).toEqual([]);
      expect(b.what_to_do).toEqual([{ text: "Read the memo", basis: "source", quote: "the parrot memo is ready" }]);
      expect(b.if_you_dont).toEqual([{ text: "Nothing stated", basis: "interpretation", quote: null }]);
      expect(b.not_sure_about).toEqual(["Which parrot memo"]);
      expect(b.by_when).toEqual([]);
    }
    const after = await textEverywhere();
    for (const [table, text] of Object.entries(after)) if (table !== "sources") expect(containsContent(text), table).toBe(false);
  });
});

describe("private.scrub_brief(): offsets win when a line carries them (pre-release)", () => {
  const line = (quote: string, start: number, end: number) => ({ text: "t", basis: "source", quote, match: { start_offset: start, end_offset: end } });
  const scrub = async (brief: unknown, quotes: string[], ranges: string) =>
    (await db.query<{ b: { what_to_do: Array<{ quote: string }> } }>(`select private.scrub_brief($1::jsonb, $2::text[], $3::int4range[]) as b`, [JSON.stringify(brief), quotes, ranges])).rows[0]!.b;

  it("removes a line whose source span overlaps forgotten evidence, even if its quote text differs", async () => {
    const b = await scrub({ what_to_do: [line("send it", 10, 40), line("the parrot memo is ready", 60, 84)] }, ["unrelated words here entirely"], "{\"[0,20)\"}");
    expect(b.what_to_do.map((l) => l.quote)).toEqual(["the parrot memo is ready"]);
  });

  it("keeps a line with offsets outside every forgotten span, even if its text matches", async () => {
    const b = await scrub({ what_to_do: [line("I'll send Quillon the zebrafish proposal Friday", 100, 147)] }, [QUOTE], "{\"[0,20)\"}");
    expect(b.what_to_do).toHaveLength(1);
  });

  it("falls back to the text rule when no ranges are given", async () => {
    const b = await scrub({ what_to_do: [line("I'll send Quillon the zebrafish proposal Friday", 100, 147)] }, [QUOTE], "{}");
    expect(b.what_to_do).toHaveLength(0);
  });
});
