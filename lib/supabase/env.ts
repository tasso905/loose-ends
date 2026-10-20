/**
 * Public Supabase settings. The `process.env.NEXT_PUBLIC_*` references stay literal so Next.js
 * inlines them into the browser bundle.
 */
export function supabasePublicEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.");
  return { url, anonKey };
}

/** Google identity sign-in is built but off until Google Cloud OAuth credentials exist (D20 pending). */
export function isGoogleSignInEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_GOOGLE_ENABLED === "true";
}

/**
 * The Settings analytics toggle the notice's opt-out link points at. Flip to true in the change that
 * ships it, so the link can never 404 (CONTENT_MODEL §11 Analytics).
 */
const SETTINGS_ANALYTICS_TOGGLE_SHIPPED = false;

/**
 * Analytics notice stays hidden until events ship (D40; rule 9): it needs the explicit
 * ANALYTICS_ENABLED flag, a PostHog key, and the Settings toggle to exist.
 */
export function isAnalyticsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return SETTINGS_ANALYTICS_TOGGLE_SHIPPED && env.ANALYTICS_ENABLED === "true" && Boolean(env.POSTHOG_KEY);
}
