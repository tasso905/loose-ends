import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, migratedDb } from "./pglite";

/**
 * F13 source deletion and the Storage deletion queue (rule 8; migration 20261027122532), on the real
 * migrations in PGlite. Storage files are stood in by storage.objects rows; the live test
 * (tests/integration/delete-live.test.ts) removes real files through the Storage API.
 */
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const SRC = "10000000-0000-0000-0000-0000000000f1";
const EX = "11000000-0000-0000-0000-0000000000f1";
const ITEM = "12000000-0000-0000-0000-0000000000f1";
const OTHER_ITEM = "12000000-0000-0000-0000-0000000000f2";
const THR = "20000000-0000-0000-0000-0000000000f1";
const UNRELATED = "20000000-0000-0000-0000-0000000000f9";
const PATH = `${A}/30000000-0000-0000-0000-0000000000f1.pdf`;

const TITLE = "Send zebrafish proposal to Quillon";
const QUOTE = "I'll send Quillon the zebrafish proposal Friday";
const HASH = "a".repeat(64);
const SOURCE_TEXT = `${QUOTE}. Also, the parrot memo is ready.`;
const TABLES = ["profiles", "user_settings", "sources", "extractions", "threads", "extraction_items", "evidence", "thread_events", "decisions", "usage_counters", "suppressions"];
const q = (s: string) => s.replaceAll("'", "''");

let db: PGlite;

beforeEach(async () => {
  db = await migratedDb();
  await db.exec(`
    insert into auth.users values ('${A}', 'a@example.com', '{}'), ('${B}', 'b@example.com', '{}');
    insert into storage.objects (bucket_id, name) values ('sources', '${PATH}');
    insert into sources (id, user_id, kind, title, text_content, storage_path, reference_date, reference_date_source)
      values ('${SRC}', '${A}', 'upload', 'Zebrafish memo', '${q(SOURCE_TEXT)}', '${PATH}', '2026-10-05', 'user');
    insert into extractions (id, user_id, source_id, status, model, prompt_version, schema_version)
      values ('${EX}', '${A}', '${SRC}', 'succeeded', 'fake:recorded', 'extract.v1', 'extraction.v1');
    insert into threads (id, user_id, title, kind, counterparty, primary_source_id)
      values ('${THR}', '${A}', '${TITLE}', 'commitment', 'Quillon', '${SRC}'),
             ('${UNRELATED}', '${A}', 'Water the ferns', 'commitment', null, null);
    insert into extraction_items (id, user_id, extraction_id, payload, confidence, band, review_status, thread_id, suppression_hash, item_index)
      values ('${ITEM}', '${A}', '${EX}', '${q(JSON.stringify({ title: TITLE, evidence: [{ quote: QUOTE }] }))}'::jsonb,
              0.95, 'high', 'accepted', '${THR}', '${HASH}', 0),
             ('${OTHER_ITEM}', '${A}', '${EX}', '{"title":"Parrot memo"}'::jsonb, 0.6, 'medium', 'pending', null, '${"b".repeat(64)}', 1);
    insert into evidence (user_id, source_id, thread_id, extraction_item_id, quote, match_kind, quote_hash)
      values ('${A}', '${SRC}', '${THR}', '${ITEM}', '${q(QUOTE)}', 'exact', '${"c".repeat(64)}');
    insert into thread_events (user_id, thread_id, actor, type, after)
      values ('${A}', '${THR}', 'user', 'created', '{"title": "${TITLE}"}');
    insert into decisions (user_id, thread_id, choice, reason_user) values ('${A}', '${THR}', 'Sent the zebrafish proposal', 'Quillon asked twice');
  `);
});

const call = (uid: string, sql: string) => asUser(db, uid, () => db.query<{ r: unknown }>(`select ${sql} as r`));
const deleteSource = async (uid: string, everything: boolean | null, id = SRC) =>
  (await call(uid, `public.delete_source('${id}', ${everything === null ? "null" : everything})`)).rows[0]!.r as Record<string, unknown>;
