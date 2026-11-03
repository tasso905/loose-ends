"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { addReasonAction } from "@/app/decisions/actions";
import { Spinner } from "@/components/auth/Spinner";
import { FieldError } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { DECISIONS_COPY as D } from "@/lib/decisions/copy";
import { apiError } from "@/lib/errors";
import { clampChars, DECISION_REASON_MAX, isBlankText } from "@/lib/threads/transition";

/**
 * The no-reason state (SITE_CONTRACT §2.11, CONTENT_MODEL §10, D58): says so plainly and offers
 * `Add a reason now`, which opens an inline field. Save sends the text exactly as typed (rule 5);
 * the reason appears only after the server confirms (rule 10), in the You wrote voice, and focus
 * moves to the element with id `reason-<decisionId>`, which the caller renders. Used by Ask why
 * and by the Decision block on Thread detail (§2.7 as amended by D58). Cancel closes the field and
 * returns focus to `Add a reason now`. Limits and the blank check match Resolve (2,000 characters,
 * counted as characters).
 */
export function NoReason({ decisionId, onAdded }: { decisionId: string; onAdded: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fieldId = useId();
  const errorId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const focusOpen = useRef(false);

  useEffect(() => {
    if (open) fieldRef.current?.focus();
    else if (focusOpen.current) {
      focusOpen.current = false;
      openRef.current?.focus();
    }
  }, [open]);

  function save() {
    if (pending) return;
    if (isBlankText(text)) {
      setError(D.reasonRequired);
      fieldRef.current?.focus();
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await addReasonAction(decisionId, text);
        if (!res.ok) {
          setError(res.error.message);
          fieldRef.current?.focus();
          return;
        }
        onAdded(res.reason);
        // The card re-renders with the reason; focus follows it so it is announced and not lost.
        // The re-render can land after the next frame, so wait (up to about half a second) for it.
        const focusReason = (frames: number) => {
          const el = document.getElementById(`reason-${decisionId}`);
          if (el) el.focus();
          else if (frames > 0) requestAnimationFrame(() => focusReason(frames - 1));
        };
        requestAnimationFrame(() => focusReason(30));
      } catch {
        setError(apiError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "save_failed").error.message);
      }
    });
  }

  return (
    <div>
      <p className="text-body text-le-text-secondary">{D.noReason}</p>
      {open ? (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label htmlFor={fieldId} className="block text-label text-le-text">
            {D.addReasonLabel}
          </label>
          <Textarea
            ref={fieldRef}
            id={fieldId}
            value={text}
            onChange={(e) => setText(clampChars(e.target.value, DECISION_REASON_MAX))}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="mt-2"
          />
          {error ? <FieldError id={errorId}>{error}</FieldError> : null}
          <div className="mt-3 flex flex-wrap gap-3">
            <Button type="submit" size="small" disabled={pending}>
              {pending ? <Spinner /> : null}
              {D.save}
            </Button>
            <Button
              variant="ghost"
              size="small"
              disabled={pending}
              onClick={() => {
                focusOpen.current = true;
                setError(null);
                setOpen(false);
              }}
            >
              {D.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <Button ref={openRef} variant="secondary" size="small" className="mt-3" onClick={() => setOpen(true)}>
          {D.addReason}
        </Button>
      )}
    </div>
  );
}
