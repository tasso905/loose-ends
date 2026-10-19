import "server-only";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { signInPath } from "@/lib/auth/next";
import { createClient } from "@/lib/supabase/server";

/** The signed-in user, verified with Supabase Auth, or null. */
export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
}

/**
 * Page-level guard for Signed in routes (the proxy is the first line). `here` is the current path
 * with its query, so a signed-out visitor returns to it after sign-in.
 */
export async function requireUser(here: string): Promise<User> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    // Dead session (signed out elsewhere, account deleted): drop this browser's copy. A Server
    // Component cannot write cookies, so the proxy clears them on /sign-in as well (B1).
    if (error && error.name !== "AuthSessionMissingError") await supabase.auth.signOut({ scope: "local" });
    redirect(signInPath(here));
  }
  return data.user;
}
