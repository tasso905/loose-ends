"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { markDoneAction, undoAction } from "@/app/threads/[id]/actions";
import { Spinner } from "@/components/auth/Spinner";
import { ErrorBanner } from "@/components/Notice";
import { UndoToast, type ToastData } from "@/components/toast/UndoToast";
import { Button } from "@/components/ui/button";
import { apiError, type ApiError } from "@/lib/errors";
import type { ThreadKind, ThreadStatus } from "@/lib/schemas";
import { canMarkDone, THREADS_COPY as C } from "@/lib/threads/view";

/**
 * Thread detail actions (SITE_CONTRACT §2.7). Done runs at once and offers an 8 s Undo (D6, D8); the
 * page re-renders from the server only after the server confirms (rule 10). Resolve… is shown
 * disabled with its reason on decision threads until F11 ships. Errors show as a page banner, never
 * in the toast (§2.13); invalid_transition offers Refresh.
 */

const failure = (code: "save_failed") => apiError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : code).error;

/** Monotonic ms for the toast's hard limit; called from the Done click handler, never in render. */
const actionClock = () => performance.now();

export function ThreadActions({ threadId, title, status, kind }: { threadId: string; title: string; status: ThreadStatus; kind: ThreadKind }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ApiError["error"] | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const toastId = useRef(0);
  const doneRef = useRef<HTMLButtonElement>(null);
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
        const res = await markDoneAction(threadId, status);
        if (!res.ok) return setError(res.error);
        router.refresh();
        // The Done button leaves the page; focus goes to the status line, not into the toast, so the
        // 8 s timer runs unless the user moves to the toast.
        document.getElementById("thread-status")?.focus();
        toastId.current += 1;
        setToast({
          id: toastId.current,
          message: C.doneToast(title),
          onUndo: () => undo(res.eventId),
          undoLabel: `Undo done: ${title}`,
          actionAt,
          restoreFocus: () => document.getElementById("thread-status")?.focus(),
        });
      } catch {
        setError(failure("save_failed"));
      }
    });
  }

  async function undo(eventId: number) {
    setError(null);
    try {
      const res = await undoAction(threadId, eventId);
      if (!res.ok) {
        focusErrorOnRender.current = true;
        return setError(res.error);
      }
      // Done comes back after the refresh; until then focus waits on the status line, never <body>.
      focusDoneOnReturn.current = true;
      document.getElementById("thread-status")?.focus();
      router.refresh();
    } catch {
      focusErrorOnRender.current = true;
      setError(failure("save_failed"));
    }
  }

  useEffect(() => {
    if (!focusErrorOnRender.current) return;
    focusErrorOnRender.current = false;
    (bannerRef.current ?? document.getElementById("thread-status"))?.focus();
  }, [error]);

  const showDone = canMarkDone({ status, kind });
  useEffect(() => {
    if (focusDoneOnReturn.current && showDone && doneRef.current) {
      focusDoneOnReturn.current = false;
      doneRef.current.focus();
    }
  }, [showDone]);
  const showResolveDisabled = kind === "decision" && (status === "open" || status === "waiting" || status === "snoozed");

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

      {showDone || showResolveDisabled ? (
        <div className="flex flex-wrap items-center gap-3">
          {showDone ? (
            <Button ref={doneRef} onClick={done} disabled={pending}>
              {pending ? <Spinner /> : <Check aria-hidden strokeWidth={1.75} />}
              {C.done}
            </Button>
          ) : null}
          {showResolveDisabled ? (
            <>
              <Button variant="secondary" disabled aria-describedby="resolve-hint">
                {C.resolve}
              </Button>
              <p id="resolve-hint" className="text-small text-le-text-secondary">
                {C.resolveUnavailable}
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      <UndoToast toast={toast} onClose={(id) => setToast((t) => (t && t.id === id ? null : t))} />
    </div>
  );
}