const settle = async (uid: string) => (await call(uid, "public.storage_deletions_settle()")).rows[0]!.r as string[];
const count = async (sql: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`)).rows[0]!.n);
const queue = async () => (await db.query<{ user_id: string; bucket: string; path: string }>("select user_id, bucket, path from private.storage_deletions")).rows;

async function textEverywhere(): Promise<string> {
  const parts: string[] = [];
  for (const t of TABLES) parts.push(...(await db.query<{ j: string }>(`select row_to_json(x)::text as j from public.${t} x`)).rows.map((r) => r.j));
  return parts.join("\n");
}

describe("delete_source(p_everything = false): Delete source only", () => {
  it("deletes the source, its extractions and proposals; threads keep their quote with no source; queues the file", async () => {
    expect(await deleteSource(A, false)).toEqual({ ok: true, source_id: SRC, threads_forgotten: 0, file_queued: true });
    expect(await count(`sources where id = '${SRC}'`)).toBe(0);
    expect(await count(`extractions where source_id = '${SRC}'`)).toBe(0);
    expect(await count(`extraction_items where extraction_id = '${EX}'`)).toBe(0);
    // The thread, its quote (now sourceless), history and decision stay.
    expect(await count(`threads where id = '${THR}'`)).toBe(1);
    const ev = await db.query<{ quote: string; source_id: string | null }>(`select quote, source_id from evidence where thread_id = '${THR}'`);
    expect(ev.rows).toEqual([{ quote: QUOTE, source_id: null }]);
    expect(await count(`decisions where thread_id = '${THR}'`)).toBe(1);
    expect(await count(`threads where id = '${THR}' and primary_source_id is null`)).toBe(1);
    expect(await queue()).toEqual([{ user_id: A, bucket: "sources", path: PATH }]);
  });
});

describe("delete_source(p_everything = true): Delete source and everything from it", () => {
  it("forgets every thread from the source (only the suppression hash stays), deletes the source and queues the file", async () => {
    expect(await deleteSource(A, true)).toEqual({ ok: true, source_id: SRC, threads_forgotten: 1, file_queued: true });
    expect(await count(`threads where id = '${THR}'`)).toBe(0);
    expect(/zebrafish|quillon/i.test(await textEverywhere())).toBe(false);
    expect((await db.query("select suppression_hash, reason from suppressions")).rows).toEqual([{ suppression_hash: HASH, reason: "forgotten" }]);
    // A thread that did not come from this source is untouched.
    expect(await count(`threads where id = '${UNRELATED}'`)).toBe(1);
    expect(await queue()).toEqual([{ user_id: A, bucket: "sources", path: PATH }]);
  });

  it("also finds threads linked only through evidence or an accepted proposal", async () => {
    await db.exec(`update threads set primary_source_id = null where id = '${THR}'`);
    expect(await deleteSource(A, true)).toMatchObject({ ok: true, threads_forgotten: 1 });
    expect(await count(`threads where id = '${THR}'`)).toBe(0);
  });
});

describe("delete_source(): ownership and input", () => {
  it("another user's source reads as not found, and nothing changes", async () => {
    const before = await textEverywhere();
    expect(await deleteSource(B, true)).toEqual({ ok: false, error: "not_found" });
    expect(await textEverywhere()).toBe(before);
    expect(await queue()).toEqual([]);
  });

  it("a missing source is not found; a null option and an anonymous caller are refused", async () => {
    expect(await deleteSource(A, false, "10000000-0000-0000-0000-0000000000ff")).toEqual({ ok: false, error: "not_found" });
    await expect(deleteSource(A, null)).rejects.toMatchObject({ code: "22023" });
    // No JWT subject (asUser leaves the last one set for the session).
    await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
    await expect(db.query(`select public.delete_source('${SRC}', false)`)).rejects.toThrow(/not authenticated/);
    expect(await count(`sources where id = '${SRC}'`)).toBe(1);
  });
});

describe("the Storage deletion queue", () => {
  it("settle returns the caller's queued paths while the file exists, and clears them once it is gone", async () => {
    await deleteSource(A, false);
    expect(await settle(B)).toEqual([]);
    expect(await settle(A)).toEqual([PATH]);
    await db.exec(`delete from storage.objects where name = '${PATH}'`);
    expect(await settle(A)).toEqual([]);
    expect(await queue()).toEqual([]);
  });

  it("every way a source row goes queues its file: a direct DELETE (RLS) and Forget with 'also delete source'", async () => {
    await asUser(db, A, () => db.exec(`delete from public.sources where id = '${SRC}'`));
    expect(await queue()).toEqual([{ user_id: A, bucket: "sources", path: PATH }]);
    await db.exec(`delete from private.storage_deletions`);

    const S2 = "10000000-0000-0000-0000-0000000000f2";
    const T2 = "20000000-0000-0000-0000-0000000000f2";
    const P2 = `${A}/30000000-0000-0000-0000-0000000000f2.txt`;
    await db.exec(`
      insert into sources (id, user_id, kind, text_content, storage_path, reference_date, reference_date_source)
        values ('${S2}', '${A}', 'upload', 'Feed the cat', '${P2}', '2026-10-05', 'user');
      insert into threads (id, user_id, title, kind, primary_source_id) values ('${T2}', '${A}', 'Feed the cat', 'commitment', '${S2}');
    `);
    await call(A, `public.forget_thread('${T2}', true)`);
    expect(await queue()).toEqual([{ user_id: A, bucket: "sources", path: P2 }]);
  });

  it("a paste (no file) queues nothing", async () => {
    await db.exec(`update sources set storage_path = null where id = '${SRC}'`);
    expect(await deleteSource(A, false)).toMatchObject({ ok: true, file_queued: false });
    expect(await queue()).toEqual([]);
  });

  it("account deletion queues nothing and leaves no queue rows (deleteAccount sweeps the folder)", async () => {
    await deleteSource(A, false);
    expect(await queue()).toHaveLength(1);
    const S2 = "10000000-0000-0000-0000-0000000000f2";
    await db.exec(`insert into sources (id, user_id, kind, text_content, storage_path, reference_date, reference_date_source)
      values ('${S2}', '${A}', 'upload', 'x', '${A}/other.txt', '2026-10-05', 'user')`);
    await db.exec(`delete from auth.users where id = '${A}'`);
    expect(await count(`sources where user_id = '${A}'`)).toBe(0);
    expect(await queue()).toEqual([]);
  });

  it("the export (F13) covers every public table: a new table must be added to EXPORT_TABLES", async () => {
    const { EXPORT_TABLES } = await import("@/lib/account/export");
    const tables = (await db.query<{ t: string }>("select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1")).rows.map((r) => r.t);
    expect(EXPORT_TABLES.map((e) => e.table).sort()).toEqual(tables);
  });

  it("clients cannot read or write the queue, or call the helper", async () => {
    await expect(asUser(db, A, () => db.query("select * from private.storage_deletions"))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, A, () => db.exec(`insert into private.storage_deletions (user_id, path) values ('${A}', 'x')`))).rejects.toThrow(/permission denied/);
    await expect(call(A, `(select count(*) from private.source_thread_ids('${SRC}', '${A}'))`)).rejects.toThrow(/permission denied/);
  });
});

describe("storage_deletions_sweep (cron/daily, S11-D3)", () => {
  const sweep = async () => (await db.query<{ r: string[] }>("select public.storage_deletions_sweep() as r")).rows[0]!.r;

  it("returns a stranded file across users, keeps it while the file exists, clears it once gone", async () => {
    await deleteSource(A, false);
    expect(await sweep()).toEqual([PATH]);
    expect(await sweep()).toEqual([PATH]);
    expect(await queue()).toHaveLength(1);
    await db.exec(`delete from storage.objects where name = '${PATH}'`);
    expect(await sweep()).toEqual([]);
    expect(await queue()).toEqual([]);
  });

  it("drops an entry whose path a live source owns again, so its file is never returned for removal", async () => {
    await deleteSource(A, false);
    await db.exec(`insert into sources (user_id, kind, title, text_content, storage_path, reference_date, reference_date_source)
      values ('${A}', 'upload', 'Same path', 'Synthetic', '${PATH}', '2026-10-05', 'user')`);
    expect(await sweep()).toEqual([]);
    expect(await queue()).toEqual([]);
  });

  it("is limited and validates the limit", async () => {
    await expect(db.query("select public.storage_deletions_sweep(0)")).rejects.toThrow(/invalid limit/);
    await expect(db.query("select public.storage_deletions_sweep(5001)")).rejects.toThrow(/invalid limit/);
  });

  it("only the service role may run it", async () => {
    await expect(call(A, "public.storage_deletions_sweep()")).rejects.toThrow(/permission denied/);
    const can = await db.query<{ svc: boolean; anon: boolean; auth: boolean; schema: boolean }>(`select
      has_function_privilege('service_role', 'public.storage_deletions_sweep(integer)', 'execute') as svc,
      has_function_privilege('anon', 'public.storage_deletions_sweep(integer)', 'execute') as anon,
      has_function_privilege('authenticated', 'public.storage_deletions_sweep(integer)', 'execute') as auth,
      has_schema_privilege('service_role', 'private', 'usage') as schema`);
    expect(can.rows[0]).toEqual({ svc: true, anon: false, auth: false, schema: false });
  });
});

describe("the fingerprint survives Delete source only (S11-D5)", () => {
  const hashes = async () => (await db.query<{ suppression_hash: string; reason: string; thread_id: string | null }>("select suppression_hash, reason, thread_id from suppressions order by 1")).rows;

  it("Delete source only, then Forget: the thread's hash becomes a suppression, and nothing else stays", async () => {
    await deleteSource(A, false);
    expect(await hashes()).toEqual([]); // the thread is still open: nothing suppressed yet
    await call(A, `public.forget_thread('${THR}', false)`);
    expect(await hashes()).toEqual([{ suppression_hash: HASH, reason: "forgotten", thread_id: null }]);
    expect(await count("private.thread_suppression_hashes")).toBe(0);
    expect(await textEverywhere()).not.toContain("zebrafish");
  });

  it("Forget in the usual order is unchanged: one suppression, no held hash left", async () => {
    await call(A, `public.forget_thread('${THR}', false)`);
    expect(await hashes()).toEqual([{ suppression_hash: HASH, reason: "forgotten", thread_id: null }]);
    expect(await count("private.thread_suppression_hashes")).toBe(0);
  });

  it("a pending proposal's hash (no thread) is not held", async () => {
    await deleteSource(A, false);
    const held = await db.query<{ suppression_hash: string }>("select suppression_hash from private.thread_suppression_hashes");
    expect(held.rows).toEqual([{ suppression_hash: HASH }]);
  });

  it("account deletion takes the held hash with it and writes no suppression", async () => {
    await deleteSource(A, false);
    await db.exec(`delete from auth.users where id = '${A}'`);
    expect(await count("private.thread_suppression_hashes")).toBe(0);
    expect(await hashes()).toEqual([]);
  });

  it("the held hashes are out of the user's reach", async () => {
    await deleteSource(A, false);
    await expect(asUser(db, A, () => db.query("select * from private.thread_suppression_hashes"))).rejects.toThrow(/permission denied/);
  });
});
