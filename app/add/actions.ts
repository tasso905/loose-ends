"use server";
import { after } from "next/server";
import { serviceBudgetDb as budgetDb } from "@/lib/ai/budgetDb";
import { readDocument } from "@/lib/capture/document";
import { z } from "zod";
import { track } from "@/lib/analytics/track";
import { parsePasteForm, type PasteInputError } from "@/lib/capture/pasteInput";
import { parseQuickAddForm, QUICK_ADD_COPY, quickAddWrittenOn } from "@/lib/capture/quickAddInput";
import { parseUploadForm, SOURCES_BUCKET, uploadFailure, type UploadField } from "@/lib/capture/uploadInput";
import { apiError, type ApiError, type InputField } from "@/lib/errors";
import { extractionCompletedTracker, trackSourceSubmitted, trackUploadSubmitted } from "@/lib/extraction/analytics";
import { readExtraction, runExtraction, startExtraction, startQuickAdd, startUploadExtraction } from "@/lib/extraction/service";
import { log } from "@/lib/log";
import { rpcDb } from "@/lib/extraction/supabaseDb";
import { autoCreateQuickAdd, quickAddRoute, readQuickAddResult, undoQuickAdd } from "@/lib/review/quickAdd";
import { createClient } from "@/lib/supabase/server";
import { getNow, isDemoMode } from "@/lib/time";

export type SubmitPasteResult =
  | { ok: true; extractionId: string }
  | { ok: false; error: ApiError["error"]; signedOut?: boolean; field?: InputField };

const FIELD_FOR: Record<Exclude<PasteInputError, "too_long">, InputField> = {
  empty: "text",
  title_too_long: "title",
  invalid_date: "written_on",
};

/**
 * F2 submit (SITE_CONTRACT §2.2, §3.1): validates with Zod, counts one extraction (consume_usage),
 * stores the source and a running extraction, and returns its id at once so the page can move to
 * /review/[id]. The pipeline runs after the response (`after()`, page maxDuration 60 s). Success is
 * reported only once the rows exist (rule 10).
 */
export async function submitPaste(formData: FormData): Promise<SubmitPasteResult> {
  const parsed = parsePasteForm({
    text: formData.get("text"),
    title: formData.get("title"),
    writtenOn: formData.get("written_on"),
    writtenOnSet: formData.get("written_on_set"),
  });
  if (!parsed.ok) {
    // Validation failures are field errors and never retryable (S2-4): resubmitting can't succeed.
    const error =
      parsed.reason === "too_long"
        ? apiError("input_too_long", { n: parsed.length }).error
        : apiError("invalid_input", { field: FIELD_FOR[parsed.reason] }).error;
    return { ok: false, error, field: parsed.reason === "too_long" ? "text" : FIELD_FOR[parsed.reason] };
  }

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, signedOut: true, error: apiError("unauthenticated").error };

  let demoNow: string | null = null;
  if (isDemoMode()) {
    const { data } = await supabase.from("user_settings").select("demo_now").eq("user_id", auth.user.id).maybeSingle();
    demoNow = (data?.demo_now as string | null) ?? null;
  }

  const db = rpcDb(supabase);
  const started = await startExtraction(db, parsed.data, { now: getNow({ demoNow }), budgetDb });
  if (!started.ok) return { ok: false, error: started.error.error };

  trackSourceSubmitted(auth.user.id, parsed.data.text.length);
  const onComplete = extractionCompletedTracker(auth.user.id);
  after(() => runExtraction(db, started.extractionId, { onComplete, budgetDb }).then(() => undefined));
  return { ok: true, extractionId: started.extractionId };
}

export type SubmitUploadResult =
  | { ok: true; extractionId: string }
  | { ok: false; error: ApiError["error"]; signedOut?: boolean; field?: UploadField };

/**
 * F3 submit (SITE_CONTRACT §2.2, §3.1). The browser has already put the file in the private bucket
 * at sources/{uid}/{source_id} (storage RLS: own folder only), so the 10 MB file never passes
 * through this request. Here the file is read back with the user's client, its type sniffed from
 * the bytes, and only a readable text-layer document becomes a source + running extraction. A
 * refused or failed file is removed from storage again: nothing is kept for a source that does not
 * exist (rule 8). Success is reported only once the rows exist (rule 10).
 */
