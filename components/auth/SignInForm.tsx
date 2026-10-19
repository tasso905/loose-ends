"use client";
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { sendMagicLink } from "@/app/sign-in/actions";
import { Spinner } from "@/components/auth/Spinner";
import { useHydrated } from "@/components/auth/useHydrated";
import { ErrorBanner, FieldError } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SIGN_IN_COPY as C } from "@/lib/auth/copy";
import type { SendLinkFailure } from "@/lib/auth/signIn";
import { createClient } from "@/lib/supabase/client";

/** `email` is what was submitted: React 19 resets the form after an action, back to defaultValue. */
type State = { failure: SendLinkFailure | null; email: string };

/** Failures shown under the field. Offline is a banner with the §2.13 "Try again" action. */
const FIELD_MESSAGES: Partial<Record<SendLinkFailure, string>> = {
  invalid_email: C.invalidEmail,
  rate_limited: C.rateLimited,
  send_failed: C.sendFailed,
};

export function SignInForm({ next, googleEnabled }: { next: string; googleEnabled: boolean }) {
  const router = useRouter();
  // The email input is uncontrolled, so text typed or autofilled before hydration survives (R2).
  // Each result carries the submitted value back as defaultValue, so the post-action reset
  // restores it instead of wiping it (B2).
  const hydrated = useHydrated();
  const [state, formAction, pending] = useActionState<State, FormData>(async (_prev, formData) => {
    const email = String(formData.get("email") ?? "");
    if (typeof navigator !== "undefined" && !navigator.onLine) return { failure: "offline", email };
    try {
      const result = await sendMagicLink(formData);
      if (!result.ok) return { failure: result.code, email };
      // Supabase has confirmed the request (rule 10); only now show the check-your-email state.
      router.replace(result.redirectTo);
      return { failure: null, email };
    } catch {
      return { failure: navigator.onLine ? "send_failed" : "offline", email };
    }
  }, { failure: null, email: "" });

  const failure = state.failure;
  const fieldMessage = failure ? FIELD_MESSAGES[failure] : undefined;
  const errorId = "email-error";

  return (
    <div className="space-y-5">
      <form action={formAction} noValidate className="space-y-5">
        <input type="hidden" name="next" value={next} readOnly />
        {failure === "offline" ? (
          <ErrorBanner
            action={
              <Button type="submit" variant="secondary" size="small" disabled={pending}>
                {C.tryAgain}
              </Button>
            }
          >
            {C.offline}
          </ErrorBanner>
        ) : null}
        <div>
          <label htmlFor="email" className="block text-body-strong text-le-text">
            {C.emailLabel}
          </label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            defaultValue={state.email}
            className="mt-3"
            aria-invalid={failure === "invalid_email" || undefined}
            aria-describedby={fieldMessage ? errorId : undefined}
          />
          {fieldMessage ? <FieldError id={errorId}>{fieldMessage}</FieldError> : null}
        </div>
        <Button type="submit" disabled={pending || !hydrated} aria-busy={pending || undefined} className="w-full">
          {pending ? <Spinner /> : null}
          {C.sendButton}
        </Button>
        <noscript>
          <p className="text-small text-le-text-secondary">{C.noScript}</p>
        </noscript>
      </form>
      {googleEnabled ? <GoogleButton next={next} /> : null}
    </div>
  );
}

/** Google identity sign-in, `openid email profile` only (PRD F1). Hidden unless configured. */
function GoogleButton({ next }: { next: string }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function start() {
    setPending(true);
    setFailed(false);
    const redirectTo = new URL("/auth/callback", window.location.origin);
    if (next !== "/today") redirectTo.searchParams.set("next", next);
    const { error } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectTo.toString(), scopes: "openid email profile" },
    });
    // On success the browser is already navigating to Google.
    if (error) {
      setPending(false);
      setFailed(true);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-center text-small text-le-text-secondary">{C.orDivider}</p>
      {failed ? <ErrorBanner>{C.oauthFailed}</ErrorBanner> : null}
      <Button variant="secondary" className="w-full" disabled={pending} aria-busy={pending || undefined} onClick={start}>
        {pending ? <Spinner /> : null}
        {C.googleButton}
      </Button>
    </div>
  );
}
