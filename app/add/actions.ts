"use server";
import { after } from "next/server";
import { parsePasteForm, type PasteInputError } from "@/lib/capture/pasteInput";
import { apiError, type ApiError, type InputField } from "@/lib/errors";
import { extractionCompletedTracker, trackSourceSubmitted } from "@/lib/extraction/analytics";
import { runExtraction, startExtraction } from "@/lib/extraction/service";
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
