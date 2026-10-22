"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Undo2 } from "lucide-react";
import { Spinner } from "@/components/auth/Spinner";
import { cn } from "@/lib/utils";

/**
 * The shared undo toast (DESIGN_STANDARD "Undo toast" and product moments; D8). One toast at a time:
 * a new `toast` (new id) replaces the old one and restarts the timer. It stays 8 s; the timer pauses
 * while the toast is hovered or holds focus. No countdown bar. It enters 8px up + fade at
 * --dur-base; under reduced motion the global rule removes the movement.
 *
 * The live region (role=status) is always mounted, so a screen reader announces the message when it
 * appears. Errors never go in a toast (SITE_CONTRACT §2.13): the caller shows them on the page.
 * The server decides whether an undo is still valid: 8 s + 4 s grace (D44 a). So the toast never
 * outlives that window: whatever the pauses, it closes TOAST_HARD_LIMIT_MS after the user acted
 * (`actionAt`, user decision (a), Oct 21), and an Undo it offers is always one the server accepts.
 * The 8 s countdown and the hover/focus pause work as before inside that limit.
 */

export const TOAST_MS = 8_000;
/** The toast closes this long after the action even while paused (= UNDO_WINDOW_MS + UNDO_GRACE_MS). */
export const TOAST_HARD_LIMIT_MS = 12_000;

export interface ToastData {
  /** Changes for each new toast. */
  id: number;
  message: string;
  /** Runs the undo; the toast closes when it settles (success or failure is the caller's to show). */
  onUndo: () => Promise<void>;
  /** Accessible name of the Undo button, when "Undo" alone is ambiguous. */
  undoLabel?: string;
  /** performance.now() when the user acted (before the request); the hard limit counts from here. */
  actionAt?: number;
  /** Where focus goes if the hard limit closes the toast while it holds focus (never <body>). */
  restoreFocus?: () => void;
}

export function UndoToast({ toast, onClose }: { toast: ToastData | null; onClose: (id: number) => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 max-md:bottom-20"
    >
      {toast ? <ToastBody key={toast.id} toast={toast} onClose={onClose} /> : null}
    </div>
  );
}

function ToastBody({ toast, onClose }: { toast: ToastData; onClose: (id: number) => void }) {
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const remaining = useRef(TOAST_MS);
  const startedAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  const busyRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Hard limit: not paused by hover or focus. An Undo already sent is left to finish.
  useEffect(() => {
    const actionAt = toast.actionAt ?? performance.now();
    const hard = setTimeout(() => {
      if (busyRef.current) return;
      if (rootRef.current?.contains(document.activeElement)) toast.restoreFocus?.();
      onClose(toast.id);
    }, Math.max(0, actionAt + TOAST_HARD_LIMIT_MS - performance.now()));
    return () => clearTimeout(hard);
  }, [onClose, toast]);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (startedAt.current !== null) remaining.current -= performance.now() - startedAt.current;
    startedAt.current = null;
  }, []);

  const start = useCallback(() => {
    if (timer.current || hovered.current || focused.current) return;
    startedAt.current = performance.now();
    timer.current = setTimeout(() => onClose(toast.id), Math.max(0, remaining.current));
  }, [onClose, toast.id]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    start();
    return () => {
      cancelAnimationFrame(raf);
      stop();
    };
  }, [start, stop]);

  const pause = (which: typeof hovered) => {
    which.current = true;
    stop();
  };
  const resume = (which: typeof hovered) => {
    which.current = false;
    start();
  };

  async function undo() {
    stop();
    busyRef.current = true;
    setBusy(true);
    try {
      await toast.onUndo();
    } finally {
      onClose(toast.id);
    }
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        "pointer-events-auto flex max-w-narrow items-center gap-4 rounded-card bg-le-text py-2 pr-2 pl-4 text-small text-le-bg shadow-(--le-shadow-float)",
        "transition-[opacity,translate] duration-(--le-dur-base) ease-(--le-ease-out)",
        shown ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
      onMouseEnter={() => pause(hovered)}
      onMouseLeave={() => resume(hovered)}
      onFocus={() => pause(focused)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume(focused);
      }}
    >
      <p className="min-w-0 flex-1">{toast.message}</p>
      <button
        type="button"
        onClick={undo}
        disabled={busy}
        aria-label={toast.undoLabel}
        // On the inverted toast the ring uses --le-accent-subtle so it keeps 3:1 against --le-text.
        className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--le-accent-subtle) inline-flex h-8 shrink-0 items-center gap-1 rounded-control px-3 text-label text-le-accent-subtle hover:enabled:bg-le-text-secondary disabled:cursor-not-allowed disabled:opacity-50 max-md:h-11 [&_svg]:size-4"
      >
        {busy ? <Spinner /> : <Undo2 aria-hidden strokeWidth={1.75} />}
        Undo
      </button>
    </div>
  );
}
