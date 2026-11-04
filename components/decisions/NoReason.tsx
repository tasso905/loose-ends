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
 * moves to it: the caller renders the reason and focuses it when it mounts (`useFocusOnMount`), so
 * focus never depends on a frame landing after React commits. Used by Ask why
 * and by the Decision block on Thread detail (§2.7 as amended by D58). Cancel closes the field and
 * returns focus to `Add a reason now`. Limits and the blank check match Resolve (2,000 characters,
 * counted as characters).
 */
/**
 * Focus for the reason a NoReason form just added. `request(id)` before showing it; spread
 * `ref(id)` on the reason's element. The element is focused in the commit that inserts it, so
 * focus moves to it however late React renders (a requestAnimationFrame could fire before the
 * element existed, leaving focus on <body>: the intermittent CI failure fixed Nov 2). `focus(id)`
 * moves it again later (after a refresh) only if focus was lost to <body> meanwhile.
 */
export function useFocusOnMount() {
  // One stable object per component: its methods close over this instance's state only.
  const [api] = useState(() => {
    let pending: string | null = null;
    const els = new Map<string, HTMLElement>();
    const refs = new Map<string, (el: HTMLElement | null) => void>();
    return {
      request(id: string) {
        pending = id;
      },
      ref(id: string) {
        let r = refs.get(id);
        if (!r) {
          r = (el: HTMLElement | null) => {
            if (!el) return void els.delete(id);
            els.set(id, el);
            if (pending === id) {
              pending = null;
              el.focus();
            }
          };
          refs.set(id, r);
        }
        return r;
      },
      refocus(id: string) {
        const el = els.get(id) ?? document.getElementById(`reason-${id}`);
        const active = document.activeElement;
        if (el && el.isConnected && (!active || active === document.body)) el.focus();
      },
    };
  });
  return api;
}

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
        // The caller shows the reason and moves focus to it as it mounts (useFocusOnMount).
        onAdded(res.reason);
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
