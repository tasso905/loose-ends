import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { ReviewProgress } from "@/components/review/ReviewProgress";
import { Wordmark } from "@/components/Wordmark";
import { requireUser } from "@/lib/auth/session";
import { readExtraction } from "@/lib/extraction/service";
import { rpcDb } from "@/lib/extraction/supabaseDb";
import { createClient } from "@/lib/supabase/server";
import { getNow } from "@/lib/time";

export const metadata: Metadata = { title: "Review" };
// `Try again` runs the pipeline in after() from this page's server action (PRD: max duration 60 s).
export const maxDuration = 60;

type Params = Promise<{ extractionId: string }>;

/**
 * /review/[extractionId] (SITE_CONTRACT §1.2, §2.3): extraction progress, then the proposals.
 * Unknown and other users' ids render the not-found page (RLS; never reveals existence).
 */
export default async function ReviewPage({ params }: { params: Params }) {
  const { extractionId } = await params;
  await requireUser(`/review/${encodeURIComponent(extractionId)}`);
  if (!z.uuid().safeParse(extractionId).success) notFound();

  const supabase = await createClient();
  const view = await readExtraction(rpcDb(supabase), extractionId, { now: getNow() });
  if (!view) notFound();

  return (
    <>
      <header className="mx-auto flex w-full max-w-column items-center justify-between gap-4 px-4 pt-6 sm:px-6 md:pt-8 lg:px-8">
        <Wordmark />
        <SignOutButton />
      </header>
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        <ReviewProgress key={view.id} initial={view} />
      </main>
    </>
  );
}
