import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import type { EmailOtpType } from "@supabase/supabase-js";
import type { SignInErrorCode } from "@/lib/auth/copy";
import { signInPath } from "@/lib/auth/next";
import { callbackErrorNotice, callbackLogReason, postSignInDestination } from "@/lib/auth/routing";
import { redirectResponse, SIGN_IN_EMAIL_COOKIE, SIGN_IN_EMAIL_COOKIE_PATH } from "@/lib/auth/signIn";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";

const OTP_TYPES: readonly EmailOtpType[] = ["magiclink", "email", "signup", "invite", "recovery", "email_change"];

/**
 * Auth handoff (SITE_CONTRACT §1.2). Exchanges the PKCE `code` (magic link or Google), or verifies a
 * `token_hash` if the email template uses one. First sign-in → /onboarding, else `next` or /today.
 * Expired, used or invalid links go back to /sign-in with a notice. Redirects use SITE_URL (D4).
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const next = q.get("next");
  const fail = (reason: string | null, code: SignInErrorCode = "link_expired") => {
    log("auth_callback_failed", { reason: callbackLogReason(reason) });
    return redirectResponse(signInPath(next, { error: code }));
  };

  // Supabase reports link errors in the query for the PKCE flow (e.g. error_code=otp_expired).
  const errorCode = q.get("error_code");
  const errorName = q.get("error");
  if (errorCode || errorName) return fail(errorCode ?? errorName, callbackErrorNotice(errorCode, errorName));

  const supabase = await createClient();
  const code = q.get("code");
  const tokenHash = q.get("token_hash");
  const type = q.get("type") as EmailOtpType | null;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    // PKCE: the link only works in the browser that asked for it (the code verifier is a cookie there).
    if (error) {
      return fail(error.code ?? "exchange_failed", error.code === "pkce_code_verifier_not_found" ? "link_other_browser" : "link_expired");
    }
  } else if (tokenHash && type && OTP_TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) return fail(error.code ?? "verify_failed");
  } else {
    return fail("missing_code");
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return fail("no_user");

  // Signed in: the check-your-email address has done its job (B3).
  (await cookies()).delete({ name: SIGN_IN_EMAIL_COOKIE, path: SIGN_IN_EMAIL_COOKIE_PATH });

  const { data: profile } = await supabase.from("profiles").select("onboarded_at").eq("id", userData.user.id).maybeSingle();
  return redirectResponse(postSignInDestination({ onboarded: Boolean(profile?.onboarded_at), next }));
}
