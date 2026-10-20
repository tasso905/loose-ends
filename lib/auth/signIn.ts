import { NextResponse } from "next/server";
import { z } from "zod";

/** Pure helpers for the magic-link request (PRD F1, SITE_CONTRACT §2.0). */

export const SIGN_IN_EMAIL_COOKIE = "le_sign_in_email";
/** 15 minutes: shorter than the magic-link expiry (otp_expiry 3600 s), and cleared on sign-in and sign-out. */
export const SIGN_IN_EMAIL_MAX_AGE = 15 * 60;
export const SIGN_IN_EMAIL_COOKIE_PATH = "/sign-in";

export const SignInInput = z.object({
  email: z.string().trim().max(320).pipe(z.email()),
  next: z.string().max(2048).optional(),
});

export type SendLinkFailure = "invalid_email" | "sign_in_rate_limited" | "offline" | "send_failed";
export type SendLinkResult = { ok: true; redirectTo: string } | { ok: false; code: SendLinkFailure };

/** Maps a Supabase Auth error to the sign-in failure shown next to the form. */
export function classifyOtpError(err: { status?: number; code?: string } | null | undefined): SendLinkFailure {
  if (!err) return "send_failed";
  if (err.status === 429 || err.code?.startsWith("over_")) return "sign_in_rate_limited";
  if (err.code === "email_address_invalid" || err.code === "validation_failed") return "invalid_email";
  return "send_failed";
}

/**
 * Origin for links in emails. SITE_URL wins (set it in production so a forged Host header cannot
 * steer the link); otherwise the request's own origin, for local dev and CI.
 */
export function siteOrigin(env: string | undefined, host: string | null, proto: string | null): string {
  // Callers pass configuredSiteUrl(), which throws in production when SITE_URL is unset (D5).
  if (env) return env.replace(/\/+$/, "");
  const scheme = proto === "https" ? "https" : "http";
  return `${scheme}://${host ?? "127.0.0.1:3000"}`;
}

/** Callback URL with `next` carried through the magic link (D38). */
export function callbackUrl(origin: string, next: string): string {
  const u = new URL("/auth/callback", origin);
  if (next !== "/today") u.searchParams.set("next", next);
  return u.toString();
}

/**
 * SITE_URL, or undefined outside production. In production a missing SITE_URL fails closed (D5):
 * links and redirects must never be built from a request's Host or X-Forwarded-Host.
 */
export function configuredSiteUrl(env: { SITE_URL?: string; NODE_ENV?: string } = process.env): string | undefined {
  const site = env.SITE_URL?.trim();
  if (site) return new URL(site).origin;
  if (env.NODE_ENV === "production") throw new Error("SITE_URL must be set in production.");
  return undefined;
}

/**
 * Absolute URL for a same-site redirect. SITE_URL's origin when set, otherwise the request URL's own
 * origin. Host and X-Forwarded-Host are ignored (D4); the parameters stay for call-site compatibility.
 */
export function sameHostUrl(path: string, requestUrl: string, _host?: string | null, _proto?: string | null): URL {
  void _host;
  void _proto;
  return new URL(path, configuredSiteUrl() ?? new URL(requestUrl).origin);
}

/**
 * A same-site redirect response. With SITE_URL it is absolute on that origin. Without it (local dev
 * only) the Location is relative, so the browser stays on the host it used: in dev `request.url` can
 * say `localhost` while the browser is on 127.0.0.1, and session cookies are host-scoped.
 */
export function redirectResponse(path: string): NextResponse {
  const site = configuredSiteUrl();
  const location = site ? new URL(path, site).toString() : path;
  return new NextResponse(null, { status: 307, headers: { Location: location } });
}
