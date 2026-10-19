import { DEFAULT_NEXT, onboardingPath, safeNext, signInPath } from "@/lib/auth/next";

/**
 * Pure routing decisions for signed-in / signed-out access (SITE_CONTRACT §1.2, D38). The proxy
 * and the auth callback call these; they hold no I/O so every branch is unit-tested.
 */

/** Routes reachable while signed out. Everything else is a Signed in route. */
const PUBLIC_PREFIXES = ["/sign-in", "/auth"];

/** Route handlers answer for themselves with the JSON error envelope; never redirect them. */
const SELF_GUARDED_PREFIXES = ["/api"];

const matches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => matches(pathname, p));
}

export type RouteDecision = { kind: "continue" } | { kind: "redirect"; to: string };

export interface RouteInput {
  pathname: string;
  /** The raw query string including its leading `?`, or "". */
  search: string;
  signedIn: boolean;
}

export function decideRoute({ pathname, search, signedIn }: RouteInput): RouteDecision {
  if (SELF_GUARDED_PREFIXES.some((p) => matches(pathname, p))) return { kind: "continue" };

  // `/` never carries `next`: signed out it goes to sign-in, signed in to Today (D38).
  if (pathname === "/") return { kind: "redirect", to: signedIn ? DEFAULT_NEXT : "/sign-in" };

  if (matches(pathname, "/sign-in")) {
    if (!signedIn) return { kind: "continue" };
    // Already signed in: go where the link was heading.
    return { kind: "redirect", to: safeNext(new URLSearchParams(search).get("next")) };
  }

  if (isPublicPath(pathname)) return { kind: "continue" };

  if (!signedIn) return { kind: "redirect", to: signInPath(`${pathname}${search}`) };
  return { kind: "continue" };
}

/** Where `/auth/callback` sends a user once the session exists. */
export function postSignInDestination({ onboarded, next }: { onboarded: boolean; next: string | null }): string {
  return onboarded ? safeNext(next) : onboardingPath(next);
}

/**
 * Which sign-in notice a provider error on `/auth/callback` gets. Email-link errors (expired, used,
 * missing PKCE state) say the link expired; anything else came from the OAuth provider.
 */
export function callbackErrorNotice(errorCode: string | null, error: string | null): "link_expired" | "oauth_failed" {
  const c = (errorCode ?? "").toLowerCase();
  if (c.startsWith("otp_") || c.startsWith("flow_state") || c === "bad_code_verifier") return "link_expired";
  if (!c && !error) return "link_expired";
  return "oauth_failed";
}

/** Reasons `/auth/callback` may log (rule 9: enums only). Anything else is logged as "other". */
const CALLBACK_LOG_REASONS = new Set([
  "otp_expired",
  "otp_disabled",
  "flow_state_expired",
  "flow_state_not_found",
  "bad_code_verifier",
  "pkce_code_verifier_not_found",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
  "invalid_request",
  "validation_failed",
  "exchange_failed",
  "verify_failed",
  "missing_code",
  "no_user",
]);

export function callbackLogReason(value: string | null | undefined): string {
  return value && CALLBACK_LOG_REASONS.has(value) ? value : "other";
}
