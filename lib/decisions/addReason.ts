import { z } from "zod";
import { apiError, type ApiError } from "@/lib/errors";
import type { RpcDb } from "@/lib/extraction/service";
import { log as defaultLog, type Logger } from "@/lib/log";
import { charCount, DECISION_REASON_MAX, isBlankText } from "@/lib/threads/transition";

/**
 * S9b "Add a reason now" (D58; SITE_CONTRACT §2.11, CONTENT_MODEL §10) through
 * public.decision_add_reason() (migration 20261027120221): only the owner, only while the decision
 * has no reason, at most 2,000 characters, not blank (the same checks as Resolve), stored exactly as
 * typed (rule 5), with a `reason_added` thread_events row (before/after). No undo: adding a reason
 * is not in the D8 list of reversible actions (open question for the PM).
 */

export const AddReasonInput = z.object({
  decisionId: z.uuid(),
  reason: z
    .string()
    .refine((s) => !isBlankText(s), "blank")
    .refine((s) => charCount(s) <= DECISION_REASON_MAX, "too_long"),
});
export type AddReasonInput = z.infer<typeof AddReasonInput>;

const Out = z.union([
  z.object({ ok: z.literal(true), decision_id: z.uuid(), thread_id: z.uuid(), event_id: z.number().int(), reason_user: z.string() }),
  z.object({ ok: z.literal(false), error: z.enum(["not_found", "invalid_transition"]) }),
]);

export type AddReasonResult =
  | { ok: true; decisionId: string; threadId: string; eventId: number; reason: string }
  | { ok: false; code: "not_found" | "invalid_transition" | "save_failed"; error: ApiError };

export async function addReason(db: RpcDb, input: AddReasonInput, opts: { now: Date; logger?: Logger }): Promise<AddReasonResult> {
  const logger = opts.logger ?? defaultLog;
  const { data, error } = await db.rpc("decision_add_reason", {
    p_decision_id: input.decisionId,
    p_reason: input.reason,
    p_now: opts.now.toISOString(),
  });
  const parsed = Out.safeParse(data);
  if (error || !parsed.success) {
    const code = (error as { code?: unknown } | null)?.code;
    logger("reason_add_failed", { code: typeof code === "string" && /^[\w.-]{1,32}$/.test(code) ? code : error ? "unknown" : "bad_result" });
    return { ok: false, code: "save_failed", error: apiError("save_failed") };
  }
  const out = parsed.data;
  if (!out.ok) return { ok: false, code: out.error, error: apiError(out.error) };
  return { ok: true, decisionId: out.decision_id, threadId: out.thread_id, eventId: out.event_id, reason: out.reason_user };
}
