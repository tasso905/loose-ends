"use server";
import { z } from "zod";
import { track } from "@/lib/analytics/track";
import { apiError, type ApiError } from "@/lib/errors";
import { rpcDb } from "@/lib/extraction/supabaseDb";
import { ThreadStatus } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { markDone, undoEvent } from "@/lib/threads/service";
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

async function context() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ? { userId: data.user.id, db: rpcDb(supabase) } : null;
}

export async function markDoneAction(threadId: string, fromStatus: string): Promise<DoneActionResult> {
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
    surface: "detail",
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
