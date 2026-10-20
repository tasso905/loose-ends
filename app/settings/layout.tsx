import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { isAnalyticsEnabled } from "@/lib/supabase/env";

/**
 * Gate for /settings, outside the segment's loading boundary: a layout renders before
 * loading.tsx starts streaming, so `notFound()` here is a real HTTP 404, not a 200 with the
 * not-found UI. Auth runs first (it reads cookies, so the gate is checked per request, and a
 * signed-out visit still redirects to sign-in). Only the analytics toggle is built, so the whole
 * page stays hidden until SETTINGS_ANALYTICS_TOGGLE_SHIPPED flips (D40).
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireUser("/settings");
  if (!isAnalyticsEnabled()) notFound();
  return children;
}
