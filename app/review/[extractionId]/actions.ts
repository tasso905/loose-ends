"use server";
import { after } from "next/server";
import { z } from "zod";
import { apiError, type ApiError } from "@/lib/errors";
import { extractionCompletedTracker } from "@/lib/extraction/analytics";
import { readExtraction, retryExtraction, runExtraction } from "@/lib/extraction/service";
import { rpcDb } from "@/lib/extraction/supabaseDb";
import { trackProposalsReviewed, trackProposalsShown } from "@/lib/review/analytics";
import { acceptProposals, rejectProposals, undoRejectProposals } from "@/lib/review/service";
import { bandCounts, trayProposals } from "@/lib/review/tray";
import { createClient } from "@/lib/supabase/server";
import { getNow } from "@/lib/time";

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
  // Another click already started this attempt: show it, never run it twice (S2-2).
  if (res.alreadyStarted) return { ok: true, extractionId: res.extractionId };
  const onComplete = extractionCompletedTracker(auth.user.id);
  after(() => runExtraction(db, res.extractionId, { onComplete }).then(() => undefined));
  return { ok: true, extractionId: res.extractionId };
}

/* ---------------------------------------------------------------------------------------------
 * S3: Review Tray accept / reject / undo (F6). Each is one SQL transaction (migration
 * 20261020225037). Ids are validated with Zod; another user's id refuses the whole call. The UI
 * shows success only from these results (rule 10).
 * ------------------------------------------------------------------------------------------- */

const ReviewInput = z.object({ extractionId: z.uuid(), itemIds: z.array(z.uuid()).min(1).max(100) });

export type ReviewActionResult<T> = ({ ok: true } & T) | { ok: false; error: ApiError["error"] };
export type AcceptActionResult = ReviewActionResult<{ accepted: Array<{ itemId: string; threadId: string }>; invalid: string[] }>;
export type RejectActionResult = ReviewActionResult<{ rejected: string[]; invalid: string[] }>;
export type UndoActionResult = ReviewActionResult<{ restored: string[]; invalid: string[] }>;

async function reviewContext(input: unknown) {
  const parsed = ReviewInput.safeParse(input);
  if (!parsed.success) return { error: apiError("not_found").error } as const;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { error: apiError("unauthenticated").error } as const;
  return { userId: auth.user.id, db: rpcDb(supabase), ...parsed.data } as const;
}

export async function acceptProposalsAction(extractionId: string, itemIds: string[]): Promise<AcceptActionResult> {
  const ctx = await reviewContext({ extractionId, itemIds });
  if ("error" in ctx) return { ok: false, error: ctx.error! };
  const res = await acceptProposals(ctx.db, ctx.extractionId, ctx.itemIds, { now: getNow() });
  if (!res.ok) return { ok: false, error: res.error.error };
  trackProposalsReviewed(ctx.userId, res.created, "accepted");
  return {
    ok: true,
    accepted: [...res.created, ...res.already].flatMap((e) => (e.thread_id ? [{ itemId: e.item_id, threadId: e.thread_id }] : [])),
    invalid: res.invalid.map((e) => e.item_id),
  };
}

export async function rejectProposalsAction(extractionId: string, itemIds: string[]): Promise<RejectActionResult> {
  const ctx = await reviewContext({ extractionId, itemIds });
  if ("error" in ctx) return { ok: false, error: ctx.error! };
  const res = await rejectProposals(ctx.db, ctx.extractionId, ctx.itemIds, { now: getNow() });
  if (!res.ok) return { ok: false, error: res.error.error };
  trackProposalsReviewed(ctx.userId, res.rejected, "rejected");
  return { ok: true, rejected: [...res.rejected, ...res.already].map((e) => e.item_id), invalid: res.invalid.map((e) => e.item_id) };
}

export async function undoRejectAction(extractionId: string, itemIds: string[]): Promise<UndoActionResult> {
  const ctx = await reviewContext({ extractionId, itemIds });
  if ("error" in ctx) return { ok: false, error: ctx.error! };
  const res = await undoRejectProposals(ctx.db, ctx.extractionId, ctx.itemIds);
  if (!res.ok) return { ok: false, error: res.error.error };
  return { ok: true, restored: res.restored.map((e) => e.item_id), invalid: res.invalid.map((e) => e.item_id) };
}

/** `proposals_shown`, once per tray display; band counts come from the stored rows, not the client. */
export async function proposalsShownAction(extractionId: string): Promise<void> {
  if (!z.uuid().safeParse(extractionId).success) return;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return;
  try {
    const view = await readExtraction(rpcDb(supabase), extractionId, { now: getNow() });
    if (!view || view.status !== "succeeded") return;
    const pending = view.proposals.filter((p) => p.reviewStatus === "pending");
    if (trayProposals(pending).length === 0) return;
    trackProposalsShown(auth.user.id, extractionId, bandCounts(pending));
  } catch {
    // Analytics never affects the page.
  }
}
