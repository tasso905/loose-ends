"use client";
import { undoQuickAddAction, type QuickAddCreated } from "@/app/add/actions";
import type { ActionHost } from "@/components/threads/ActionHost";
import { TOAST_HARD_LIMIT_MS } from "@/components/toast/UndoToast";
import { QUICK_ADD_COPY } from "@/lib/capture/quickAddInput";
import { quickAddToast } from "@/lib/review/quickAdd";
import { QUICK_ADD_UNDO_WINDOW_MS } from "@/lib/threads/transition";

export interface QuickAddToastData {
  /** The user it is shown to (D7). */
  userId: string;
  created: QuickAddCreated[];
  /** performance.now() at or before the moment the threads were created; may be in the past (D4). */
  createdAt: number;
  /** performance.now() when the result arrived. */
  arrivedAt: number;
  undoable: boolean;
}

/** The last Undo offered is this far inside the server's window, for the request's round trip. */
const UNDO_MARGIN_MS = 2_000;
/** Less than this left before the hard limit: too short to use, so no Undo is offered. */
const MIN_UNDO_MS = 2_000;

/**
 * The quick-add undo toast (F4, D8, SITE_CONTRACT §3.1), shown through an ActionHost so a refused
 * Undo appears as the §2.13 banner with Refresh, never in the toast. The toast's 8 s, and its
 * 11 s limit while hovered or focused, count from the result's arrival, but never past 28 s after the
 * threads' creation (server window 30 s). So Undo gets its full 8 s when the result arrives within
 * 20 s of creation, less when it is later, and none when under 2 s is left or the threads changed.
 */
export function showQuickAddToast(host: ActionHost, data: QuickAddToastData, restoreFocus: () => void): void {
  const { created } = data;
  if (created.length === 0) return;
  // The toast closes at actionAt + TOAST_HARD_LIMIT_MS.
  const actionAt = Math.min(data.arrivedAt, data.createdAt + QUICK_ADD_UNDO_WINDOW_MS - UNDO_MARGIN_MS - TOAST_HARD_LIMIT_MS);
  const copy = quickAddToast(created);
  if (!data.undoable || performance.now() > actionAt + TOAST_HARD_LIMIT_MS - MIN_UNDO_MS) {
    host.showToast({ message: copy.message });
    return;
  }
  host.showToast({
    message: copy.message,
    undoLabel: copy.undoLabel,
    actionAt,
    restoreFocus,
    onUndo: async () => {
      try {
        const res = await undoQuickAddAction(
          created.map((c) => ({ threadId: c.threadId, eventId: c.eventId })),
          data.userId,
        );
        if (!res.ok && res.error.code === "unauthenticated") return leaveForSignIn();
        // A refusal's banner takes focus itself.
        if (!res.ok) host.showError(res.error);
        else restoreLostFocus(restoreFocus);
      } catch {
        // The undo may have happened: nothing is claimed either way (D2).
        host.showError({ code: "save_failed", message: QUICK_ADD_COPY.undoUnknown, retryable: false });
      }
    },
  });
}

/**
 * Signed out, or someone else is signed in (D7): to /sign-in, which sends a signed-in user on to their
 * own /add. A full page load that replaces this entry, so nothing the page or its modules hold for
 * the previous user (the field, unknown lines, a toast) is left, and Back does not bring it back.
 */
export function leaveForSignIn(): void {
  window.location.replace(`/sign-in?next=${encodeURIComponent("/add?mode=quick")}`);
}

/** Undo closes the toast: if focus was in it (or already fell to <body>), it goes to `restore` (D3). */
function restoreLostFocus(restore: () => void): void {
  const a = document.activeElement;
  if (!a || a === document.body || a.closest('[role="status"]')) restore();
}

/**
 * Hand-off to the review page (SITE_CONTRACT §3.1): when a quick add creates threads and also leaves
 * Medium or Low proposals, the user goes to the tray and the undo toast for the created threads
 * shows there. Client-side navigation keeps this module, and performance.now() keeps counting, so
 * the toast keeps its original hard limit. A full reload drops it, as it drops any toast.
 */
let pending: { extractionId: string; toast: QuickAddToastData } | null = null;

export function handOffQuickAddToast(extractionId: string, toast: QuickAddToastData): void {
  pending = toast.created.length > 0 ? { extractionId, toast } : null;
}

export function takeQuickAddToast(extractionId: string): QuickAddToastData | null {
  if (!pending || pending.extractionId !== extractionId) return null;
  const out = pending.toast;
  pending = null;
  return out;
}
