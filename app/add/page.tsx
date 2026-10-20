import type { Metadata } from "next";
import { formatInTimeZone } from "date-fns-tz";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { PasteForm } from "@/components/capture/PasteForm";
import { Wordmark } from "@/components/Wordmark";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getNow, isDemoMode } from "@/lib/time";

export const metadata: Metadata = { title: "Add" };
// The paste server action runs the extraction pipeline in after(); it inherits this limit
// (PRD Technical Architecture "Extraction timeouts").
export const maxDuration = 60;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Add / Capture (F2; SITE_CONTRACT §2.2). Only Paste is built in this slice: `?mode=upload` and
 * `?mode=quick` (F3, F4) are not available yet and show Paste.
 */
export default async function AddPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).mode;
  const mode = Array.isArray(raw) ? raw[0] : raw;
  const user = await requireUser(mode ? `/add?mode=${encodeURIComponent(mode)}` : "/add");

  const supabase = await createClient();
  const [{ data: profile }, settings] = await Promise.all([
    supabase.from("profiles").select("timezone").eq("id", user.id).maybeSingle(),
    isDemoMode()
      ? supabase.from("user_settings").select("demo_now").eq("user_id", user.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const timezone = (profile?.timezone as string | undefined) ?? "UTC";
  const demoNow = (settings.data as { demo_now?: string | null } | null)?.demo_now ?? null;
  const today = formatInTimeZone(getNow({ demoNow }), timezone, "yyyy-MM-dd");

  return (
    <>
      <header className="mx-auto flex w-full max-w-column items-center justify-between gap-4 px-4 pt-6 sm:px-6 md:pt-8 lg:px-8">
        <Wordmark />
        <SignOutButton />
      </header>
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        <h1 className="text-display-sm text-le-text sm:text-display">Drop something in</h1>
        <PasteForm today={today} />
      </main>
    </>
  );
}
