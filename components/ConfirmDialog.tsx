"use client";
import { useEffect, useId, useRef } from "react";
import { Trash2 } from "lucide-react";
import { Spinner } from "@/components/auth/Spinner";
import { ErrorBanner } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { DATA_COPY as C } from "@/lib/account/copy";
import { cn } from "@/lib/utils";

/**
 * Confirmation for irreversible actions (D8; SITE_CONTRACT §3.6; DESIGN_STANDARD "Confirmation
 * dialogs"): an `h3` naming the action, a plain list of exactly what is deleted (and what stays),
 * Cancel (secondary, left) and the destructive button (right) with the full action name. No undo.
 * A native modal <dialog> (focus trap, Escape); a bottom sheet below 768 px like the Resolve sheet.
 * Focus starts on Cancel, the safe choice. While the action runs, nothing closes it, and an error
 * stays inside it (rule 10); the parent closes it only after the server confirms.
 */
export function ConfirmDialog({
  open,
  title,
  deletes,
  stays,
  confirmLabel,
  pending,
  error,
  confirmDisabled,
  onCancel,
  onConfirm,
  children,
}: {
  open: boolean;
  title: string;
  deletes: readonly string[];
  stays?: readonly string[];
  confirmLabel: string;
  pending: boolean;
  error: string | null;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const ids = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      cancelRef.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  const cancel = () => {
    if (!pending) onCancel();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-body`}
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      className={cn(
        "bg-le-surface-raised text-le-text shadow-(--le-shadow-modal) backdrop:bg-(--le-scrim)",
        "m-auto w-full max-w-narrow rounded-modal p-0",
        "max-md:mb-0 max-md:max-h-[85vh] max-md:max-w-none max-md:rounded-b-none",
      )}
    >
      {open ? (
        <form
          className="p-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pending && !confirmDisabled) onConfirm();
          }}
        >
          <h3 id={`${ids}-title`} className="text-h3 text-le-text">
            {title}
          </h3>
          {error ? (
            <div className="mt-4">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          ) : null}
          <div id={`${ids}-body`} className="mt-4 space-y-4 text-body text-le-text">
            <div>
              <p className="text-body-strong">{C.willDelete}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {deletes.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
            {stays && stays.length > 0 ? (
              <div>
                <p className="text-body-strong">{C.willStay}</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-le-text-secondary">
                  {stays.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-le-text-secondary">{C.cannotUndo}</p>
          </div>
          {children ? <div className="mt-5">{children}</div> : null}
          <div className="mt-6 flex flex-wrap justify-between gap-3">
            <Button ref={cancelRef} variant="secondary" onClick={cancel} disabled={pending}>
              {C.cancel}
            </Button>
            <Button type="submit" variant="destructive" disabled={pending || confirmDisabled}>
              {pending ? <Spinner /> : <Trash2 aria-hidden strokeWidth={1.75} />}
              {confirmLabel}
            </Button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}
