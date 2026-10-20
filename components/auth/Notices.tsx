import Link from "next/link";
import { InfoNotice } from "@/components/Notice";
import { SIGN_IN_COPY as C } from "@/lib/auth/copy";
import { isAnalyticsEnabled } from "@/lib/supabase/env";

/** Sensitive-data note and analytics notice, on sign-in and onboarding (SITE_CONTRACT §2.0). */
export function AuthNotices() {
  return (
    <section className="mt-8 space-y-3" aria-label="Before you start">
      <InfoNotice>{C.sensitiveNote}</InfoNotice>
      {/* Hidden until analytics events ship: the notice must describe what is implemented (D40, rule 9). */}
      {isAnalyticsEnabled() ? (
        <InfoNotice>
          {C.analyticsNotice}{" "}
          <Link href="/settings#profile" className="focus-ring rounded-control text-le-accent underline underline-offset-3">
            {C.analyticsOptOut}
          </Link>
        </InfoNotice>
      ) : null}
    </section>
  );
}
