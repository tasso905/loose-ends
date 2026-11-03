"use server";
import { track } from "@/lib/analytics/track";
import { addReason, AddReasonInput } from "@/lib/decisions/addReason";
import { askQuestion } from "@/lib/decisions/ask";
import { DECISIONS_COPY } from "@/lib/decisions/copy";
import { AskInput, type AskView } from "@/lib/decisions/view";
import { apiError, type ApiError } from "@/lib/errors";
import { rpcDb } from "@/lib/extraction/supabaseDb";
import { createClient } from "@/lib/supabase/server";
import { RESOLVE_COPY } from "@/lib/threads/resolve";
import { getNow } from "@/lib/time";

/**
 * F12 Ask why (SITE_CONTRACT §2.11). The answer comes only from the caller's retrieved decisions;
 * any failure returns `ask_failed` (D54) and no answer at all (rule 10). See lib/decisions/ask.ts.
 */

export type AskActionResult = { ok: true; view: AskView } | { ok: false; error: ApiError["error"]; field?: "question" };

export async function askAction(question: unknown): Promise<AskActionResult> {
  const input = AskInput.safeParse({ question });
  if (!input.success) return { ok: false, error: apiError("invalid_input", { field: "question" }).error, field: "question" };

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { ok: false, error: apiError("unauthenticated").error };

  const res = await askQuestion(rpcDb(supabase), input.data.question);
  if (!res.ok) return { ok: false, error: res.error.error };
  track(data.user.id, "ask_submitted", { answer_found: res.view.found, parts_by_kind: res.counts });
  return { ok: true, view: res.view };
}

export type AddReasonActionResult =
  | { ok: true; decisionId: string; reason: string }
  | { ok: false; error: ApiError["error"]; field?: "reason" };

/**
 * S9b "Add a reason now" (D58): adds a reason to a decision saved without one, exactly as typed
 * (rule 5). The card shows the reason only from this confirmed result (rule 10). Field errors are
 * never retryable: resending the same text can't succeed.
 */
export async function addReasonAction(decisionId: unknown, reason: unknown): Promise<AddReasonActionResult> {
  const input = AddReasonInput.safeParse({ decisionId, reason });
  if (!input.success) {
    const issue = input.error.issues.find((i) => i.path[0] === "reason");
    if (!issue) return { ok: false, error: apiError("not_found").error };
    const message = issue.message === "too_long" ? RESOLVE_COPY.reasonTooLong : DECISIONS_COPY.reasonRequired;
    return { ok: false, error: { code: "invalid_input", message, retryable: false }, field: "reason" };
  }
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { ok: false, error: apiError("unauthenticated").error };
  const res = await addReason(rpcDb(supabase), input.data, { now: getNow() });
  if (!res.ok) return { ok: false, error: res.error.error };
  track(data.user.id, "reason_added", {});
  return { ok: true, decisionId: res.decisionId, reason: res.reason };
}
