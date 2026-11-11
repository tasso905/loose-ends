"use client";
import { useEffect, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/auth/Spinner";
import { ErrorBanner, FieldError } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import type { ApiError } from "@/lib/errors";
import { ACTIONS_COPY as A } from "@/lib/threads/actions";
import { THREADS_COPY as C } from "@/lib/threads/view";
import { cn } from "@/lib/utils";

/**
 * The modal form shell for Mark waiting and Edit (S12), the same recipe as the Resolve sheet
 * (DESIGN_STANDARD "Resolve sheet"): a native modal <dialog>, 480 px; a bottom sheet below 768 px.
 * `h3` heading with `Cancel`, a page-level error inside it, the fields, then the submit button.
 * While the save is in flight nothing closes it (rule 10); Escape, Cancel and the scrim close it
 * otherwise. The form is mounted only while open, so each open starts from the thread's values.
 * The parent moves focus after it closes (`onClosed`).
 */
export function ActionSheet({
  open,
  title,
  submitLabel,
  pending,
  error,
  onClose,
  onSubmit,
  onClosed,
  children,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  pending: boolean;
  error: ApiError["error"] | null;
  onClose: () => void;
  onSubmit: () => void;
  /** Runs after the dialog has closed: the page behind a modal is inert until then. */
  onClosed?: () => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const ids = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // The first field (autoFocus is not reliable inside a dialog opened from an effect).
      d.querySelector<HTMLElement>("input, select, textarea")?.focus();
    } else if (!open && d.open) {
      d.close();
      onClosedRef.current?.();
    }
  }, [open]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const close = () => {
    if (!pending) onClose();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${ids}-title`}
      // Chrome cancels only one Escape without user activation, so `closedby="none"` stops close
      // requests natively while a save is in flight (as the Resolve sheet does).
      closedby={pending ? "none" : "closerequest"}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClose={() => {
        // A native close the sheet did not ask for: reopen while pending, otherwise tell the parent.
        if (!open) return;
        if (pending) ref.current?.showModal();
        else {
          onClose();
          onClosedRef.current?.();
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
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
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!pending) onSubmit();
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <h3 id={`${ids}-title`} className="text-h3 text-le-text">
              {title}
            </h3>
            <Button variant="ghost" size="small" onClick={close} disabled={pending}>
              {A.cancel}
            </Button>
          </div>
          {error ? (
            <div ref={errorRef} tabIndex={-1} className="focus-ring mt-4 rounded-card">
              <ErrorBanner
                action={
                  error.code === "invalid_transition" ? (
                    <Button variant="secondary" size="small" onClick={() => router.refresh()}>
                      {C.refresh}
                    </Button>
                  ) : undefined
                }
              >
                {error.message}
              </ErrorBanner>
            </div>
          ) : null}
          <div className="mt-4 space-y-5">{children}</div>
          <div className="mt-6 flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner /> : null}
              {submitLabel}
            </Button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}

/** A labelled field with its optional error, linked by aria-describedby (DESIGN_STANDARD field errors). */
export function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-label text-le-text">
        {label}
      </label>
      <div className="mt-2">{children}</div>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </div>
  );
}
