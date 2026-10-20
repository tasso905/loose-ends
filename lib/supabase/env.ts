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

/**
 * Google identity sign-in (D41): the button renders whenever this flag is "true". Set it only where the
 * Supabase Google provider is also enabled, or the click lands on a bare provider error page instead of
 * `oauth_failed`. Off by default (contributors without credentials); E2E pins it on.
 */
export function isGoogleSignInEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_GOOGLE_ENABLED === "true";
}

/**
 * The Settings analytics toggle the notice's opt-out link points at. Flip to true in the change that
 * ships the first PostHog event (S2), so the notice, the toggle and capture go live together and the
 * opt-out link can never 404 (CONTENT_MODEL §11 Analytics; D40, rule 9). While false, `track()` sends
 * nothing.
 */
export const SETTINGS_ANALYTICS_TOGGLE_SHIPPED = false;

/** PostHog US cloud ingestion host (D40: US region). Override with POSTHOG_HOST. */
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * PostHog settings when analytics is configured for this deployment: ANALYTICS_ENABLED is exactly
 * "true" and POSTHOG_KEY is set. Does not check the shipped flag or the user's opt-out.
 */
export function posthogSettings(env: Record<string, string | undefined> = process.env): { key: string; host: string } | null {
  const key = env.POSTHOG_KEY?.trim();
  if (env.ANALYTICS_ENABLED !== "true" || !key) return null;
  return { key, host: env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST };
}

/**
 * Analytics notice, Settings toggle and capture stay off until events ship (D40; rule 9): they need
 * the explicit ANALYTICS_ENABLED flag, a PostHog key, and the Settings toggle to exist.
 */
export function isAnalyticsEnabled(
  env: Record<string, string | undefined> = process.env,
  shipped: boolean = SETTINGS_ANALYTICS_TOGGLE_SHIPPED,
): boolean {
  return shipped && posthogSettings(env) !== null;
}
