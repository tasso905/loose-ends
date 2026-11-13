"use client";
import { useContext, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitQuickAdd } from "@/app/add/actions";
import { Spinner } from "@/components/auth/Spinner";
import { useHydrated } from "@/components/auth/useHydrated";
import { ErrorBanner, FieldError } from "@/components/Notice";
import { ActionHostContext, ActionHostProvider } from "@/components/threads/ActionHost";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeLineBreaks } from "@/lib/capture/pasteInput";
import { QUICK_ADD_COPY as C, quickAddFieldError } from "@/lib/capture/quickAddInput";
import { apiError, type ApiError } from "@/lib/errors";
import { handOffQuickAddToast, showQuickAddToast } from "./quickAddToast";

type Failure = ApiError["error"];

/**
 * Quick add mode (F4; SITE_CONTRACT §2.2, §3.1; D9). One line; `Add` sends it through the same
 * pipeline as paste. When every proposal became a thread, the user stays here: the field clears and
 * the 8 s undo toast names what was added. If any Medium or Low proposal is waiting, the user goes to
 * the review tray for those, and the toast for any created thread follows them there. Nothing claims
 * success before the server's result (rule 10).
 */
export function QuickAddForm() {
  return (
    <ActionHostProvider>
      <QuickAddFields />
    </ActionHostProvider>
  );
}

function QuickAddFields() {
  const router = useRouter();
  const host = useContext(ActionHostContext);
  const hydrated = useHydrated();
  const inputRef = useRef<HTMLInputElement>(null);
  const [length, setLength] = useState(0);
  const [blank, setBlank] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [fieldFailure, setFieldFailure] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    // SITE_CONTRACT §3.2: focus the first relevant field on /add, unless the user already moved on.
    const active = document.activeElement;
    if (!active || active === document.body) inputRef.current?.focus();
    const value = inputRef.current?.value ?? "";
    if (value.length > 0) {
      setLength(normalizeLineBreaks(value).length);
      setBlank(value.trim() === "");
    }
  }, []);

  const overLimit = quickAddFieldError(length);
  const fieldError = overLimit ?? (fieldFailure && failure ? failure.message : null);
  const banner = failure && !fieldFailure ? failure : null;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || overLimit || blank) return;
    const formData = new FormData(e.currentTarget);
    setFailure(null);
    setFieldFailure(false);
    startTransition(async () => {
      if (!navigator.onLine) {
        setFailure(apiError("offline").error);
        return;
      }
      try {
        const result = await submitQuickAdd(formData);
        if (!result.ok) {
          if (result.signedOut) {
            router.push(`/sign-in?next=${encodeURIComponent("/add?mode=quick")}`);
            return;
          }
          setFailure(result.error);
          setFieldFailure(result.field === "text");
          return;
        }
        const arrivedAt = performance.now();
        if (result.route === "review") {
          handOffQuickAddToast(result.extractionId, result.created, arrivedAt);
          router.push(`/review/${result.extractionId}`);
          return;
        }
        // The threads exist (rule 10): clear the line for the next one and offer Undo.
        if (inputRef.current) inputRef.current.value = "";
        setLength(0);
        setBlank(true);
        if (host) showQuickAddToast(host, result.created, arrivedAt, () => inputRef.current?.focus());
      } catch {
        setFailure(apiError(navigator.onLine ? "save_failed" : "offline").error);
      }
    });
  }

  const describedBy = ["quick-hint", fieldError ? "quick-error" : null].filter(Boolean).join(" ");

  return (
    <form method="post" onSubmit={onSubmit} aria-busy={pending || undefined} className="mt-6 space-y-5">
      {banner ? (
        <ErrorBanner
          action={
            banner.retryable ? (
              <Button type="submit" variant="secondary" size="small" disabled={pending}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {banner.message}
        </ErrorBanner>
      ) : null}

      <div>
        <label htmlFor="quick-text" className="sr-only">
          {C.label}
        </label>
        <p id="quick-hint" className="text-small text-le-text-secondary">
          {C.hint}
        </p>
        <Input
          ref={inputRef}
          id="quick-text"
          name="text"
          type="text"
          autoComplete="off"
          placeholder={C.placeholder}
          className="mt-3"
          onInput={(e) => {
            setLength(normalizeLineBreaks(e.currentTarget.value).length);
            setBlank(e.currentTarget.value.trim() === "");
            if (fieldFailure) {
              setFailure(null);
              setFieldFailure(false);
            }
          }}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={describedBy}
        />
        {fieldError ? <FieldError id="quick-error">{fieldError}</FieldError> : null}
      </div>

      <Button type="submit" disabled={!hydrated || pending || blank || overLimit !== null}>
        {pending ? <Spinner /> : null}
        {C.submit}
      </Button>
    </form>
  );
}