export async function submitUpload(formData: FormData): Promise<SubmitUploadResult> {
  const parsed = parseUploadForm({
    sourceId: formData.get("source_id"),
    fileName: formData.get("file_name"),
    title: formData.get("title"),
    writtenOn: formData.get("written_on"),
    writtenOnSet: formData.get("written_on_set"),
  });
  if (!parsed.ok) {
    if (parsed.reason === "bad_upload") return { ok: false, error: apiError("save_failed").error };
    const field = parsed.reason === "invalid_date" ? "written_on" : "title";
    return { ok: false, error: apiError("invalid_input", { field }).error, field };
  }

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, signedOut: true, error: apiError("unauthenticated").error };

  const path = `${auth.user.id}/${parsed.data.sourceId}`;
  const bucket = supabase.storage.from(SOURCES_BUCKET);
  // A file a `sources` row owns is never removed here (rule 8 belongs to source deletion): a replayed
  // or forged submit with an existing source id must not delete that source's file. Unknown (query
  // failed) counts as owned, so the file is kept.
  const owned = async () => {
    const { data, error } = await supabase.from("sources").select("id").eq("id", parsed.data.sourceId).maybeSingle();
    return Boolean(error || data);
  };
  const discard = async (step: string) => {
    if (await owned()) {
      log("upload_failed", { step: `${step}_cleanup`, code: "owned" });
      return;
    }
    const { error } = await bucket.remove([path]);
    if (error) log("upload_failed", { step: `${step}_cleanup`, code: "storage" });
  };

  if (await owned()) {
    log("upload_failed", { step: "claimed", code: "duplicate" });
    return { ok: false, error: apiError("save_failed").error };
  }

  const download = await bucket.download(path);
  if (download.error || !download.data) {
    log("upload_failed", { step: "download", code: "storage" });
    return { ok: false, error: apiError("save_failed").error };
  }
  const read = await readDocument(new Uint8Array(await download.data.arrayBuffer()), parsed.data.fileName);
  if (!read.ok) {
    await discard("refused");
    return { ok: false, error: uploadFailure(read), field: "file" };
  }

  let demoNow: string | null = null;
  if (isDemoMode()) {
    const { data } = await supabase.from("user_settings").select("demo_now").eq("user_id", auth.user.id).maybeSingle();
    demoNow = (data?.demo_now as string | null) ?? null;
  }

  const db = rpcDb(supabase);
  const started = await startUploadExtraction(
    db,
    {
      sourceId: parsed.data.sourceId,
      text: read.text,
      title: parsed.data.title,
      writtenOn: parsed.data.writtenOn,
      mimeType: read.mimeType,
      pageOffsets: read.pageOffsets,
    },
    { now: getNow({ demoNow }), budgetDb },
  );
  if (!started.ok) {
    await discard("start");
    return { ok: false, error: started.error.error };
  }

  const fileType = read.mimeType === "application/pdf" ? "pdf" : read.mimeType === "text/markdown" ? "md" : "txt";
  trackUploadSubmitted(auth.user.id, read.text.length, fileType);
  const onComplete = extractionCompletedTracker(auth.user.id);
  after(() => runExtraction(db, started.extractionId, { onComplete, budgetDb }).then(() => undefined));
  return { ok: true, extractionId: started.extractionId };
}

export interface QuickAddCreated {
  threadId: string;
  eventId: number;
  title: string;
}

export type SubmitQuickAddResult =
  /**
   * The source and its extraction exist. `stay`: every proposal became a thread (`created`, for the
   * undo toast). `review`: go to /review/[extractionId], which shows the Medium and Low proposals,
   * the zero state, or the extraction's failure state with `Try again` (SITE_CONTRACT §2.3, §3.1).
   */
  | {
      ok: true;
      extractionId: string;
      route: "stay" | "review";
      created: QuickAddCreated[];
      /**
       * When the threads were created, in ms after this request reached the server (D4). Negative for
       * a replay whose first request created them earlier. Durations only: clocks are never compared.
       */
      createdAfterMs: number;
      /** Nothing has happened to the threads since, so Undo can still work inside its window. */
      undoable: boolean;
    }
  /** `unknown`: it may have been saved. The same key is safe to send again. */
  | { ok: false; error: ApiError["error"]; signedOut?: boolean; field?: "text"; unknown?: boolean };

/** How long a replay waits for a first request that is still extracting (page maxDuration is 60 s). */
const REPLAY_WAIT_MS = 45_000;
const REPLAY_POLL_MS = 500;

/**
 * F4 quick add (SITE_CONTRACT §2.2, §3.1; D9; CLAUDE.md rule 2). Same pipeline as paste with
 * `sources.kind = quick_add`: Zod input check, the budget check and the per-user daily limit
 * (startExtraction), then the extraction runs in this request (page maxDuration 60 s) under
 * withBudget, with quote verification and chrono date re-resolution as for every source. Only then
 * do the High proposals become threads (public.quick_add_auto_create). Success and the undo toast
 * come only from that result (rule 10). If the auto-create step fails, the proposals stay pending
 * and the user goes to the review tray, where nothing is lost.
 *
 * Idempotent per `key` (S14 D2): a replay finds the same extraction, is not counted, and does not
 * extract again (set_extraction_stage lets one run through). If the first request is still running,
 * the replay waits for it; then both get the same threads and the same Undo.
 */
