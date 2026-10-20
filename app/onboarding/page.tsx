import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthPage } from "@/components/auth/AuthPage";
import { AuthNotices } from "@/components/auth/Notices";
import { OnboardingForm } from "@/components/auth/OnboardingForm";
import { ONBOARDING_COPY as C } from "@/lib/auth/copy";
import { onboardingPath, safeNext } from "@/lib/auth/next";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Welcome" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Onboarding: the one aliases question, skippable, shown once (PRD F1, SITE_CONTRACT §1.2). */
export default async function OnboardingPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).next;
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw);
  const user = await requireUser(onboardingPath(next));

  const supabase = await createClient();
  const { data: profile } = await supabase.from("profiles").select("onboarded_at").eq("id", user.id).maybeSingle();
  if (profile?.onboarded_at) redirect(next); // shown once

  return (
    <AuthPage>
      <h1 className="text-display-sm text-le-text sm:text-display">{C.question}</h1>
      <OnboardingForm next={next} email={user.email ?? null} />
      <AuthNotices />
    </AuthPage>
  );
}
