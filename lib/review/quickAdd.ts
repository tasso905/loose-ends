import { z } from "zod";
import { QUICK_ADD_COPY } from "@/lib/capture/quickAddInput";
import { apiError, type ApiError } from "@/lib/errors";
import type { ProposalView, RpcDb } from "@/lib/extraction/service";
import { log as defaultLog, type Logger } from "@/lib/log";
import { Band } from "@/lib/schemas";
import { trayProposals } from "./tray";

/**
 * F4 quick add after its extraction (D9; SITE_CONTRACT §3.1). High proposals become threads at once
 * through public.quick_add_auto_create (migration 20261113120000, one transaction; mirrors
 * transition(null, {type: "create", via: "auto_create"}, {actor: "ai"})). Medium and Low stay
 * pending for the review tray. The 8 s Undo deletes the created threads through
 * public.quick_add_undo (F4: "Undo removes the thread and its events"). Results carry ids, enums and
 * the created titles for the toast; nothing here is logged with content (rule 9).
 */

const Refused = z.object({ ok: z.literal(false), error: z.enum(["not_found", "invalid_transition"]) });
const Created = z.object({ item_id: z.uuid(), thread_id: z.uuid(), event_id: z.number().int(), band: Band, title: z.string() });
export type AutoCreated = z.infer<typeof Created>;
const AutoCreateOut = z.union([z.object({ ok: z.literal(true), created: z.array(Created) }), Refused]);
const UndoOut = z.union([z.object({ ok: z.literal(true), removed: z.number().int() }), Refused]);

export type QuickAddFailure = { ok: false; code: "not_found" | "invalid_transition" | "save_failed"; error: ApiError };

const errCode = (error: unknown): string | null => {
  const c = (error as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[\w.-]{1,32}$/.test(c) ? c : null;
};

async function call<T extends typeof AutoCreateOut | typeof UndoOut>(
  db: RpcDb,
  fn: string,
  args: Record<string, unknown>,
  schema: T,
  logger: Logger,
): Promise<Extract<z.infer<T>, { ok: true }> | QuickAddFailure> {
  const { data, error } = await db.rpc(fn, args);
  const parsed = schema.safeParse(data);
  if (error || !parsed.success) {
    logger("quick_add_failed", { step: fn, code: errCode(error) ?? (error ? "unknown" : "bad_result") });
    return { ok: false, code: "save_failed", error: apiError("save_failed") };
  }
  const out = parsed.data as z.infer<T>;
  if (!out.ok) return { ok: false, code: out.error, error: apiError(out.error) };
  return out as Extract<z.infer<T>, { ok: true }>;
}

export function autoCreateQuickAdd(
  db: RpcDb,
  extractionId: string,
  opts: { now: Date; logger?: Logger },
): Promise<{ ok: true; created: AutoCreated[] } | QuickAddFailure> {
  return call(db, "quick_add_auto_create", { p_extraction_id: extractionId, p_now: opts.now.toISOString() }, AutoCreateOut, opts.logger ?? defaultLog);
}

export interface UndoPair {
  threadId: string;
  eventId: number;
}

/** All or nothing: every thread the quick add created, each within 12 s of its created event. */
export function undoQuickAdd(
  db: RpcDb,
  pairs: UndoPair[],
  opts: { now: Date; logger?: Logger },
): Promise<{ ok: true; removed: number } | QuickAddFailure> {
  return call(
    db,
    "quick_add_undo",
    { p_thread_ids: pairs.map((p) => p.threadId), p_event_ids: pairs.map((p) => p.eventId), p_now: opts.now.toISOString() },
    UndoOut,
    opts.logger ?? defaultLog,
  );
}

/**
 * Where the user goes after a quick add (SITE_CONTRACT §3.1, D9). They stay on the page with the
 * undo toast when every proposal the tray would show became a thread. If any Medium or Low proposal
 * is waiting, they go to the review tray for those only. With nothing created and nothing to review,
 * the tray's zero state says so (`Nothing here needs your attention`).
 */
export function quickAddRoute(created: ReadonlyArray<unknown>, proposals: ProposalView[]): "stay" | "review" {
  const waiting = trayProposals(proposals).some((p) => p.reviewStatus === "pending");
  return created.length > 0 && !waiting ? "stay" : "review";
}

/** The toast for what was created (one thread: its title; several: a count). */
export function quickAddToast(created: ReadonlyArray<{ title: string }>): { message: string; undoLabel: string } {
  if (created.length === 1) {
    const title = created[0]!.title;
    return { message: QUICK_ADD_COPY.toast(title), undoLabel: QUICK_ADD_COPY.undoLabel(title) };
  }
  return { message: QUICK_ADD_COPY.toastMany(created.length), undoLabel: QUICK_ADD_COPY.undoLabelMany(created.length) };
}

/** Proposals the review tray shows for a quick add: the auto-created ones are already threads. */
export function reviewableProposals(proposals: ProposalView[]): ProposalView[] {
  return proposals.filter((p) => p.reviewStatus !== "auto_created");
}
