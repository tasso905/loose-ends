import { execSync } from "node:child_process";

/**
 * URLs and keys of the local Supabase stack (default dev keys, no secrets). Reads
 * `supabase status -o json`; LE_SUPABASE_URL / LE_SUPABASE_ANON_KEY / LE_SUPABASE_SERVICE_ROLE_KEY /
 * LE_MAILPIT_URL override it (CI sets them once after `supabase start`).
 */
export interface LocalSupabase {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  mailpitUrl: string;
}

let cached: LocalSupabase | null = null;

export function localSupabase(): LocalSupabase {
  if (cached) return cached;
  const e = process.env;
  if (e.LE_SUPABASE_URL && e.LE_SUPABASE_ANON_KEY && e.LE_SUPABASE_SERVICE_ROLE_KEY) {
    cached = {
      url: e.LE_SUPABASE_URL,
      anonKey: e.LE_SUPABASE_ANON_KEY,
      serviceRoleKey: e.LE_SUPABASE_SERVICE_ROLE_KEY,
      mailpitUrl: e.LE_MAILPIT_URL ?? "http://127.0.0.1:54324",
    };
    return cached;
  }
  const out = execSync("pnpm exec supabase status -o json", { stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }).toString();
  const j = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string>;
  if (!j.API_URL || !j.ANON_KEY || !j.SERVICE_ROLE_KEY) throw new Error("Local Supabase is not running: pnpm exec supabase start");
  cached = {
    url: j.API_URL,
    anonKey: j.ANON_KEY,
    serviceRoleKey: j.SERVICE_ROLE_KEY,
    mailpitUrl: j.MAILPIT_URL ?? j.INBUCKET_URL ?? "http://127.0.0.1:54324",
  };
  return cached;
}
