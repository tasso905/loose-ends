import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

/**
 * Applies supabase/migrations to an in-process Postgres (PGlite) with minimal stand-ins for
 * Supabase's auth and storage schemas. A fast schema check only: it is not the RLS isolation test
 * against real local Supabase, which the lead-tester owns.
 */
export async function migratedDb(): Promise<PGlite> {
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
  `);
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  // Supabase grants table privileges to authenticated by default; RLS does the restricting.
  await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;
                 grant select, insert, delete on storage.objects to authenticated;`);
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
