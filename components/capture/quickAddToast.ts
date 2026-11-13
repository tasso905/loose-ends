"use client";
import { undoQuickAddAction, type QuickAddCreated } from "@/app/add/actions";
import type { ActionHost } from "@/components/threads/ActionHost";
import { apiError } from "@/lib/errors";
import { quickAddToast } from "@/lib/review/quickAdd";

/**
 * The quick-add undo toast (F4, D8, SITE_CONTRACT §3.1), shown through an ActionHost so a refused
 * Undo appears as the §2.13 banner with Refresh, never in the toast. `actionAt` is when the result
 * arrived: the threads were created at the end of the request, so the toast's 11 s hard limit counts
 * from about the created event, inside the server's 12 s window.
 */
export function showQuickAddToast(host: ActionHost, created: QuickAddCreated[], actionAt: number, restoreFocus?: () => void): void {
  if (created.length === 0) return;
  const copy = quickAddToast(created);
  host.showToast({
    message: copy.message,
    undoLabel: copy.undoLabel,
    actionAt,
    restoreFocus,
    onUndo: async () => {
      try {
        const res = await undoQuickAddAction(created.map((c) => ({ threadId: c.threadId, eventId: c.eventId })));
        if (!res.ok) host.showError(res.error);
      } catch {
        host.showError(apiError(navigator.onLine ? "save_failed" : "offline").error);
      }
    },
  });
}

/**
 * Hand-off to the review page (SITE_CONTRACT §3.1): when a quick add creates threads and also leaves
 * Medium or Low proposals, the user goes to the tray and the undo toast for the created threads
 * shows there. Client-side navigation keeps this module, and performance.now() keeps counting, so
 * the toast keeps its original hard limit. A full reload drops it, as it drops any toast.
 */
let pending: { extractionId: string; created: QuickAddCreated[]; actionAt: number } | null = null;

export function handOffQuickAddToast(extractionId: string, created: QuickAddCreated[], actionAt: number): void {
  pending = created.length > 0 ? { extractionId, created, actionAt } : null;
}

export function takeQuickAddToast(extractionId: string): { created: QuickAddCreated[]; actionAt: number } | null {
  if (!pending || pending.extractionId !== extractionId) return null;
  const out = pending;
  pending = null;
  return out;
}
