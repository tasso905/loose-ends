"use client";
import { useContext, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { markDoneAction, undoAction } from "@/app/threads/[id]/actions";
import { Spinner } from "@/components/auth/Spinner";
import { ErrorBanner } from "@/components/Notice";
import { UndoToast, type ToastData } from "@/components/toast/UndoToast";
import { Button } from "@/components/ui/button";
import { apiError, type ApiError } from "@/lib/errors";
import type { ThreadKind, ThreadStatus } from "@/lib/schemas";
import { RESOLVE_COPY } from "@/lib/threads/resolve";
import { canMarkDone, canResolve, THREADS_COPY as C } from "@/lib/threads/view";
import { ActionHostContext } from "./ActionHost";
import { ResolveSheet, type Resolved } from "./ResolveSheet";

/**
 * Thread detail actions (SITE_CONTRACT §2.7). Done runs at once and offers an 8 s Undo (D6, D8);
 * Resolve… opens the Resolve sheet (F11), and a saved resolution offers the same Undo. Decision
 * threads have Resolve… instead of Done (D6). The page re-renders from the server only after the
 * server confirms (rule 10). Errors show as a page banner, never in the toast (§2.13);
 * invalid_transition offers Refresh. `?sheet=resolve` opens the sheet (§1.2).
 */

const failure = (code: "save_failed") => apiError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : code).error;

/** Monotonic ms for the toast's hard limit; called from the Done click handler, never in render. */
const actionClock = () => performance.now();

