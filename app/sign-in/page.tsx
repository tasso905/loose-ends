import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { AuthPage } from "@/components/auth/AuthPage";
import { SignInForm } from "@/components/auth/SignInForm";
import { AuthNotices } from "@/components/auth/Notices";
import { ErrorBanner } from "@/components/Notice";
import { SIGN_IN_COPY as C, signInErrorMessage } from "@/lib/auth/copy";
import { safeNext, signInPath } from "@/lib/auth/next";
import { SIGN_IN_EMAIL_COOKIE } from "@/lib/auth/signIn";
import { isGoogleSignInEnabled } from "@/lib/supabase/env";

export const metadata: Metadata = { title: "Sign in" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/** Sign in (SITE_CONTRACT §2.0, CONTENT_MODEL §0, D38). Order: wordmark → h1 → subline → form → notices. */
export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeNext(one(params.next));
  const error = signInErrorMessage(one(params.error));
  // The check-your-email state names the address, which only exists after a confirmed send (rule 10).
  const sentTo = one(params.sent) === "1" ? ((await cookies()).get(SIGN_IN_EMAIL_COOKIE)?.value ?? null) : null;

  return (
    <AuthPage>
      <h1 className="text-display-sm text-le-text sm:text-display">{C.headline}</h1>
      <p className="mt-3 max-w-prose text-body text-le-text-secondary">{C.subline}</p>

      <section className="mt-8" aria-label="Sign in">
        {sentTo ? (
          <div role="status" className="rounded-card border border-le-border bg-le-surface p-5 max-sm:p-4">
            <h2 className="text-h3 text-le-text">{C.sentHeading}</h2>
            <p className="mt-3 text-body text-le-text">{C.sentTo(sentTo)}</p>
            <Link
              href={signInPath(next)}
              className="focus-ring mt-3 inline-flex min-h-11 items-center rounded-control text-body text-le-accent underline-offset-3 hover:underline md:min-h-0"
            >
              {C.differentEmail}
            </Link>
          </div>
        ) : (
          <div className="space-y-5">
            {error ? <ErrorBanner>{error}</ErrorBanner> : null}
            <SignInForm next={next} googleEnabled={isGoogleSignInEnabled()} />
          </div>
        )}
      </section>

      <AuthNotices />
    </AuthPage>
  );
}
