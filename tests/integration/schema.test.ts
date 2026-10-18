import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, migratedDb } from "./pglite";

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const SRC_A = "10000000-0000-0000-0000-00000000000a";
const EX_A = "11000000-0000-0000-0000-00000000000a";
const ITEM_A = "12000000-0000-0000-0000-00000000000a";
const THR_A = "20000000-0000-0000-0000-00000000000a";
const THR_B = "20000000-0000-0000-0000-00000000000b";

let db: PGlite;
const count = async (sql: string) => Number((await db.query<{ n: number }>(sql)).rows[0]!.n);

beforeAll(async () => {
  db = await migratedDb();
  await db.exec(`
    insert into auth.users values ('${A}', 'a@example.com', '{}'), ('${B}', 'b@example.com', '{}');
    insert into sources (id, user_id, kind, text_content, reference_date, reference_date_source)
      values ('${SRC_A}', '${A}', 'paste', 'I''ll send it Friday.', '2026-10-05', 'user');
    insert into extractions (id, user_id, source_id, status, model, prompt_version, schema_version)
      values ('${EX_A}', '${A}', '${SRC_A}', 'succeeded', 'fake:recorded', 'extract.v1', 'extraction.v1');
    insert into threads (id, user_id, title, kind, primary_source_id) values
      ('${THR_A}', '${A}', 'Send it', 'commitment', '${SRC_A}'),
      ('${THR_B}', '${B}', 'B thread', 'commitment', null);
    insert into extraction_items (id, user_id, extraction_id, payload, confidence, band, review_status, thread_id, item_index)
      values ('${ITEM_A}', '${A}', '${EX_A}', '{}', 0.95, 'high', 'accepted', '${THR_A}', 0);
    insert into evidence (user_id, source_id, thread_id, extraction_item_id, quote, start_offset, end_offset, match_kind)
      values ('${A}', '${SRC_A}', '${THR_A}', '${ITEM_A}', 'I''ll send it Friday', 0, 19, 'exact');
  `);
});

describe("schema (PGlite with Supabase stand-ins)", () => {
  it("sign-up creates profiles and user_settings rows", async () => {
    expect(await count(`select count(*)::int n from profiles`)).toBe(2);
    expect(await count(`select count(*)::int n from user_settings`)).toBe(2);
  });

  it("F13: deleting only the source keeps the thread and its quote excerpts", async () => {
    await db.exec(`delete from sources where id = '${SRC_A}'`);
    expect(await count(`select count(*)::int n from threads where id = '${THR_A}'`)).toBe(1);
    const ev = await db.query<{ quote: string; source_id: string | null; extraction_item_id: string | null; user_id: string }>(
      `select quote, source_id, extraction_item_id, user_id from evidence where thread_id = '${THR_A}'`,
    );
    expect(ev.rows).toEqual([{ quote: "I'll send it Friday", source_id: null, extraction_item_id: null, user_id: A }]);
    expect(await count(`select count(*)::int n from extraction_items`)).toBe(0);
  });

  it("forgetting a thread deletes its evidence and events", async () => {
    await db.exec(`insert into thread_events (user_id, thread_id, actor, type) values ('${A}', '${THR_A}', 'user', 'created')`);
    await db.exec(`delete from threads where id = '${THR_A}'`);
    expect(await count(`select count(*)::int n from evidence`)).toBe(0);
    expect(await count(`select count(*)::int n from thread_events`)).toBe(0);
  });

  it("a user cannot link their rows to another user's thread", async () => {
    await expect(
      asUser(db, A, () => db.exec(`insert into thread_events (user_id, thread_id, actor, type) values ('${A}', '${THR_B}', 'user', 'created')`)),
    ).rejects.toThrow(/foreign key/);
    await expect(
      asUser(db, A, () => db.exec(`insert into evidence (user_id, thread_id, quote, match_kind) values ('${A}', '${THR_B}', 'q', 'exact')`)),
    ).rejects.toThrow(/foreign key/);
  });

  it("profiles and user_settings cannot be deleted by the user; profile can be updated", async () => {
    expect((await asUser(db, A, () => db.query(`delete from profiles where id = '${A}'`))).affectedRows).toBe(0);
    expect((await asUser(db, A, () => db.query(`delete from user_settings`))).affectedRows).toBe(0);
    expect((await asUser(db, A, () => db.query(`update profiles set timezone = 'America/New_York' where id = '${A}'`))).affectedRows).toBe(1);
  });

  it("profiles.timezone must be a real IANA zone", async () => {
    await expect(db.exec(`update profiles set timezone = 'Mars/Olympus' where id = '${A}'`)).rejects.toThrow(/invalid timezone/);
  });

  it("rate limit: no direct writes; consume_usage caps at 30 and a timezone change does not reset it", async () => {
    await expect(asUser(db, A, () => db.exec(`insert into usage_counters (user_id, day) values ('${A}', '2026-10-18')`))).rejects.toThrow(
      /row-level security/,
    );
    const consume = async () => (await asUser(db, A, () => db.query<{ ok: boolean }>(`select public.consume_usage('extraction') as ok`))).rows[0]!.ok;
    let allowed = 0;
    for (let i = 0; i < 30; i++) if (await consume()) allowed++;
    expect(allowed).toBe(30);
    expect(await consume()).toBe(false);
    await asUser(db, A, () => db.exec(`update profiles set timezone = 'Pacific/Kiritimati' where id = '${A}'`));
    expect(await consume()).toBe(false);
    expect((await asUser(db, A, () => db.query(`update usage_counters set extractions = 0`))).affectedRows).toBe(0);
    await expect(asUser(db, A, () => db.query(`select public.consume_usage('bogus')`))).rejects.toThrow(/unknown usage kind/);
  });

  it("evidence must reference a source, thread or proposal", async () => {
    await expect(db.exec(`insert into evidence (user_id, quote, match_kind) values ('${A}', 'q', 'exact')`)).rejects.toThrow(/evidence_has_reference/);
  });

  it("extraction_items.item_index is required", async () => {
    const ex = "11000000-0000-0000-0000-0000000000b9";
    await db.exec(`insert into sources (id, user_id, kind, reference_date, reference_date_source) values ('10000000-0000-0000-0000-0000000000b9', '${B}', 'paste', '2026-10-05', 'user');
      insert into extractions (id, user_id, source_id, status, model, prompt_version, schema_version) values ('${ex}', '${B}', '10000000-0000-0000-0000-0000000000b9', 'succeeded', 'm', 'p', 's');`);
    await expect(db.exec(`insert into extraction_items (user_id, extraction_id, payload, confidence, band) values ('${B}', '${ex}', '{}', 0.5, 'medium')`)).rejects.toThrow(
      /item_index/,
    );
  });

  it("account deletion removes every row of the user", async () => {
    await db.exec(`delete from auth.users where id = '${B}'`);
    for (const t of ["profiles", "user_settings", "sources", "extractions", "threads", "extraction_items", "evidence", "thread_events", "decisions", "usage_counters", "suppressions"]) {
      const col = t === "profiles" ? "id" : "user_id";
      expect(await count(`select count(*)::int n from ${t} where ${col} = '${B}'`), t).toBe(0);
    }
  });
});
