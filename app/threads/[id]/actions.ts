"use server";
import { z } from "zod";
import { forgetThread, type DataClient } from "@/lib/account/data";
import { track } from "@/lib/analytics/track";
import { apiError, type ApiError } from "@/lib/errors";
import { rpcDb } from "@/lib/extraction/supabaseDb";
import { ThreadStatus } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { RESOLVE_COPY, ResolveInput as ResolveInputSchema, type ResolveInput } from "@/lib/threads/resolve";
import {
  ACTIONS_COPY as A,
  editFieldsToState,
  EditInput as EditInputSchema,
  endOfLocalDay,
  MarkWaitingInput as MarkWaitingInputSchema,
  SimpleInput as SimpleInputSchema,
  SnoozeInput as SnoozeInputSchema,
  snoozeUntil,
  type EditInput,
  type MarkWaitingInput,
  type SimpleInput,
  type SnoozeInput,
} from "@/lib/threads/actions";
import { markDone, resolveThread, threadAction, undoEvent, type StatusAction } from "@/lib/threads/service";
import { isBlankText } from "@/lib/threads/transition";
import { userTimezone } from "@/lib/threads/read";
import type { WhyView } from "@/lib/threads/why";
import { loadWhy } from "@/lib/threads/whyRead";
import { getNow } from "@/lib/time";

/**
 * F9 Done and its Undo (D6, D8; undo semantics are D44 option a, approved Oct 21). Each is one SQL
 * transaction (migration 20261020231123). The Undo window (8 s toast + 4 s grace = 12 s, migration
 * 20261021170903) is checked in the database against the p_now this action passes (getNow()), and
 * the database refuses a p_now more than 5 s from its own clock (migration 20261021131140), so a
 * direct RPC cannot claim an earlier instant to stretch the window. The UI shows success only from these results (rule 10).
 */

export type DoneActionResult = { ok: true; eventId: number } | { ok: false; error: ApiError["error"] };
export type UndoActionResult = { ok: true } | { ok: false; error: ApiError["error"] };

const DoneInput = z.object({ threadId: z.uuid(), fromStatus: ThreadStatus });
const UndoInput = z.object({ threadId: z.uuid(), eventId: z.number().int().positive() });
/** Where an action was taken (analytics only): Today rows or Thread detail. */
const Surface = z.enum(["today", "detail"]).catch("detail");
type Surface = "today" | "detail";

async function context() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ? { userId: data.user.id, db: rpcDb(supabase) } : null;
}

export async function markDoneAction(threadId: string, fromStatus: string, surface: Surface = "detail"): Promise<DoneActionResult> {
  const input = DoneInput.safeParse({ threadId, fromStatus });
  if (!input.success) return { ok: false, error: apiError("not_found").error };
  const ctx = await context();
  if (!ctx) return { ok: false, error: apiError("unauthenticated").error };
  const res = await markDone(ctx.db, input.data.threadId, input.data.fromStatus, { now: getNow() });
  if (!res.ok) return { ok: false, error: res.error.error };
  track(ctx.userId, "thread_action", {
    thread_id: res.thread_id,
    action: "done",
    from_status: res.from_status,
    to_status: res.to_status,
    surface: Surface.parse(surface),
  });
  return { ok: true, eventId: res.event_id };
}

export async function undoAction(threadId: string, eventId: number): Promise<UndoActionResult> {
  const input = UndoInput.safeParse({ threadId, eventId });
  if (!input.success) return { ok: false, error: apiError("not_found").error };
  const ctx = await context();
  if (!ctx) return { ok: false, error: apiError("unauthenticated").error };
  const res = await undoEvent(ctx.db, input.data.threadId, input.data.eventId, { now: getNow() });
  if (!res.ok) return { ok: false, error: res.error.error };
  track(ctx.userId, "undo_used", { action: res.undone_action });
  return { ok: true };
}

export type ResolveActionResult =
  | { ok: true; eventId: number; resolution: "done" | "decided" | "not_needed" }
  | { ok: false; error: ApiError["error"]; field?: "choice" | "reason" };

/**
 * F11 Resolve sheet (D6): one SQL transaction (public.thread_resolve, migration 20261022130327)
 * writes the thread, its `resolved` event and, for Decided, the decision row linked to that event.
 * The decision and reason are passed exactly as typed (rule 5); a reason left empty is Skip. Undo
 * goes through undoAction above (D44; the toast closes at 11 s, the server window is 12 s, D51).
 */
