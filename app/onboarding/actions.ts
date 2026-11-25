"use server";
import { onboardingPath, safeNext, signInPath } from "@/lib/auth/next";
import { buildProfilePatch, OnboardingInput } from "@/lib/auth/onboarding";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { getNow } from "@/lib/time";

export type OnboardingFailure = "save_failed" | "too_many" | "too_long" | "offline";
export type OnboardingResult = { ok: true; redirectTo: string; fullLoad?: true } | { ok: false; code: OnboardingFailure };

/**
 * Saves (or skips) the aliases answer and marks onboarding done (PRD F1). Either way the signed-in
 * email stays an alias and the browser timezone is stored. Success only after the row is updated.
 *
 * `user_id` is the user the form was rendered for. The answer can't be taken back in the app, so if
 * another user has signed in from another tab since, nothing is stored and their own page loads. It is
 * only compared with the session; a missing one is refused too.
 */
export async function completeOnboarding(formData: FormData): Promise<OnboardingResult> {
  const parsed = OnboardingInput.safeParse({
    intent: formData.get("intent"),
    answer: formData.get("answer") ?? "",
    timezone: formData.get("timezone") || undefined,
    next: formData.get("next") || undefined,
  });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message;
    return { ok: false, code: msg === "too_many" ? "too_many" : msg === "too_long" ? "too_long" : "save_failed" };
  }
  const next = safeNext(parsed.data.next);

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) return { ok: true, redirectTo: signInPath(onboardingPath(next)) };
  if (formData.get("user_id") !== user.id) return { ok: true, redirectTo: onboardingPath(next), fullLoad: true };

  const { data: profile, error: readError } = await supabase
    .from("profiles")
    .select("aliases")
    .eq("id", user.id)
    .maybeSingle();
  if (readError || !profile) {
    log("onboarding_save_failed", { stage: "read" });
    return { ok: false, code: "save_failed" };
  }

  const patch = buildProfilePatch(parsed.data, {
    email: user.email ?? null,
    existingAliases: (profile.aliases as string[] | null) ?? [],
    nowIso: getNow().toISOString(),
  });

  let { data: updated, error } = await supabase.from("profiles").update(patch).eq("id", user.id).select("id");
  if (error?.code === "22023" && patch.timezone) {
    // The database knows fewer zones than this runtime: keep the default timezone rather than fail.
    const { timezone: _tz, ...rest } = patch;
    void _tz;
    ({ data: updated, error } = await supabase.from("profiles").update(rest).eq("id", user.id).select("id"));
  }
  if (error || !updated || updated.length !== 1) {
    log("onboarding_save_failed", { stage: "update", code: error?.code ?? null });
    return { ok: false, code: "save_failed" };
  }
  return { ok: true, redirectTo: next };
}
