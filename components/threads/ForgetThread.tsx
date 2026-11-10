"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { forgetAction } from "@/app/threads/[id]/actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DATA_COPY as C } from "@/lib/account/copy";
import { apiError } from "@/lib/errors";

/**
 * `Forget permanently…` confirmation (D8), opened from Thread detail's `More actions` menu
 * (ThreadActions): what is deleted, what stays (the suppression hash, D29), and the optional
 * `Also delete source` when the thread still has one. Forget runs only from the dialog; on success
 * the thread is gone, so the page moves to Threads. Errors stay in the dialog (rule 10). Cancel
 * returns focus to `More actions` (the menu item that opened it is gone).
 */
export function ForgetDialog({
  threadId,
  hasSource,
  open,
  onClose,
  returnFocusRef,
}: {
  threadId: string;
  hasSource: boolean;
  open: boolean;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [alsoSource, setAlsoSource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The thread is gone though a file failed: closing the dialog can't return to this page.
  const rowsGone = useRef(false);

  // Each open starts unticked and without an error.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setAlsoSource(false);
      setError(null);
    }
  }

  function cancel() {
    onClose();
    if (rowsGone.current) router.replace("/threads");
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await forgetAction(threadId, hasSource && alsoSource);
        if (!res.ok) {
          if (res.error.code === "not_found") {
            // Already gone (another tab): nothing left to forget here.
            router.replace("/threads");
            return;
          }
          if (res.rowsGone) rowsGone.current = true;
          setError(res.error.message);
          return;
        }
        router.replace("/threads");
      } catch {
        setError(apiError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "save_failed").error.message);
      }
    });
  }

  return (
    <ConfirmDialog
      open={open}
      title={C.forgetTitle}
      deletes={hasSource && alsoSource ? [...C.forgetDeletes, `The source it came from: ${C.alsoDeleteSourceHint}`] : C.forgetDeletes}
      stays={C.forgetStays}
      confirmLabel={C.forgetButton}
      pending={pending}
      error={error}
      onCancel={cancel}
      onConfirm={confirm}
      onClosed={() => {
        if (!rowsGone.current) returnFocusRef.current?.focus();
      }}
    >
      {hasSource ? (
        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-body text-le-text">
          <input
            type="checkbox"
            checked={alsoSource}
            disabled={pending}
            onChange={(e) => setAlsoSource(e.target.checked)}
            className="mt-1 size-4 accent-(--le-danger-fg)"
          />
          <span>{C.alsoDeleteSource}</span>
        </label>
      ) : null}
    </ConfirmDialog>
  );
}