export async function resolveAction(input: ResolveInput, surface: Surface = "detail"): Promise<ResolveActionResult> {
  const parsed = ResolveInputSchema.safeParse(input);
  if (!parsed.success) {
    // Field errors are never retryable: resending the same text can't succeed.
    const field = (path: string, message: string) => ({ ok: false as const, error: { code: "invalid_input" as const, message, retryable: false }, field: path as "choice" | "reason" });
    const choice = parsed.error.issues.find((i) => i.path[0] === "choice");
    if (choice) return field("choice", choice.message === "too_long" ? RESOLVE_COPY.choiceTooLong : RESOLVE_COPY.choiceRequired);
    if (parsed.error.issues.some((i) => i.path[0] === "reason" && i.message === "too_long")) return field("reason", RESOLVE_COPY.reasonTooLong);
    return { ok: false, error: apiError("not_found").error };
  }
  const ctx = await context();
  if (!ctx) return { ok: false, error: apiError("unauthenticated").error };
  const p = parsed.data;
  const decision = p.resolution === "decided" ? { choice: p.choice, reason: isBlankText(p.reason) ? null : p.reason } : null;
  const res = await resolveThread(ctx.db, p.threadId, p.fromStatus, p.resolution, decision, { now: getNow() });
  if (!res.ok) return { ok: false, error: res.error.error };
  track(ctx.userId, "thread_action", {
    thread_id: res.thread_id,
    action: "resolve",
    from_status: res.from_status,
    to_status: res.to_status,
    surface: Surface.parse(surface),
  });
  track(ctx.userId, "resolve_saved", { resolution: res.resolution, reason_given: decision !== null && decision.reason !== null });
  return { ok: true, eventId: res.event_id, resolution: res.resolution };
}

export type WhyActionResult = { ok: true; view: WhyView } | { ok: false; error: ApiError["error"] };

/**
 * F8 Why panel (SITE_CONTRACT §2.8): reads stored fields and fills fixed templates (lib/threads/why.ts).
 * No model is called (rule 6). Another user's thread reads as not found (RLS).
 */
export async function whyAction(threadId: string, surface: Surface = "detail"): Promise<WhyActionResult> {
  const id = z.uuid().safeParse(threadId);
  if (!id.success) return { ok: false, error: apiError("not_found").error };
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { ok: false, error: apiError("unauthenticated").error };
  const timezone = await userTimezone(supabase, data.user.id);
  const res = await loadWhy(supabase, id.data, timezone, getNow());
  if (!res.ok) return { ok: false, error: apiError(res.reason === "not_found" ? "not_found" : "save_failed").error };
  track(data.user.id, "why_opened", { thread_id: id.data, surface: Surface.parse(surface) });
  return { ok: true, view: res.view };
}

export type ForgetActionResult = { ok: true } | { ok: false; error: ApiError["error"]; rowsGone?: true };

/**
 * F9 Forget permanently (D8, D29, D35; rule 8). Irreversible: the UI confirms first and has no
 * undo. One SECURITY DEFINER call deletes the rows (public.forget_thread); with "Also delete
 * source", the source's file is then removed from Storage (lib/account/data.ts). Success only once
 * both are done (rule 10).
 */
export async function forgetAction(threadId: unknown, alsoDeleteSource: unknown): Promise<ForgetActionResult> {
  const input = z.object({ threadId: z.uuid(), alsoDeleteSource: z.boolean() }).safeParse({ threadId, alsoDeleteSource });
  if (!input.success) return { ok: false, error: apiError("not_found").error };
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { ok: false, error: apiError("unauthenticated").error };
  const res = await forgetThread(supabase as unknown as DataClient, input.data.threadId, input.data.alsoDeleteSource);
  if (!res.ok) return { ok: false, error: { code: res.error.code, message: res.error.message, retryable: res.error.retryable }, ...(res.rowsGone ? { rowsGone: true as const } : {}) };
  track(data.user.id, "thread_action", { thread_id: input.data.threadId, action: "forget", from_status: null, to_status: null, surface: "detail" });
  if (res.sourceDeleted) track(data.user.id, "source_deleted", { cascade: false });
  return { ok: true };
}

// --- S12: Mark waiting, Snooze, Dismiss, Back to me, Wake now, Reopen, Edit -----------------------

export type ActionField = "waitingOn" | "expectedBy" | "date" | "title" | "due" | "waiting_on" | "expected_by" | "snoozed_until";
export type ThreadActionResult =
  | { ok: true; eventId: number | null; status: ThreadStatus }
  | { ok: false; error: ApiError["error"]; field?: ActionField };

const fieldError = (field: ActionField, message: string): ThreadActionResult => ({
  ok: false,
  // Field errors are never retryable: resending the same input can't succeed.
  error: { code: "invalid_input", message, retryable: false },
  field,
});

