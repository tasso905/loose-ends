import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RpcDb } from "./service";

/** The user-scoped Supabase client as the extraction service's database port (RLS applies). */
export function rpcDb(client: SupabaseClient): RpcDb {
  return { rpc: (fn, args) => client.rpc(fn, args) };
}
