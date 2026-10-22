"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitPaste } from "@/app/add/actions";
import { Spinner } from "@/components/auth/Spinner";
import { useHydrated } from "@/components/auth/useHydrated";
import { ErrorBanner, FieldError } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { normalizeLineBreaks, pasteCounter, TITLE_MAX_CHARS } from "@/lib/capture/pasteInput";
import { TitleField, WrittenOnField } from "./SourceFields";
import { apiError, type ApiError, type InputField } from "@/lib/errors";

type Failure = ApiError["error"];

/**
 * Paste mode (F2; SITE_CONTRACT §2.2). The textarea is uncontrolled and never has `maxLength`, so
 * a long paste is kept whole and rejected with the over-limit copy, never silently truncated. The
 * form submits through a transition (not a form action), so React does not reset the fields and a
 * failed submit keeps the user's text.
 */
export function PasteForm({ today }: { today: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [length, setLength] = useState(0);
  const [blank, setBlank] = useState(true);
  const [writtenOn, setWrittenOn] = useState(today);
  const [writtenOnSet, setWrittenOnSet] = useState(false);
  const [titleLength, setTitleLength] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [failedField, setFailedField] = useState<InputField | null>(null);
  const [pending, startTransition] = useTransition();

  // Text typed or pasted before hydration is already in the field: count it once.
  useEffect(() => {
    // SITE_CONTRACT §3.2: focus the first relevant field on /add. Not when the user has already
    // moved focus somewhere else before hydration.
    const active = document.activeElement;
    if (!active || active === document.body) textRef.current?.focus();
    const value = textRef.current?.value ?? "";
    if (value.length > 0) {
      setLength(normalizeLineBreaks(value).length);
      setBlank(value.trim() === "");
    }
  }, []);

  const counter = pasteCounter(length);
  const overLimit = counter.over ? apiError("input_too_long", { n: length }).error.message : null;
  const serverField = (f: InputField) => (failure && failedField === f ? failure.message : null);
  const fieldError = overLimit ?? serverField("text");
  // A long title is reported, never cut off (no maxLength on the input).
  const titleError =
    titleLength > TITLE_MAX_CHARS ? apiError("invalid_input", { field: "title" }).error.message : serverField("title");
  const dateError = serverField("written_on");
  const banner = failure && !failedField ? failure : null;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || counter.over || titleLength > TITLE_MAX_CHARS) return;
    const formData = new FormData(e.currentTarget);
    setFailure(null);
    setFailedField(null);
    startTransition(async () => {
      if (!navigator.onLine) {
        setFailure(apiError("offline").error);
        return;
      }
      try {
        const result = await submitPaste(formData);
        if (result.ok) {
          // The source and its extraction exist (rule 10): only now leave for the progress page.
          router.push(`/review/${result.extractionId}`);
          return;
        }
        if (result.signedOut) {
          router.push(`/sign-in?next=${encodeURIComponent("/add")}`);
          return;
        }
        setFailure(result.error);
        setFailedField(result.field ?? null);
      } catch {
        setFailure(apiError(navigator.onLine ? "save_failed" : "offline").error);
      }
    });
  }

  const describedBy = ["text-hint", "text-counter", fieldError ? "text-error" : null]
    .filter(Boolean)
    .join(" ");

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
        <label htmlFor="text" className="block text-body-strong text-le-text">
          Paste a message or document
        </label>
        <p id="text-hint" className="mt-1 text-small text-le-text-secondary">
          Up to 30,000 characters.
        </p>
        <Textarea
          ref={textRef}
          id="text"
          name="text"
          spellCheck={false}
          className="mt-3 min-h-60 p-4"
          onInput={(e) => {
            setLength(normalizeLineBreaks(e.currentTarget.value).length);
            setBlank(e.currentTarget.value.trim() === "");
            if (failedField === "text") setFailure(null);
          }}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={describedBy}
        />
        {/* Always in the DOM so screen readers hear it politely once it appears at 27,000. */}
        <p
          id="text-counter"
          aria-live="polite"
          className={`mt-1 text-right text-small tabular-nums ${counter.over ? "text-le-danger-fg" : "text-le-text-secondary"}`}
        >
          {counter.visible ? counter.text : null}
        </p>
        {fieldError ? <FieldError id="text-error">{fieldError}</FieldError> : null}
      </div>

      <WrittenOnField
        today={today}
        value={writtenOn}
        set={writtenOnSet}
        error={dateError}
        onChange={(v) => {
          setWrittenOn(v);
          setWrittenOnSet(true);
          if (failedField === "written_on") setFailure(null);
        }}
      />

      <TitleField
        error={titleError}
        onInput={(n) => {
          setTitleLength(n);
          if (failedField === "title") setFailure(null);
        }}
      />

      <Button type="submit" disabled={!hydrated || pending || blank || counter.over || titleLength > TITLE_MAX_CHARS}>
        {pending ? <Spinner /> : null}
        Review source
      </Button>
    </form>
  );
}
