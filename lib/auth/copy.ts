/**
 * User-facing copy for sign-in and onboarding.
 *
 * DOCUMENTED strings are exact text from PRD F1 / D38, SITE_CONTRACT §2.0 and §2.13, and
 * CONTENT_MODEL §0. APPROVED strings fill gaps those documents leave (sign-in has no row in the
 * SITE_CONTRACT §2.14 state matrix and no auth codes in §2.13); they follow DESIGN_STANDARD
 * Microcopy and were signed off by the user on Oct 20. PROPOSED strings still await sign-off and
 * are not rendered.
 */

/**
 * Lifetime of a magic link, in seconds. Must equal `otp_expiry` in supabase/config.toml and in the
 * production Supabase project's auth settings; tests/unit/auth-copy.test.ts enforces the former.
 */
export const MAGIC_LINK_LIFETIME_SECONDS = 3600;
const LINK_HOURS = MAGIC_LINK_LIFETIME_SECONDS / 3600;
export const SIGN_IN_COPY = {
  // DOCUMENTED
  wordmark: "Loose Ends",
  headline: "Tie up your loose ends.",
  subline: "Paste in the mess. Get back what's still open, each with the sentence it came from.",
  sendButton: "Email me a sign-in link",
  googleButton: "Continue with Google",
  differentEmail: "Use a different email",
  sensitiveNote: "Don't paste passwords or full account numbers.",
  offline: "You're offline. Nothing was saved.", // §2.13 Network / offline
  tryAgain: "Try again",

  // APPROVED (user sign-off Oct 20)
  emailLabel: "Email",
  sentHeading: "Check your email",
  sentTo: (email: string) => `I sent a sign-in link to ${email}. Open it in this browser to sign in.`,
  linkLifetime: `The link works for ${LINK_HOURS} ${LINK_HOURS === 1 ? "hour" : "hours"}.`,
  orDivider: "or",
  invalidEmail: "Enter an email address, like name@example.com.",
  rateLimited: "Too many sign-in links were requested. Wait a few minutes, then try again.",
  sendFailed: "I couldn't send the link. Try again.",
  linkExpired: "That sign-in link has expired or was already used. Enter your email to get a new one.",
  oauthFailed: "Google sign-in didn't finish. Try again, or use your email.",
  noScript: "Signing in needs JavaScript. Turn it on in your browser, then reload this page.",
  linkOtherBrowser:
    "That link was opened in a different browser. Enter your email to get a new one, and open it in this browser.",

  // PROPOSED — hidden until analytics events ship (D40; rule 9). Wording pending user sign-off when the first event ships.
  analyticsNotice: "Loose Ends counts which features you use. Analytics never include what you paste.",
  analyticsOptOut: "Turn off analytics",
} as const;

export const ONBOARDING_COPY = {
  // DOCUMENTED
  question: "What name and emails do people use for you?",
  sensitiveNote: SIGN_IN_COPY.sensitiveNote,
  skip: "Skip", // PRD Key screens #9 actions
  saveFailed: "That didn't save. Try again.", // §2.13 Any other save failure
  offline: SIGN_IN_COPY.offline,

  // APPROVED (user sign-off Oct 20)
  hint: "Separate them with commas. I use these to tell which tasks are yours.",
  emailAlwaysIncluded: (email: string) => `Your sign-in email, ${email}, is always included.`,
  fieldLabel: "Names and emails",
  save: "Save",
  tooMany: "That's more than 20 names and emails. Keep the ones people use most.",
  tooLong: "Each name or email can be up to 100 characters.",
} as const;

/** Sign-in page `?error=` codes. Unknown codes show nothing. */
export const SIGN_IN_ERRORS = {
  link_expired: SIGN_IN_COPY.linkExpired,
  oauth_failed: SIGN_IN_COPY.oauthFailed,
  link_other_browser: SIGN_IN_COPY.linkOtherBrowser,
} as const;
export type SignInErrorCode = keyof typeof SIGN_IN_ERRORS;

export function signInErrorMessage(code: string | null | undefined): string | null {
  return code && Object.hasOwn(SIGN_IN_ERRORS, code) ? SIGN_IN_ERRORS[code as SignInErrorCode] : null;
}
