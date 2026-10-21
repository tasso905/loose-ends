import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

/**
 * Applies supabase/migrations to an in-process Postgres (PGlite) with minimal stand-ins for
 * Supabase's auth and storage schemas. A fast schema check only: it is not the RLS isolation test
 * against real local Supabase, which the lead-tester owns.
 */
export async function migratedDb(opts: { clockGuard?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`
    create schema auth; create schema storage; create schema extensions;
    create role authenticated; create role anon;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
    grant usage on schema auth, storage, public, extensions to authenticated;
    grant execute on function auth.uid() to authenticated;
    -- Supabase grants table privileges to authenticated by default (RLS does the restricting).
    -- Default privileges, as there, so a migration's later revoke still applies.
    alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
  `);
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  await db.exec(`grant select, insert, delete on storage.objects to authenticated;`);
  // Migration 20261021131140 refuses a p_now more than 5 s from the database clock. These tests
  // pass fixed synthetic instants (deterministic), so the tolerance is widened here as the owner,
  // the only role that can write private.clock_guard. `clockGuard: true` keeps the real setting.
  if (!opts.clockGuard) await db.exec(`update private.clock_guard set max_skew = interval '1000 years';`);
  return db;
}

export async function asUser<T>(db: PGlite, uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

/**
 * The extraction service's database port (`RpcDb`) over PGlite: calls `public.<fn>` with named
 * arguments as user `uid`, so integration tests run the real SQL functions and RLS stand-ins.
 * jsonb arguments are serialized; errors come back as `{ data: null, error: { code, message } }`.
 */
export function rpcAs(db: PGlite, uid: string) {
  const types = new Map<string, Map<string, string>>();
  async function argTypes(fn: string): Promise<Map<string, string>> {
    const known = types.get(fn);
    if (known) return known;
    const res = await db.query<{ n: string; t: string }>(
      `select unnest(p.proargnames) as n, unnest(p.proargtypes::regtype[]::text[]) as t
       from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace`,
      [fn],
    );
    const m = new Map(res.rows.map((r) => [r.n, r.t]));
    types.set(fn, m);
    return m;
  }
  return {
    async rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
      const t = await argTypes(fn);
      const keys = Object.keys(args);
      const values = keys.map((k) => {
        const v = args[k];
        if (v === null || v === undefined) return null;
        return t.get(k) === "jsonb" ? JSON.stringify(v) : v;
      });
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}::${t.get(k) ?? "text"}`).join(", ")}) as r`;
      try {
        const res = await asUser(db, uid, () => db.query<{ r: unknown }>(sql, values));
        return { data: res.rows[0]?.r ?? null, error: null };
      } catch (e) {
        return { data: null, error: { code: (e as { code?: string }).code ?? "unknown", message: (e as Error).message } };
      }
    },
  };
}
