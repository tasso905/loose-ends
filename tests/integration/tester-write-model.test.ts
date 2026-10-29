import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { migratedDb } from "./pglite";

/**
 * Lead-tester catalog audit of the one write model (migration 20261021115926), over the real
 * migrations in PGlite. Unlike a hand-kept list, it enumerates EVERY function in schema public, so
 * a new writer that is invoker, unpinned, anon-executable or missing its auth.uid() check fails here.
 * The live grant/refusal side is tests/integration/tester-core-loop-live.test.ts.
 */

/** Public functions `authenticated` may execute that write a trust table. */
const WRITERS = [
  "accept_proposals",
  "complete_extraction",
  "consume_usage",
  "fail_extraction",
  "forget_thread",
  "get_extraction", // writes: the 90 s rule marks the caller's attempt failed
  "reject_proposals",
  "retry_extraction",
  "set_extraction_stage",
  "start_source_extraction",
  "start_upload_extraction", // S6: writes sources + extractions; checks the caller's own storage folder
  "thread_done",
  "thread_resolve", // S8 (F11): writes threads, thread_events and decisions
  "thread_undo",
  "undo_reject_proposals",
].sort();

/** Read-only public functions `authenticated` may execute (invoker, RLS applies). */
const READERS = ["extraction_context", "search_decisions"]; // S9 (F12): invoker, read-only

const TRUST_TABLES = ["extractions", "extraction_items", "evidence", "threads", "thread_events", "suppressions", "decisions"];

let db: PGlite;
type Fn = { name: string; definer: boolean; config: string[] | null; auth: boolean; anon: boolean; pub: boolean; src: string };
let fns: Fn[];

beforeAll(async () => {
  db = await migratedDb();
  fns = (
    await db.query<Fn>(
      `select p.proname as name, p.prosecdef as definer, p.proconfig as config,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub,
              p.prosrc as src
       from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
    )
  ).rows;
});

describe("tester: write-model catalog audit", () => {
  it("the functions authenticated can execute are exactly the writers plus the read-only readers (extraction_context, search_decisions)", () => {
    expect(fns.filter((f) => f.auth).map((f) => f.name).sort()).toEqual([...WRITERS, ...READERS].sort());
  });

  it("no public function is executable by anon or PUBLIC", () => {
    expect(fns.filter((f) => f.anon || f.pub).map((f) => f.name)).toEqual([]);
  });

  it.each(WRITERS)("%s: SECURITY DEFINER, search_path pinned to '', and checks auth.uid() in its body", (name) => {
    const f = fns.find((x) => x.name === name);
    expect(f, name).toBeDefined();
    expect(f!.definer).toBe(true);
    expect(f!.config).toEqual(['search_path=""']);
    expect(f!.src).toMatch(/auth\.uid\(\)/);
  });

  it.each(READERS)("%s stays invoker (RLS), read-only, with search_path pinned", (name) => {
    const f = fns.find((x) => x.name === name)!;
    expect(f, name).toBeDefined();
    expect(f.definer).toBe(false);
    expect(f.config).toEqual(['search_path=""']);
    expect(f.src).not.toMatch(/\b(insert|update|delete)\b/i);
  });

  it("search_decisions filters on auth.uid() as well as RLS, and caps the question at 300 characters", () => {
    const f = fns.find((x) => x.name === "search_decisions")!;
    expect(f.src).toMatch(/d\.user_id = auth\.uid\(\)/);
    expect(f.src).toMatch(/left\(coalesce\(p_question, ''\), 300\)/);
  });

  it("every SECURITY DEFINER function in public and private pins search_path", async () => {
    const { rows } = await db.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prosecdef
         and not coalesce(p.proconfig, '{}') @> array['search_path=""']`,
    );
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it.each(TRUST_TABLES)("%s: authenticated and anon have SELECT at most", async (t) => {
    for (const role of ["authenticated", "anon"]) {
      for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const { rows } = await db.query<{ ok: boolean }>(`select has_table_privilege($1, $2, $3) as ok`, [role, `public.${t}`, p]);
        expect(rows[0]!.ok, `${role} ${t} ${p}`).toBe(false);
      }
    }
  });

  // REGRESSION GUARD (S8, migration 20261022130327): decisions joined the write model. It used to be
  // FOR ALL (the owner could insert, rewrite or delete a decision). Now: one SELECT-only own-row
  // policy, and the only writer is thread_resolve (plus thread_undo's delete through its private body).
  it("decisions: one SELECT-only own-row policy; thread_resolve is the only public function that inserts it", async () => {
    const { rows } = await db.query<{ polname: string; cmd: string; roles: string[]; qual: string }>(
      `select polname, polcmd::text as cmd, array(select rolname from pg_roles r where r.oid = any(polroles))::text[] as roles,
              pg_get_expr(polqual, polrelid) as qual
       from pg_policy where polrelid = 'public.decisions'::regclass`,
    );
    expect(rows.map((r) => [r.polname, r.cmd, r.roles])).toEqual([["decisions_select_own", "r", ["authenticated"]]]);
    expect(rows[0]!.qual).toMatch(/user_id = \( SELECT auth\.uid\(\)/);
    const inserters = fns.filter((f) => f.auth && /insert\s+into\s+public\.decisions/i.test(f.src)).map((f) => f.name);
    expect(inserters).toEqual(["thread_resolve"]);
  });
});