export async function submitQuickAdd(formData: FormData): Promise<SubmitQuickAddResult> {
  const arrived = performance.now();
  const parsed = parseQuickAddForm({ text: formData.get("text") });
  if (!parsed.ok) {
    const message = parsed.reason === "too_long" ? QUICK_ADD_COPY.tooLong(parsed.length) : QUICK_ADD_COPY.empty;
    const code = parsed.reason === "too_long" ? "input_too_long" : "invalid_input";
    return { ok: false, error: { code, message, retryable: false }, field: "text" };
  }

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, signedOut: true, error: apiError("unauthenticated").error };

  let demoNow: string | null = null;
  if (isDemoMode()) {
    const { data } = await supabase.from("user_settings").select("demo_now").eq("user_id", auth.user.id).maybeSingle();
    demoNow = (data?.demo_now as string | null) ?? null;
  }

  // The user is typing it now, so the written-on date is known, not assumed: today in their
  // timezone, as the quick-add eval fixtures record it (reference_date_source = user). "Friday"
  // is read against it by chrono like any other date (rule 3).
  const { data: profile } = await supabase.from("profiles").select("timezone").eq("id", auth.user.id).maybeSingle();
  const now = getNow({ demoNow });
  const writtenOn = quickAddWrittenOn(now, typeof profile?.timezone === "string" ? profile.timezone : "UTC");

  const db = rpcDb(supabase);
  // No key (a forged request): a key of its own, so no replay protection and no failure.
  const key = z.uuid().safeParse(formData.get("key")).data ?? crypto.randomUUID();
  const unknown = { ok: false as const, unknown: true, error: { code: "save_failed" as const, message: QUICK_ADD_COPY.addUnknown, retryable: true } };
  const started = await startQuickAdd(db, { key, text: parsed.data.text, writtenOn }, { now, budgetDb });
  if (!started.ok) return started.unknown ? unknown : { ok: false, error: started.error.error };
  if (!started.replayed) trackSourceSubmitted(auth.user.id, parsed.data.text.length, "quick_add");

  const review = { ok: true as const, extractionId: started.extractionId, route: "review" as const, created: [], createdAfterMs: 0, undoable: false };
  const tracker = extractionCompletedTracker(auth.user.id);
  const outcome = await runExtraction(db, started.extractionId, {
    // Analytics is sent after the response, so PostHog never delays the result.
    onComplete: (r) => after(() => tracker(r).then(() => undefined)),
    budgetDb,
  });
  if (outcome === "failed") return review;
  // Skipped: another request with this key has the run. Wait for it instead of extracting again.
  const waitUntil = performance.now() + REPLAY_WAIT_MS;
  for (;;) {
    const view = await readExtraction(db, started.extractionId, { now: getNow() }).catch(() => undefined);
    if (view === undefined) return unknown;
    if (view === null || view.status === "failed") return review;
    if (view.status === "succeeded") break;
    if (performance.now() >= waitUntil) return review; // the review page shows the progress
    await new Promise((r) => setTimeout(r, REPLAY_POLL_MS));
  }

  // Clock-guarded in the database: the real clock, as every other thread write (not the demo date).
  const auto = await autoCreateQuickAdd(db, started.extractionId, { now: getNow() });
  if (!auto.ok && auto.code !== "invalid_transition") return auto.code === "save_failed" ? unknown : review;
  const result = await readQuickAddResult(db, started.extractionId, { now: getNow() });
  if (!result) return unknown;
  const created = result.created.map((c) => ({ threadId: c.thread_id, eventId: c.event_id, title: c.title }));

  let route: "stay" | "review" = "review";
  try {
    const view = await readExtraction(db, started.extractionId, { now: getNow() });
    if (view) route = quickAddRoute(created, view.proposals);
  } catch {
    // Unknown: the review page shows what is pending.
  }
  return {
    ok: true,
    extractionId: started.extractionId,
    route,
    created,
    createdAfterMs: Math.floor(performance.now() - arrived) - result.age_ms,
    undoable: result.untouched,
  };
}

const UndoQuickAddInput = z
  .array(z.object({ threadId: z.uuid(), eventId: z.number().int().positive() }))
  .min(1)
  .max(20);

export type UndoQuickAddResult = { ok: true } | { ok: false; error: ApiError["error"] };

/**
 * The quick-add toast's Undo (D8): removes the threads the auto-create made, with their events
 * (F4). The database allows it within 12 s of the created event (8 s toast + 4 s grace, D44) and
 * only while the user has not acted on the thread since; otherwise `invalid_transition`.
 */
export async function undoQuickAddAction(pairs: { threadId: string; eventId: number }[]): Promise<UndoQuickAddResult> {
  const input = UndoQuickAddInput.safeParse(pairs);
  if (!input.success) return { ok: false, error: apiError("not_found").error };
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: apiError("unauthenticated").error };
  const res = await undoQuickAdd(rpcDb(supabase), input.data, { now: getNow() });
  if (!res.ok) return { ok: false, error: res.error.error };
  track(auth.user.id, "undo_used", { action: "create" });
  return { ok: true };
}
