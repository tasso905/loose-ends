import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AppHeader } from "@/components/AppHeader";
import { ReviewProgress } from "@/components/review/ReviewProgress";
import { requireUser } from "@/lib/auth/session";
import { trackTimedOut } from "@/lib/extraction/analytics";
import { readExtraction } from "@/lib/extraction/service";
import { rpcDb } from "@/lib/extraction/supabaseDb";
import { createClient } from "@/lib/supabase/server";
import { getNow } from "@/lib/time";

export const metadata: Metadata = { title: "Review" };
// `Try again` runs the pipeline in after() from this page's server action (PRD: max duration 60 s).
export const maxDuration = 60;

type Params = Promise<{ extractionId: string }>;

const SourceRow = z.object({ title: z.string().nullable(), kind: z.string(), reference_date: z.string() });

/**
 * /review/[extractionId] (SITE_CONTRACT §1.2, §2.3): extraction progress, then the proposals.
 * Unknown and other users' ids render the not-found page (RLS; never reveals existence).
 */
export default async function ReviewPage({ params }: { params: Params }) {
  const { extractionId } = await params;
  const user = await requireUser(`/review/${encodeURIComponent(extractionId)}`);
  if (!z.uuid().safeParse(extractionId).success) notFound();

  const supabase = await createClient();
  const now = getNow();
  const view = await readExtraction(rpcDb(supabase), extractionId, { now });
  if (!view) notFound();
  trackTimedOut(user.id, view);
  // Due dates render in the user's timezone (DESIGN_STANDARD "Dates and numbers").
  const [{ data: profile }, { data: sourceRow }] = await Promise.all([
    supabase.from("profiles").select("timezone").eq("id", user.id).maybeSingle(),
    // For the label above each quote ("Renewal notice · p. 2"); RLS: the caller's own source.
    supabase.from("sources").select("title, kind, reference_date").eq("id", view.sourceId).maybeSingle(),
  ]);
  const timezone = typeof profile?.timezone === "string" ? profile.timezone : "UTC";
  const source = SourceRow.safeParse(sourceRow);

  return (
    <>
      <AppHeader current={null} />
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        <ReviewProgress
          key={view.id}
          initial={view}
          timezone={timezone}
          nowIso={now.toISOString()}
          source={source.success ? source.data : null}
        />
      </main>
    </>
  );
}
