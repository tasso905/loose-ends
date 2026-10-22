import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, migratedDb } from "./pglite";

/**
 * One write model (migration 20261021115926): users read their own rows through RLS, and every
 * write to the trust tables goes through a SECURITY DEFINER function that checks auth.uid(). The
 * only direct write left is DELETE on one's own source (F13). Runs the real migrations in PGlite.
 */
const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b1";
const SRC = "10000000-0000-0000-0000-0000000000a1";
const THR = "20000000-0000-0000-0000-0000000000a1";
const TEXT = "I'll send the synthetic gannet report Friday. Also the heron memo.";

const NO_DIRECT_WRITES = ["extractions", "extraction_items", "evidence", "threads", "thread_events", "suppressions"];

/** Every public function that writes a trust table (S0, S2, S3, S4). */
const WRITERS = [
  "forget_thread",
  "start_source_extraction",
  "retry_extraction",
  "set_extraction_stage",
  "complete_extraction",
  "fail_extraction",
  "get_extraction",
  "accept_proposals",
  "reject_proposals",
  "undo_reject_proposals",
  "thread_done",
  "thread_undo",
];

let db: PGlite;
const priv = async (table: string, p: string) =>
  (await db.query<{ ok: boolean }>(`select has_table_privilege('authenticated', 'public.${table}', '${p}') as ok`)).rows[0]!.ok;

beforeAll(async () => {
  db = await migratedDb();
  await db.exec(`
    insert into auth.users values ('${A}', 'a@example.com', '{}'), ('${B}', 'b@example.com', '{}');
    insert into sources (id, user_id, kind, text_content, reference_date, reference_date_source)
      values ('${SRC}', '${A}', 'paste', '${TEXT.replaceAll("'", "''")}', '2026-10-05', 'user');
    insert into threads (id, user_id, title, kind, primary_source_id) values ('${THR}', '${A}', 'Send the gannet report', 'commitment', '${SRC}');
    insert into evidence (user_id, source_id, thread_id, quote, match_kind) values ('${A}', '${SRC}', '${THR}', 'send the synthetic gannet report Friday', 'exact');
    insert into evidence (user_id, source_id, quote, match_kind) values ('${A}', '${SRC}', 'Also the heron memo', 'exact');
    insert into thread_events (user_id, thread_id, actor, type) values ('${A}', '${THR}', 'user', 'created');
  `);
});

describe("write model: definer functions only", () => {
  it.each(NO_DIRECT_WRITES)("authenticated has SELECT but no INSERT, UPDATE, DELETE or TRUNCATE on %s", async (t) => {
    expect(await priv(t, "SELECT")).toBe(true);
    for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) expect(await priv(t, p), `${t} ${p}`).toBe(false);
  });

  it("sources: SELECT and DELETE (F13) only", async () => {
    expect(await priv("sources", "SELECT")).toBe(true);
    expect(await priv("sources", "DELETE")).toBe(true);
    for (const p of ["INSERT", "UPDATE", "TRUNCATE"]) expect(await priv("sources", p), p).toBe(false);
  });

  it.each(WRITERS)("%s is SECURITY DEFINER with search_path pinned, executable by authenticated and not anon", async (fn) => {
    const { rows } = await db.query<{ definer: boolean; config: string[] | null; auth: boolean; anon: boolean }>(
      `select p.prosecdef as definer, p.proconfig as config,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon
       from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace`,
      [fn],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ definer: true, auth: true, anon: false });
    expect(rows[0]!.config).toContain('search_path=""');
  });

  it("private helpers used only by definer functions are not executable by authenticated", async () => {
    for (const sig of ["private.lock_own_items(uuid, uuid[])", "private.proposal_thread_fields(jsonb, uuid, numeric)"]) {
      const { rows } = await db.query<{ ok: boolean }>(`select has_function_privilege('authenticated', '${sig}', 'EXECUTE') as ok`);
      expect(rows[0]!.ok, sig).toBe(false);
    }
  });

  it("forget_thread (now definer) refuses another user's thread and writes nothing", async () => {
    await expect(asUser(db, B, () => db.query(`select public.forget_thread('${THR}', true)`))).rejects.toThrow(/thread not found/);
    const n = await db.query<{ n: number }>(`select (select count(*) from threads) + (select count(*) from thread_events) + (select count(*) from suppressions) as n`);
    expect(Number(n.rows[0]!.n)).toBe(2);
  });

  it("F13: the owner can still delete their source; source-only evidence goes, the thread's quote stays", async () => {
    // B cannot (RLS: zero rows).
    expect((await asUser(db, B, () => db.query(`delete from sources where id = '${SRC}'`))).affectedRows).toBe(0);
    expect((await asUser(db, A, () => db.query(`delete from sources where id = '${SRC}'`))).affectedRows).toBe(1);
    const ev = await db.query<{ quote: string; source_id: string | null }>(`select quote, source_id from evidence`);
    expect(ev.rows).toEqual([{ quote: "send the synthetic gannet report Friday", source_id: null }]);
  });

  it("forget_thread as the owner still deletes the thread, its evidence and its events", async () => {
    const r = await asUser(db, A, () => db.query<{ r: { threads: number } }>(`select public.forget_thread('${THR}', false) as r`));
    expect(r.rows[0]!.r.threads).toBe(1);
    for (const t of ["threads", "evidence", "thread_events"]) {
      expect((await db.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n, t).toBe(0);
    }
  });
});
