import { z } from "zod";
import { apiError, type ApiError } from "@/lib/errors";
import type { RpcDb } from "@/lib/extraction/service";
import { log as defaultLog, type Logger } from "@/lib/log";
import { ThreadStatus } from "@/lib/schemas";

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
    undone_action: z.enum(["done", "resolve"]),
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

async function call<T extends typeof DoneOut | typeof UndoOut>(
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

/** Undo of `eventId` (proposed D44 a): only the thread's latest event, within 8 s of it on the server clock. */
export function undoEvent(db: RpcDb, threadId: string, eventId: number, opts: { now: Date; logger?: Logger }): Promise<UndoResult> {
  return call(db, "thread_undo", { p_thread_id: threadId, p_event_id: eventId, p_now: opts.now.toISOString() }, UndoOut, opts.logger ?? defaultLog);
}
