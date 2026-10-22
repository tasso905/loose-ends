"use server";
import { after } from "next/server";
import { readDocument } from "@/lib/capture/document";
import { parsePasteForm, type PasteInputError } from "@/lib/capture/pasteInput";
import { parseUploadForm, SOURCES_BUCKET, uploadFailure, type UploadField } from "@/lib/capture/uploadInput";
import { apiError, type ApiError, type InputField } from "@/lib/errors";
import { extractionCompletedTracker, trackSourceSubmitted, trackUploadSubmitted } from "@/lib/extraction/analytics";
import { runExtraction, startExtraction, startUploadExtraction } from "@/lib/extraction/service";
import { log } from "@/lib/log";
import { rpcDb } from "@/lib/extraction/supabaseDb";
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
  const started = await startExtraction(db, parsed.data, { now: getNow({ demoNow }) });
  if (!started.ok) return { ok: false, error: started.error.error };

  trackSourceSubmitted(auth.user.id, parsed.data.text.length);
  const onComplete = extractionCompletedTracker(auth.user.id);
  after(() => runExtraction(db, started.extractionId, { onComplete }).then(() => undefined));
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
  const discard = async (step: string) => {
    const { error } = await bucket.remove([path]);
    if (error) log("upload_failed", { step: `${step}_cleanup`, code: "storage" });
  };

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
    { now: getNow({ demoNow }) },
  );
  if (!started.ok) {
    await discard("start");
    return { ok: false, error: started.error.error };
  }

  const fileType = read.mimeType === "application/pdf" ? "pdf" : read.mimeType === "text/markdown" ? "md" : "txt";
  trackUploadSubmitted(auth.user.id, read.text.length, fileType);
  const onComplete = extractionCompletedTracker(auth.user.id);
  after(() => runExtraction(db, started.extractionId, { onComplete }).then(() => undefined));
  return { ok: true, extractionId: started.extractionId };
}