export function ThreadActions({
  threadId,
  title,
  status,
  kind,
  openResolve = false,
  compact = false,
  surface = "detail",
  focusTargetId = "thread-status",
}: {
  threadId: string;
  title: string;
  status: ThreadStatus;
  kind: ThreadKind;
  openResolve?: boolean;
  /** Today rows: small ghost buttons whose names include the thread title (DESIGN_STANDARD Thread row). */
  compact?: boolean;
  surface?: "today" | "detail";
  /** Where focus goes when the action takes the buttons away (Thread detail: the status line). */
  focusTargetId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ApiError["error"] | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const toastId = useRef(0);
  // On Today the row leaves after Done or Resolve; the host keeps its toast and Undo errors (ActionHost).
  const host = useContext(ActionHostContext);
  function showToast(t: Omit<ToastData, "id">) {
    if (host) return host.showToast(t);
    toastId.current += 1;
    setToast({ ...t, id: toastId.current });
  }
  function undoFailed(e: ApiError["error"]) {
    if (host) return host.showError(e);
    focusErrorOnRender.current = true;
    setError(e);
  }
  const doneRef = useRef<HTMLButtonElement>(null);
  const resolveRef = useRef<HTMLButtonElement>(null);
  const [sheetOpen, setSheetOpen] = useState(() => openResolve && canResolve({ status }));
  // Set by a successful Undo: Done returns only after router.refresh() re-renders with the server's
  // status, so the focus move waits for that render (doneRef is null until then).
  const focusDoneOnReturn = useRef(false);
  // Set by a refused or failed Undo: the toast (which held focus) closes, so focus moves to the
  // error banner once it renders, or the status line without one; never <body> (T-U1).
  const focusErrorOnRender = useRef(false);
  const bannerRef = useRef<HTMLDivElement>(null);

  function done() {
    setError(null);
    // The toast's 11 s hard limit counts from the action, which is before the server's event time.
    const actionAt = actionClock();
    startTransition(async () => {
      try {
        const res = await markDoneAction(threadId, status, surface);
        if (!res.ok) return setError(res.error);
        router.refresh();
        // The Done button leaves the page; focus goes to the status line, not into the toast, so the
        // 8 s timer runs unless the user moves to the toast.
        document.getElementById(focusTargetId)?.focus();
        showToast({
          message: C.doneToast(title),
          onUndo: () => undo(res.eventId),
          undoLabel: `Undo done: ${title}`,
          actionAt,
          restoreFocus: () => document.getElementById(focusTargetId)?.focus(),
        });
      } catch {
        setError(failure("save_failed"));
      }
    });
  }

  function resolved(r: Resolved) {
    // Resolve… leaves the page; focus goes to the status line, as after Done. The page behind the
    // modal is inert until the dialog has closed, so the move waits for that (effect below).
    focusOnClose.current = "status";
    setSheetOpen(false);
    router.refresh();
    showToast({
      message: r.resolution === "done" ? C.doneToast(title) : RESOLVE_COPY.resolvedToast(title),
      onUndo: () => undo(r.eventId),
      undoLabel: RESOLVE_COPY.undoLabel(title),
      actionAt: r.actionAt,
      restoreFocus: () => document.getElementById(focusTargetId)?.focus(),
    });
  }

  // Focus moves once the dialog has really closed (the page behind a modal dialog is inert, so
  // focusing it earlier does nothing). The sheet's own effect closes it first. Cancel returns focus
  // to Resolve…; a save moves it to the status line (Resolve… is about to leave the page).
  const focusOnClose = useRef<"resolve" | "status" | null>(null);
  function closeSheet() {
    focusOnClose.current = "resolve";
    setSheetOpen(false);
  }
  useEffect(() => {
    if (sheetOpen || !focusOnClose.current) return;
    const target = focusOnClose.current;
    focusOnClose.current = null;
    if (target === "resolve") resolveRef.current?.focus();
    else document.getElementById(focusTargetId)?.focus();
  }, [sheetOpen, focusTargetId]);

  async function undo(eventId: number) {
    setError(null);
    try {
      const res = await undoAction(threadId, eventId);
      if (!res.ok) return undoFailed(res.error);
      // Done comes back after the refresh; until then focus waits on the status line, never <body>.
      // If Undo came before the Save's own refresh landed, Done never left the page: that refresh is
      // superseded by this one, `showResolve` does not change, and the effect below would not run.
      const back = doneRef.current ?? resolveRef.current;
      if (back) {
        back.focus();
      } else {
        focusDoneOnReturn.current = true;
        document.getElementById(focusTargetId)?.focus();
      }
      router.refresh();
    } catch {
      undoFailed(failure("save_failed"));
    }
  }

  useEffect(() => {
    if (!focusErrorOnRender.current) return;
    focusErrorOnRender.current = false;
    (bannerRef.current ?? document.getElementById(focusTargetId))?.focus();
  }, [error, focusTargetId]);

  const showDone = canMarkDone({ status, kind });
  const showResolve = canResolve({ status });
  useEffect(() => {
    // After an Undo the first action comes back: Done, or Resolve… on a decision thread.
    const target = doneRef.current ?? resolveRef.current;
    if (focusDoneOnReturn.current && showResolve && target) {
      focusDoneOnReturn.current = false;
      target.focus();
    }
  }, [showResolve]);

  return (
    <div>
      {error ? (
        <div ref={bannerRef} tabIndex={-1} className="focus-ring mb-4 rounded-card">
          <ErrorBanner
            action={
              error.code === "invalid_transition" ? (
                <Button variant="secondary" size="small" onClick={() => router.refresh()}>
                  {C.refresh}
                </Button>
              ) : error.retryable && showDone ? (
                // Only Done is retried: an Undo retried later would be outside its 8 s window.
                <Button variant="secondary" size="small" onClick={done} disabled={pending}>
                  {C.tryAgain}
                </Button>
              ) : undefined
            }
          >
            {error.message}
          </ErrorBanner>
        </div>
      ) : null}

      {showResolve ? (
        <div className="flex flex-wrap items-center gap-3">
          {showDone ? (
            <Button
              ref={doneRef}
              onClick={done}
              disabled={pending}
              variant={compact ? "ghost" : "primary"}
              size={compact ? "small" : "default"}
              aria-label={compact ? `${C.done}: ${title}` : undefined}
            >
              {pending ? <Spinner /> : <Check aria-hidden strokeWidth={1.75} />}
              {C.done}
            </Button>
          ) : null}
          <Button
            ref={resolveRef}
            variant={compact ? "ghost" : showDone ? "secondary" : "primary"}
            size={compact ? "small" : "default"}
            aria-label={compact ? `${C.resolve} ${title}` : undefined}
            onClick={() => setSheetOpen(true)}
            disabled={pending}
            aria-haspopup="dialog"
          >
            {C.resolve}
          </Button>
        </div>
      ) : null}

      {showResolve ? (
        <ResolveSheet threadId={threadId} status={status} kind={kind} open={sheetOpen} onClose={closeSheet} onResolved={resolved} surface={surface} />
      ) : null}

      {host ? null : <UndoToast toast={toast} onClose={(id) => setToast((t) => (t && t.id === id ? null : t))} />}
    </div>
  );
}
