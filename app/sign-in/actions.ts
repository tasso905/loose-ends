"use server";
import { cookies, headers } from "next/headers";
import { safeNext, signInPath } from "@/lib/auth/next";
import {
  callbackUrl,
  classifyOtpError,
  configuredSiteUrl,
  SIGN_IN_EMAIL_COOKIE,
  SIGN_IN_EMAIL_COOKIE_PATH,
  SIGN_IN_EMAIL_MAX_AGE,
  SignInInput,
  siteOrigin,
  type SendLinkResult,
} from "@/lib/auth/signIn";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";

/**
 * Requests a magic link. Returns success only after Supabase confirms the email was accepted
 * (rule 10); the page then shows the check-your-email state.
 */
export async function sendMagicLink(formData: FormData): Promise<SendLinkResult> {
  const parsed = SignInInput.safeParse({
    email: formData.get("email") ?? "",
    next: formData.get("next") || undefined,
  });
  if (!parsed.success) return { ok: false, code: "invalid_email" };

  const next = safeNext(parsed.data.next);
  const h = await headers();
  const origin = siteOrigin(configuredSiteUrl(), h.get("x-forwarded-host") ?? h.get("host"), h.get("x-forwarded-proto"));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: callbackUrl(origin, next), shouldCreateUser: true },
  });
  if (error) {
    const code = classifyOtpError(error);
    log("sign_in_link_failed", { code, status: error.status ?? null });
    return { ok: false, code };
  }

  // The address is shown in the check-your-email state without putting it in the URL.
  (await cookies()).set(SIGN_IN_EMAIL_COOKIE, parsed.data.email, {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https://"),
    path: SIGN_IN_EMAIL_COOKIE_PATH,
    maxAge: SIGN_IN_EMAIL_MAX_AGE,
  });
  return { ok: true, redirectTo: signInPath(next, { sent: "1" }) };
}
