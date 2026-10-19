"use server";
import { cookies } from "next/headers";
import { SIGN_IN_EMAIL_COOKIE, SIGN_IN_EMAIL_COOKIE_PATH } from "@/lib/auth/signIn";
import { createClient } from "@/lib/supabase/server";

/**
 * Signs out this browser only (scope "local"; other devices stay signed in). The page leaves only
 * after Supabase confirms (rule 10).
 */
export async function signOut(): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });
  (await cookies()).delete({ name: SIGN_IN_EMAIL_COOKIE, path: SIGN_IN_EMAIL_COOKIE_PATH });
  return { ok: !error };
}
