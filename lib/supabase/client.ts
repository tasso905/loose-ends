"use client";
import { createBrowserClient } from "@supabase/ssr";
import { supabasePublicEnv } from "@/lib/supabase/env";

/** Browser client (user-scoped, anon key + session cookies). */
export function createClient() {
  const { url, anonKey } = supabasePublicEnv();
  return createBrowserClient(url, anonKey);
}
