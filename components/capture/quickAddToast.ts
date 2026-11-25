"use client";
import { undoQuickAddAction, type QuickAddCreated } from "@/app/add/actions";
import type { ActionHost } from "@/components/threads/ActionHost";
import { TOAST_HARD_LIMIT_MS } from "@/components/toast/UndoToast";
import { QUICK_ADD_COPY } from "@/lib/capture/quickAddInput";
import { quickAddToast } from "@/lib/review/quickAdd";

export interface QuickAddToastData {
  created: QuickAddCreated[];
  /** performance.now() at or before the moment the threads were created; may be in the past (D4). */
  actionAt: number;
  undoable: boolean;
}

/** Less than this left before the hard limit: too short to use, so no Undo is offered. */
const MIN_UNDO_MS = 2_000;

/**
 * The quick-add undo toast (F4, D8, SITE_CONTRACT §3.1), shown through an ActionHost so a refused
 * Undo appears as the §2.13 banner with Refresh, never in the toast. The toast's 11 s limit counts
 * from the threads' creation. When that has passed (a very slow response, or Try again after a lost
 * one) or the threads have changed since, the message shows without Undo.
 */
export function showQuickAddToast(host: ActionHost, data: QuickAddToastData, restoreFocus: () => void): void {
  const { created, actionAt } = data;
  if (created.length === 0) return;
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
        const res = await undoQuickAddAction(created.map((c) => ({ threadId: c.threadId, eventId: c.eventId })));
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
