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
  "thread_done",
  "thread_undo",
  "undo_reject_proposals",
].sort();

/** Read-only public functions `authenticated` may execute (invoker, RLS applies). */
const READERS = ["extraction_context"];

const TRUST_TABLES = ["extractions", "extraction_items", "evidence", "threads", "thread_events", "suppressions"];

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
  it("the functions authenticated can execute are exactly the 13 writers plus the read-only extraction_context", () => {
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

  it("extraction_context stays invoker (RLS) with search_path pinned", () => {
    const f = fns.find((x) => x.name === "extraction_context")!;
    expect(f.definer).toBe(false);
    expect(f.config).toEqual(['search_path=""']);
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

  it("decisions is still directly writable by authenticated (FLAGGED: Resolve not built; see the live RISK pin)", async () => {
    const { rows } = await db.query<{ ok: boolean }>(`select has_table_privilege('authenticated', 'public.decisions', 'UPDATE') as ok`);
    expect(rows[0]!.ok).toBe(true);
  });
});
