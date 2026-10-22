import Link from "next/link";
import { InfoNotice } from "@/components/Notice";
import { SIGN_IN_COPY as C } from "@/lib/auth/copy";
import { isAnalyticsEnabled } from "@/lib/supabase/env";

/**
 * Sensitive-data note (sign-in and onboarding) and, in onboarding only, the analytics notice with
 * its opt-out link (SITE_CONTRACT §2.0, PRD F1).
 */
export function AuthNotices({ analytics = false }: { analytics?: boolean }) {
  return (
    <section className="mt-8 space-y-3" aria-label="Before you start">
      <InfoNotice>{C.sensitiveNote}</InfoNotice>
      {/* Hidden until analytics events ship: the notice must describe what is implemented (D40, rule 9). */}
      {analytics && isAnalyticsEnabled() ? (
        <InfoNotice>
          {C.analyticsNotice}{" "}
          <Link href="/settings#profile" className="focus-ring rounded-control text-le-accent underline underline-offset-3 max-md:inline-flex max-md:min-h-11 max-md:items-center">
            {C.analyticsOptOut}
          </Link>
        </InfoNotice>
      ) : null}
    </section>
  );
}
