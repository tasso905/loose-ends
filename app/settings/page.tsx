import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { AppHeader } from "@/components/AppHeader";
import { ErrorBanner } from "@/components/Notice";
import { AnalyticsToggle } from "@/components/settings/AnalyticsToggle";
import { DeleteAccount } from "@/components/settings/DeleteAccount";
import { ExportData } from "@/components/settings/ExportData";
import { SourcesList, type SourceRow } from "@/components/settings/SourcesList";
import { buttonVariants } from "@/components/ui/button";
import { DATA_COPY as D } from "@/lib/account/copy";
import { ANALYTICS_SETTINGS_COPY as C } from "@/lib/auth/copy";
import { requireUser } from "@/lib/auth/session";
import { PRIVACY_COPY } from "@/lib/privacy/copy";
import { createClient } from "@/lib/supabase/server";
import { isAnalyticsEnabled } from "@/lib/supabase/env";
import { userTimezone } from "@/lib/threads/read";
import { formatDecisionDate } from "@/lib/threads/view";

export const metadata: Metadata = { title: "Settings" };

const Source = z.object({
  id: z.uuid(),
  title: z.string().nullable(),
  kind: z.string(),
  created_at: z.string(),
  storage_path: z.string().nullable(),
});

const KIND_NAME: Record<string, string> = { paste: "Pasted text", upload: "Uploaded file", quick_add: "Quick add" };

/**
 * Settings (SITE_CONTRACT §2.12). Profile: the analytics toggle, shown only once analytics can run
 * (D40, D57). Data (S11; F13, D14): the sources list with its two delete options, Export data
 * (JSON) and Delete account…. No retention toggle: source text is kept by default with no purge
 * (D61). The rest of Profile (name, aliases, timezone) arrives with its feature.
 */
export default async function SettingsPage() {
  const user = await requireUser("/settings");
  const supabase = await createClient();
  const analytics = isAnalyticsEnabled();

  const [settings, sources, timezone] = await Promise.all([
    analytics ? supabase.from("user_settings").select("analytics_enabled").eq("user_id", user.id).maybeSingle() : null,
    supabase.from("sources").select("id, title, kind, created_at, storage_path").eq("user_id", user.id).order("created_at", { ascending: false }),
    userTimezone(supabase, user.id),
  ]);
  const parsed = sources.error ? null : z.array(Source).safeParse(sources.data ?? []);
  const rows: SourceRow[] | null =
    parsed && parsed.success
      ? parsed.data.map((s) => ({
          id: s.id,
          name: s.title ?? KIND_NAME[s.kind] ?? "Source",
          added: formatDecisionDate(s.created_at, timezone),
          hasFile: s.storage_path !== null,
        }))
      : null;

  const retry = (
    <Link href="/settings" className={buttonVariants({ variant: "secondary", size: "small" })}>
      {D.tryAgain}
    </Link>
  );

  return (
    <>
      <AppHeader current={null} />
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        <h1 className="text-display-sm text-le-text sm:text-display">{D.settingsTitle}</h1>

        {settings ? (
          <section id="profile" aria-labelledby="profile-heading" className="mt-8">
            <h2 id="profile-heading" className="text-h2 text-le-text">
              {C.heading}
            </h2>
            <div className="mt-4">
              {settings.error || !settings.data ? (
                <ErrorBanner action={retry}>{C.loadFailed}</ErrorBanner>
              ) : (
                <AnalyticsToggle initialEnabled={settings.data.analytics_enabled === true} />
              )}
            </div>
          </section>
        ) : null}

        <section id="data" aria-labelledby="data-heading" className="mt-10">
          <h2 id="data-heading" className="text-h2 text-le-text">
            {D.dataHeading}
          </h2>

          <div className="mt-6">
            <h3 id="sources-heading" tabIndex={-1} className="focus-ring rounded-control text-h3 text-le-text">
              {D.sourcesHeading}
            </h3>
            <div className="mt-2">
              {rows ? <SourcesList sources={rows} headingId="sources-heading" /> : <ErrorBanner action={retry}>{D.loadFailed}</ErrorBanner>}
            </div>
          </div>

          <div className="mt-8">
            <h3 className="text-h3 text-le-text">{D.exportButton}</h3>
            <div className="mt-2">
              <ExportData />
            </div>
          </div>

          <div className="mt-8">
            <h3 className="text-h3 text-le-text">{D.accountHeading}</h3>
            <div className="mt-3">
              <DeleteAccount />
            </div>
          </div>

          <p className="mt-8">
            <Link
              href="/privacy"
              className="focus-ring inline-flex items-center rounded-control text-body text-le-accent underline-offset-3 hover:underline max-md:min-h-11"
            >
              {PRIVACY_COPY.linkLabel}
            </Link>
          </p>
        </section>
      </main>
    </>
  );
}
