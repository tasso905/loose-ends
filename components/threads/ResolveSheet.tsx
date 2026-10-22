"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resolveAction } from "@/app/threads/[id]/actions";
import { Spinner } from "@/components/auth/Spinner";
import { ErrorBanner, FieldError } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { apiError, type ApiError } from "@/lib/errors";
import type { Resolution, ThreadKind, ThreadStatus } from "@/lib/schemas";
import { RESOLVE_COPY as R, resolutionsFor, type ResolveInput } from "@/lib/threads/resolve";
import { DECISION_CHOICE_MAX, DECISION_REASON_MAX } from "@/lib/threads/transition";
import { THREADS_COPY as C } from "@/lib/threads/view";
import { cn } from "@/lib/utils";

export interface Resolved {
  eventId: number;
  resolution: Resolution;
  /** performance.now() when Save or Skip was pressed: the toast's 11 s limit counts from here (D51). */
  actionAt: number;
}

/**
 * F11 Resolve sheet (SITE_CONTRACT §2.10 and §3.1, CONTENT_MODEL §9, DESIGN_STANDARD "Resolve
 * sheet"): a modal dialog (480 px; a bottom sheet below 768 px). Three radio cards: Done, Decided,
 * Not needed (a decision thread offers Decided and Not needed, D6). Decided adds "What did you
 * decide?" and "Want me to remember why?". Save keeps the reason; Skip is one tap and saves without
 * it, and nothing asks again. Text is sent exactly as typed (rule 5). The sheet closes only after
 * the server confirms (rule 10); errors stay in the sheet. Escape, Cancel and the scrim close it,
 * and the parent returns focus to Resolve….
 */
export function ResolveSheet({
  threadId,
  status,
  kind,
  open,
  onClose,
  onResolved,
}: {
  threadId: string;
  status: ThreadStatus;
  kind: ThreadKind;
  open: boolean;
  onClose: () => void;
  onResolved: (r: Resolved) => void;
}) {
  const router = useRouter();
  const ids = useId();
  const titleId = `${ids}-title`;
  const choiceId = `${ids}-choice`;
  const choiceErrorId = `${ids}-choice-error`;
  const reasonId = `${ids}-reason`;
  const options = resolutionsFor(kind);
  const initial: Resolution = options.includes("done") ? "done" : "decided";

  const dialogRef = useRef<HTMLDialogElement>(null);
  const choiceRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [resolution, setResolution] = useState<Resolution>(initial);
  const [choice, setChoice] = useState("");
  const [reason, setReason] = useState("");
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError["error"] | null>(null);
  const [pending, startTransition] = useTransition();
  // Set when the user picks Decided: focus moves to its first field once it renders (§3.2).
  const focusDecided = useRef(false);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      setResolution(initial);
      setChoice("");
      setReason("");
      setChoiceError(null);
      setError(null);
      d.showModal();
      // The selected card, or the decision field when Decided is preselected (decision threads).
      if (initial === "decided") choiceRef.current?.focus();
      else d.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus();
    } else if (!open && d.open) {
      d.close();
    }
    // `initial` depends only on the thread kind, which does not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (resolution !== "decided" || !focusDecided.current) return;
    focusDecided.current = false;
    // The reason field (§3.2) once a decision is written; until then the decision itself.
    (choiceRef.current?.value.trim() ? reasonRef.current : choiceRef.current)?.focus();
  }, [resolution]);

  function close() {
    if (!pending) onClose();
  }

  function save(keepReason: boolean) {
    setError(null);
    setChoiceError(null);
    if (resolution === "decided" && choice.trim() === "") {
      setChoiceError(R.choiceRequired);
      choiceRef.current?.focus();
      return;
    }
    const input: ResolveInput =
      resolution === "decided"
        ? { threadId, fromStatus: status, resolution, choice, reason: keepReason && reason.trim() !== "" ? reason : null }
        : { threadId, fromStatus: status, resolution };
    const actionAt = performance.now();
    startTransition(async () => {
      try {
        const res = await resolveAction(input);
        if (!res.ok) {
          if (res.field === "choice") {
            setChoiceError(res.error.message);
            choiceRef.current?.focus();
          } else {
            setError(res.error);
          }
          return;
        }
        onResolved({ eventId: res.eventId, resolution: res.resolution, actionAt });
      } catch {
        setError(apiError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "save_failed").error);
      }
    });
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        // A click on the scrim (outside the panel) closes the sheet.
        if (e.target === e.currentTarget) close();
      }}
      className={cn(
        "bg-le-surface-raised text-le-text shadow-(--le-shadow-modal) backdrop:bg-(--le-scrim)",
        "m-auto w-full max-w-narrow rounded-modal p-0",
        // Below 768 px: a bottom sheet, at most 85% of the viewport tall (DESIGN_STANDARD, §3.4).
        "max-md:mb-0 max-md:max-h-[85vh] max-md:max-w-none max-md:rounded-b-none",
      )}
    >
      <form
        className="p-6"
        onSubmit={(e) => {
          e.preventDefault();
          save(true);
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <h3 id={titleId} className="text-h3 text-le-text">
            {R.heading}
          </h3>
          <Button variant="ghost" size="small" onClick={close} disabled={pending}>
            {R.cancel}
          </Button>
        </div>

        {error ? (
          <div className="mt-4">
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

        <div role="radiogroup" aria-labelledby={titleId} className={cn("mt-4 grid gap-3", options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
          {options.map((o) => (
            <label
              key={o}
              className={cn(
                "relative flex min-h-11 cursor-pointer items-center rounded-card border border-le-border bg-le-surface p-4 text-body-strong text-le-text",
                "has-checked:border-le-accent has-checked:bg-le-accent-subtle has-checked:ring-1 has-checked:ring-le-accent",
                "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-le-accent",
              )}
            >
              <input
                type="radio"
                name="resolution"
                value={o}
                checked={resolution === o}
                onChange={() => {
                  setChoiceError(null);
                  if (o === "decided") focusDecided.current = true;
                  setResolution(o);
                }}
                className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-card focus-visible:outline-none"
              />
              {R.options[o]}
            </label>
          ))}
        </div>

        {resolution === "decided" ? (
          <div className="mt-6 animate-fade-in space-y-5">
            <div>
              <label htmlFor={choiceId} className="block text-label text-le-text">
                {R.choiceLabel}
              </label>
              <Input
                ref={choiceRef}
                id={choiceId}
                value={choice}
                maxLength={DECISION_CHOICE_MAX}
                onChange={(e) => setChoice(e.target.value)}
                aria-invalid={choiceError ? true : undefined}
                aria-describedby={choiceError ? choiceErrorId : undefined}
                className="mt-2"
              />
              {choiceError ? <FieldError id={choiceErrorId}>{choiceError}</FieldError> : null}
            </div>
            <div>
              <label htmlFor={reasonId} className="block text-label text-le-text">
                {R.reasonLabel}
              </label>
              <Textarea
                ref={reasonRef}
                id={reasonId}
                value={reason}
                maxLength={DECISION_REASON_MAX}
                onChange={(e) => setReason(e.target.value)}
                className="mt-2"
              />
            </div>
          </div>
        ) : null}

        <div className="mt-6 grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={() => save(false)} disabled={pending}>
            {R.skip}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner /> : null}
            {R.save}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