/** The signed-in user's database port and timezone (dates are entered as local calendar dates). */
async function zonedContext() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  return { userId: data.user.id, db: rpcDb(supabase), timezone: await userTimezone(supabase, data.user.id) };
}

async function run(
  ctx: { userId: string; db: ReturnType<typeof rpcDb> },
  threadId: string,
  fromStatus: ThreadStatus,
  action: StatusAction,
  surface: Surface,
  now: Date,
): Promise<ThreadActionResult> {
  const res = await threadAction(ctx.db, threadId, fromStatus, action, { now });
  if (!res.ok) return { ok: false, error: res.error.error };
  // An Edit that changed nothing writes nothing and is not an action.
  if (res.event_id !== null) {
    track(ctx.userId, "thread_action", {
      thread_id: res.thread_id,
      action: action.type,
      from_status: res.from_status,
      to_status: res.to_status,
      surface: Surface.parse(surface),
    });
  }
  return { ok: true, eventId: res.event_id, status: res.to_status };
}

/** Mark waiting (open → waiting): `Waiting on` is required, `Expected by` an optional local date (stored at 23:59). */
export async function markWaitingAction(input: MarkWaitingInput, surface: Surface = "detail"): Promise<ThreadActionResult> {
  const p = MarkWaitingInputSchema.safeParse(input);
  if (!p.success) {
    const path = p.error.issues[0]?.path[0];
    if (path === "waitingOn") return fieldError("waitingOn", A.waitingOnRequired);
    if (path === "expectedBy") return fieldError("expectedBy", A.badDate);
    return { ok: false, error: apiError("not_found").error };
  }
  const ctx = await zonedContext();
  if (!ctx) return { ok: false, error: apiError("unauthenticated").error };
  const expectedBy = p.data.expectedBy === null ? null : endOfLocalDay(p.data.expectedBy, ctx.timezone);
  return run(ctx, p.data.threadId, p.data.fromStatus, { type: "mark_waiting", waitingOn: p.data.waitingOn, expectedBy }, surface, getNow());
}

/** Snooze (open → snoozed) at 9:00 local on the chosen day (D11); the instant is computed here, with getNow(). */
export async function snoozeAction(input: SnoozeInput, surface: Surface = "detail"): Promise<ThreadActionResult> {
  const p = SnoozeInputSchema.safeParse(input);
  if (!p.success) {
    if (p.error.issues.some((i) => i.path[0] === "choice")) return fieldError("date", A.badDate);
    return { ok: false, error: apiError("not_found").error };
  }
  const ctx = await zonedContext();
  if (!ctx) return { ok: false, error: apiError("unauthenticated").error };
  const now = getNow();
  const until = snoozeUntil(p.data.choice, now, ctx.timezone);
  if (!until) return fieldError("date", A.pickFutureDate);
  return run(ctx, p.data.threadId, p.data.fromStatus, { type: "snooze", until }, surface, now);
}

/** Dismiss, Back to me, Wake now and Reopen: no input beyond the thread and the status the page showed. */
export async function simpleAction(input: SimpleInput, surface: Surface = "detail"): Promise<ThreadActionResult> {
  const p = SimpleInputSchema.safeParse(input);
  if (!p.success) return { ok: false, error: apiError("not_found").error };
  const ctx = await context();
  if (!ctx) return { ok: false, error: apiError("unauthenticated").error };
  return run(ctx, p.data.threadId, p.data.fromStatus, { type: p.data.action }, surface, getNow());
}

/** Edit: only the fields the user changed; text is stored exactly as typed (rule 5). */
export async function editAction(input: EditInput): Promise<ThreadActionResult> {
  const p = EditInputSchema.safeParse(input);
  if (!p.success) {
    const issue = p.error.issues.find((i) => i.path[0] === "fields");
    const field = issue?.path[1];
    if (field === "title") return fieldError("title", issue?.message === "too_long" ? A.titleTooLong : A.titleRequired);
    if (field === "waiting_on") return fieldError("waiting_on", A.waitingOnRequired);
    if (field === "due" || field === "expected_by" || field === "snoozed_until") return fieldError(field, A.badDate);
    return { ok: false, error: apiError("not_found").error };
  }
  const ctx = await zonedContext();
  if (!ctx) return { ok: false, error: apiError("unauthenticated").error };
  const now = getNow();
  const fields = editFieldsToState(p.data.fields, ctx.timezone, now);
  if (!fields.ok) return fieldError("snoozed_until", A.pickFutureDate);
  return run(ctx, p.data.threadId, p.data.fromStatus, { type: "edit", fields: fields.fields }, "detail", now);
}
