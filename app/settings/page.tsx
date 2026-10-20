import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorBanner } from "@/components/Notice";
import { AnalyticsToggle } from "@/components/settings/AnalyticsToggle";
import { buttonVariants } from "@/components/ui/button";
import { Wordmark } from "@/components/Wordmark";
import { ANALYTICS_SETTINGS_COPY as C } from "@/lib/auth/copy";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { isAnalyticsEnabled } from "@/lib/supabase/env";

export const metadata: Metadata = { title: "Settings" };

/**
 * Settings (SITE_CONTRACT §2.12). Only the Profile section's analytics toggle is built so far, and
 * it stays hidden (404) until the first PostHog event ships with SETTINGS_ANALYTICS_TOGGLE_SHIPPED
 * (D40). The rest of Profile and the Data section arrive with their features.
 */
export default async function SettingsPage() {
  // Auth first: it reads cookies, so the route is dynamic and the env gate is checked at request
  // time, not baked in at build time.
  const user = await requireUser("/settings");
  if (!isAnalyticsEnabled()) notFound();

  const supabase = await createClient();
  const { data, error } = await supabase.from("user_settings").select("analytics_enabled").eq("user_id", user.id).maybeSingle();

  return (
    <>
      <header className="mx-auto w-full max-w-column px-4 pt-6 sm:px-6 md:pt-8 lg:px-8">
        <Wordmark />
      </header>
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        <h1 className="text-display-sm text-le-text sm:text-display">Settings</h1>
        <section id="profile" aria-labelledby="profile-heading" className="mt-8">
          <h2 id="profile-heading" className="text-h2 text-le-text">
            {C.heading}
          </h2>
          <div className="mt-4">
            {error || !data ? (
              <ErrorBanner
                action={
                  <Link href="/settings" className={buttonVariants({ variant: "secondary", size: "small" })}>
                    {C.tryAgain}
                  </Link>
                }
              >
                {C.loadFailed}
              </ErrorBanner>
            ) : (
              <AnalyticsToggle initialEnabled={data.analytics_enabled === true} />
            )}
          </div>
        </section>
      </main>
    </>
  );
}
