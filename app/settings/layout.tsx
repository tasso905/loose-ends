import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { isAnalyticsEnabled } from "@/lib/supabase/env";

/**
 * Gate for /settings, outside the segment's loading boundary: a layout renders before
 * loading.tsx starts streaming, so `notFound()` here is a real HTTP 404, not a 200 with the
 * not-found UI. Auth runs first (it reads cookies, so the gate is checked per request, and a
 * signed-out visit still redirects to sign-in). The toggle shipped (D46), but the page's only
 * control is the analytics toggle, so it is shown only where analytics is configured
 * (ANALYTICS_ENABLED and POSTHOG_KEY; Production): a toggle for analytics that cannot run would
 * imply data collection that does not happen (rule 9). Elsewhere it stays a 404.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireUser("/settings");
  if (!isAnalyticsEnabled()) notFound();
  return children;
}
