"use client";
import { useActionState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { completeOnboarding, type OnboardingFailure } from "@/app/onboarding/actions";
import { Spinner } from "@/components/auth/Spinner";
import { useHydrated } from "@/components/auth/useHydrated";
import { ErrorBanner, FieldError } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { ONBOARDING_COPY as C, SIGN_IN_COPY } from "@/lib/auth/copy";

/** `answer` is what was submitted, restored as defaultValue after React 19's post-action reset (B2). */
type State = { failure: OnboardingFailure | null; intent: "save" | "skip"; answer: string };

const FIELD: Partial<Record<OnboardingFailure, string>> = { too_many: C.tooMany, too_long: C.tooLong };
const BANNER: Partial<Record<OnboardingFailure, string>> = { save_failed: C.saveFailed, offline: C.offline };

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
const noSubscribe = () => () => {};

export function OnboardingForm({ next, email }: { next: string; email: string | null }) {
  const router = useRouter();
  // The answer is uncontrolled so text typed before hydration survives (R2); see State.answer.
  const hydrated = useHydrated();
  // F1: timezone detected from the browser (editable later in Settings). Empty on the server.
  const timezone = useSyncExternalStore(noSubscribe, browserTimeZone, () => "");

  const [state, formAction, pending] = useActionState<State, FormData>(async (_prev, formData) => {
    const intent = formData.get("intent") === "skip" ? "skip" : "save";
    const answer = String(formData.get("answer") ?? "");
    // Read the zone at submit time too, so it can never be lost to a reset or a slow effect.
    formData.set("timezone", browserTimeZone());
    if (!navigator.onLine) return { failure: "offline", intent, answer };
    try {
      const result = await completeOnboarding(formData);
      if (!result.ok) return { failure: result.code, intent, answer };
      router.replace(result.redirectTo);
      return { failure: null, intent, answer };
    } catch {
      return { failure: navigator.onLine ? "save_failed" : "offline", intent, answer };
    }
  }, { failure: null, intent: "save", answer: "" });

  const fieldError = state.failure ? FIELD[state.failure] : undefined;
  const banner = state.failure ? BANNER[state.failure] : undefined;

  return (
    <form action={formAction} aria-busy={pending || undefined} className="mt-8 space-y-5">
      <input type="hidden" name="next" value={next} readOnly />
      <input type="hidden" name="timezone" value={timezone} readOnly />
      {banner ? (
        <ErrorBanner
          action={
            <Button type="submit" name="intent" value={state.intent} variant="secondary" size="small" disabled={pending}>
              {SIGN_IN_COPY.tryAgain}
            </Button>
          }
        >
          {banner}
        </ErrorBanner>
      ) : null}
      <div>
        <label htmlFor="answer" className="block text-body-strong text-le-text">
          {C.fieldLabel}
        </label>
        <p id="answer-hint" className="mt-1 text-small text-le-text-secondary">
          {C.hint}
          {email ? ` ${C.emailAlwaysIncluded(email)}` : null}
        </p>
        <Textarea
          id="answer"
          name="answer"
          rows={3}
          autoComplete="off"
          defaultValue={state.answer}
          className="mt-3"
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? "answer-hint answer-error" : "answer-hint"}
        />
        {fieldError ? <FieldError id="answer-error">{fieldError}</FieldError> : null}
      </div>
      <div className="flex flex-wrap gap-4">
        <Button type="submit" name="intent" value="save" disabled={pending || !hydrated}>
          {pending ? <Spinner /> : null}
          {C.save}
        </Button>
        <Button type="submit" name="intent" value="skip" variant="secondary" disabled={pending || !hydrated}>
          {C.skip}
        </Button>
      </div>
    </form>
  );
}
