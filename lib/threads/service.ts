import { z } from "zod";
import { apiError, type ApiError } from "@/lib/errors";
import type { RpcDb } from "@/lib/extraction/service";
import { log as defaultLog, type Logger } from "@/lib/log";
import { Resolution, ThreadStatus } from "@/lib/schemas";

/**
 * F9 Done and its 8 s Undo through the SQL functions in migration 20261020231123 (one transaction
 * each; mirrors transition() {type: "done"} and {type: "undo"}). Results carry ids and enums only,
 * so the caller can send `thread_action` / `undo_used` without content (rule 9).
 */

const Refused = z.object({ ok: z.literal(false), error: z.enum(["not_found", "invalid_transition"]) });
const DoneOut = z.union([
  z.object({ ok: z.literal(true), thread_id: z.uuid(), event_id: z.number().int(), from_status: ThreadStatus, to_status: ThreadStatus }),
  Refused,
]);
const UndoOut = z.union([
  z.object({
    ok: z.literal(true),
    thread_id: z.uuid(),
    event_id: z.number().int(),
    undone_event_id: z.number().int(),
    undone_action: z.enum(["done", "resolve", "mark_waiting", "snooze", "dismiss", "back_to_me", "wake", "edit"]),
    from_status: ThreadStatus,
    to_status: ThreadStatus,
  }),
  Refused,
]);

const ResolveOut = z.union([
  z.object({
    ok: z.literal(true),
    thread_id: z.uuid(),
    event_id: z.number().int(),
    decision_id: z.uuid().nullable(),
    resolution: Resolution,
    from_status: ThreadStatus,
    to_status: ThreadStatus,
  }),
  Refused,
]);

export type ThreadFailure = { ok: false; code: "not_found" | "invalid_transition" | "save_failed"; error: ApiError };
export type DoneResult = Extract<z.infer<typeof DoneOut>, { ok: true }> | ThreadFailure;
export type UndoResult = Extract<z.infer<typeof UndoOut>, { ok: true }> | ThreadFailure;

const errCode = (error: unknown): string | null => {
  const c = (error as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[\w.-]{1,32}$/.test(c) ? c : null;
};

/** S12 actions (migration 20261110120000). `event_id` is null when an Edit changed nothing. */
const ActionOut = z.union([
  z.object({ ok: z.literal(true), thread_id: z.uuid(), event_id: z.number().int().nullable(), from_status: ThreadStatus, to_status: ThreadStatus }),
  Refused,
]);
export type ActionResult = Extract<z.infer<typeof ActionOut>, { ok: true }> | ThreadFailure;

async function call<T extends typeof DoneOut | typeof UndoOut | typeof ResolveOut | typeof ActionOut>(
  db: RpcDb,
  fn: string,
  args: Record<string, unknown>,
  schema: T,
  logger: Logger,
): Promise<Extract<z.infer<T>, { ok: true }> | ThreadFailure> {
  const { data, error } = await db.rpc(fn, args);
  const parsed = schema.safeParse(data);
  if (error || !parsed.success) {
    logger("thread_action_failed", { step: fn, code: errCode(error) ?? (error ? "unknown" : "bad_result") });
    return { ok: false, code: "save_failed", error: apiError("save_failed") };
  }
  const out = parsed.data as z.infer<T>;
  if (!out.ok) return { ok: false, code: out.error, error: apiError(out.error) };
  return out as Extract<z.infer<T>, { ok: true }>;
}

/** Done (D6): `fromStatus` is the status the page showed; a different current status is stale → invalid_transition. */
export function markDone(
  db: RpcDb,
  threadId: string,
  fromStatus: ThreadStatus,
  opts: { now: Date; logger?: Logger },
): Promise<DoneResult> {
  return call(db, "thread_done", { p_thread_id: threadId, p_from_status: fromStatus, p_now: opts.now.toISOString() }, DoneOut, opts.logger ?? defaultLog);
}

/** Undo of `eventId` (D44 a, approved Oct 21): only the thread's latest event, within 8 s + 4 s grace (12 s) of it, checked in the database. */
export function undoEvent(db: RpcDb, threadId: string, eventId: number, opts: { now: Date; logger?: Logger }): Promise<UndoResult> {
  return call(db, "thread_undo", { p_thread_id: threadId, p_event_id: eventId, p_now: opts.now.toISOString() }, UndoOut, opts.logger ?? defaultLog);
}

export type ResolveResult = Extract<z.infer<typeof ResolveOut>, { ok: true }> | ThreadFailure;

/**
 * F11 Resolve sheet through public.thread_resolve() (migration 20261022130327; one transaction:
 * thread update, `resolved` event and, for Decided, the decision row linked to that event). Mirrors
 * transition() {type: "resolve"}. `decision` only with `decided`; its text is sent exactly as typed.
 */
export function resolveThread(
  db: RpcDb,
  threadId: string,
  fromStatus: ThreadStatus,
  resolution: Resolution,
  decision: { choice: string; reason: string | null } | null,
  opts: { now: Date; logger?: Logger },
): Promise<ResolveResult> {
  return call(
    db,
    "thread_resolve",
    {
      p_thread_id: threadId,
      p_from_status: fromStatus,
      p_resolution: resolution,
      p_choice: decision?.choice ?? null,
      p_reason: decision?.reason ?? null,
      p_now: opts.now.toISOString(),
    },
    ResolveOut,
    opts.logger ?? defaultLog,
  );
}

/**
 * S12 (F9): Mark waiting, Snooze, Dismiss, Back to me, Wake now, Reopen and Edit, each through its
 * SQL function in migration 20261110120000 (one transaction: the thread update and its
 * thread_events row). Each mirrors transition() for the same action. `fromStatus` is the status
 * the page showed; a different current status is stale → invalid_transition.
 */
export type StatusAction =
  | { type: "mark_waiting"; waitingOn: string; expectedBy: string | null }
  | { type: "snooze"; until: string }
  | { type: "dismiss" }
  | { type: "back_to_me" }
  | { type: "wake" }
  | { type: "reopen" }
  | { type: "edit"; fields: Record<string, unknown> };

export function threadAction(
  db: RpcDb,
  threadId: string,
  fromStatus: ThreadStatus,
  action: StatusAction,
  opts: { now: Date; logger?: Logger },
): Promise<ActionResult> {
  const base = { p_thread_id: threadId, p_from_status: fromStatus, p_now: opts.now.toISOString() };
  const logger = opts.logger ?? defaultLog;
  switch (action.type) {
    case "mark_waiting":
      return call(db, "thread_mark_waiting", { ...base, p_waiting_on: action.waitingOn, p_expected_by: action.expectedBy }, ActionOut, logger);
    case "snooze":
      return call(db, "thread_snooze", { ...base, p_until: action.until }, ActionOut, logger);
    case "edit":
      return call(db, "thread_edit", { ...base, p_fields: action.fields }, ActionOut, logger);
    case "dismiss":
      return call(db, "thread_dismiss", base, ActionOut, logger);
    case "back_to_me":
      return call(db, "thread_back_to_me", base, ActionOut, logger);
    case "wake":
      return call(db, "thread_wake", base, ActionOut, logger);
    case "reopen":
      return call(db, "thread_reopen", base, ActionOut, logger);
  }
}
