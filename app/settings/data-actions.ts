"use server";
import type { User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { z } from "zod";
import { ACCOUNT_DELETE_WORD, ACCOUNT_DELETED_COOKIE, accountDeletedCookieValue, DATA_COPY } from "@/lib/account/copy";
import { deleteSource, type DataClient } from "@/lib/account/data";
import { authCall, deleteAccount, unconfirmed, type AccountAdminClient } from "@/lib/account/deleteAccount";
import { createTracker, track } from "@/lib/analytics/track";
import { apiError, type ApiError } from "@/lib/errors";
import { log } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Settings → Data (SITE_CONTRACT §2.12, PRD F13, D14; rule 8). Irreversible: the UI confirms first
 * and offers no undo (D8). Each result is reported only after the server confirms (rule 10).
 */

const isClientError = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
};

export type DeleteSourceActionResult = { ok: true; threadsForgotten: number } | { ok: false; error: ApiError["error"]; rowsGone?: true };
export type DeleteAccountActionResult = { ok: true } | { ok: false; error: ApiError["error"]; field?: "confirm" };

const DeleteSourceInput = z.object({ sourceId: z.uuid(), everything: z.boolean() });

/** `Delete source only` (everything = false) or `Delete source and everything from it` (true). */
export async function deleteSourceAction(sourceId: unknown, everything: unknown): Promise<DeleteSourceActionResult> {
  const input = DeleteSourceInput.safeParse({ sourceId, everything });
  if (!input.success) return { ok: false, error: apiError("not_found").error };
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { ok: false, error: apiError("unauthenticated").error };
  const res = await deleteSource(supabase as unknown as DataClient, input.data.sourceId, input.data.everything);
  if (!res.ok) return { ok: false, error: { code: res.error.code, message: res.error.message, retryable: res.error.retryable }, ...(res.rowsGone ? { rowsGone: true as const } : {}) };
  track(data.user.id, "source_deleted", { cascade: input.data.everything });
  return { ok: true, threadsForgotten: res.threadsForgotten };
}

/**
 * Delete account (D14): every row and every stored file, with the service role (CLAUDE.md allows it
 * for account deletion only). The user ID comes from the session, never from the request. The
 * session is ended in this browser afterwards; the user is gone either way.
 */
export async function deleteAccountAction(confirm: unknown): Promise<DeleteAccountActionResult> {
  if (typeof confirm !== "string" || confirm.trim().toLowerCase() !== ACCOUNT_DELETE_WORD) {
    return { ok: false, error: { code: "invalid_input", message: DATA_COPY.accountConfirmError, retryable: false }, field: "confirm" };
  }
  const supabase = await createClient();
  const { data, error } = await authCall<{ user: User | null }>(supabase.auth.getUser());
  if (!data?.user) {
    // No session, or Auth refused it: this says nothing about deletion, and neither does the copy. If
    // Auth didn't answer, "Sign in to continue" would be untrue of a session that may be fine.
    const refused = (error as { name?: string } | null)?.name === "AuthSessionMissingError" || isClientError(error);
    return { ok: false, error: !error || refused ? apiError("unauthenticated").error : unconfirmed().error };
  }
  const userId = data.user.id;

  // Read the analytics choice now: once the account is gone, it can no longer be looked up.
  const settings = await supabase.from("user_settings").select("analytics_enabled").eq("user_id", userId).maybeSingle();
  const optedIn = !settings.error && settings.data?.analytics_enabled === true;

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    log("account_delete_sweep_failed", { user_id: userId, step: "config" });
    return { ok: false, error: apiError("save_failed").error };
  }
  const res = await deleteAccount(admin as unknown as AccountAdminClient, userId, { email: data.user.email });
  if (!res.ok) return { ok: false, error: res.error };

  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  // Lets the sign-in page say the account was deleted, and what remains if a last step failed.
  // Only this success path sets it (a link can't), so the page never claims a deletion that did not
  // happen (rules 9, 10).
  const notice = accountDeletedCookieValue({ signInRecords: res.signInRecordsRemain === true, files: res.filesRemain === true });
  (await cookies()).set(ACCOUNT_DELETED_COOKIE, notice, { httpOnly: true, sameSite: "lax", path: "/sign-in", maxAge: 120 });
  createTracker({ isOptedIn: async () => optedIn }).track(userId, "account_deleted", {});
  return { ok: true };
}
