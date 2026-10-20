"use server";
import { after } from "next/server";
import { z } from "zod";
import { apiError, type ApiError } from "@/lib/errors";
import { extractionCompletedTracker } from "@/lib/extraction/analytics";
import { retryExtraction, runExtraction } from "@/lib/extraction/service";
import { rpcDb } from "@/lib/extraction/supabaseDb";
import { createClient } from "@/lib/supabase/server";

export type RetryResult = { ok: true; extractionId: string } | { ok: false; error: ApiError["error"] };

/**
 * `Try again` after extraction_failed (SITE_CONTRACT §2.3, §2.13): a new attempt on the saved
 * source. It is not counted against the daily limit again (A3). The pipeline runs in after().
 */
export async function retryExtractionAction(extractionId: string): Promise<RetryResult> {
  if (!z.uuid().safeParse(extractionId).success) return { ok: false, error: apiError("not_found").error };
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: apiError("unauthenticated").error };

  const db = rpcDb(supabase);
  const res = await retryExtraction(db, extractionId);
  if (!res.ok) return { ok: false, error: res.notFound ? apiError("not_found").error : res.error.error };
  const onComplete = extractionCompletedTracker(auth.user.id);
  after(() => runExtraction(db, res.extractionId, { onComplete }).then(() => undefined));
  return { ok: true, extractionId: res.extractionId };
}
