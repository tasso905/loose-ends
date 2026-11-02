"use server";
import { track } from "@/lib/analytics/track";
import { askQuestion } from "@/lib/decisions/ask";
import { AskInput, type AskView } from "@/lib/decisions/view";
import { apiError, type ApiError } from "@/lib/errors";
import { rpcDb } from "@/lib/extraction/supabaseDb";
import { createClient } from "@/lib/supabase/server";

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
