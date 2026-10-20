"use server";
import { after } from "next/server";
import { parsePasteForm } from "@/lib/capture/pasteInput";
import { apiError, type ApiError } from "@/lib/errors";
import { runExtraction, startExtraction } from "@/lib/extraction/service";
import { rpcDb } from "@/lib/extraction/supabaseDb";
import { createClient } from "@/lib/supabase/server";
import { getNow, isDemoMode } from "@/lib/time";

export type SubmitPasteResult = { ok: true; extractionId: string } | { ok: false; error: ApiError["error"]; signedOut?: boolean };

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
    return {
      ok: false,
      error: parsed.reason === "too_long" ? apiError("input_too_long", { n: parsed.length }).error : apiError("save_failed").error,
    };
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

  after(() => runExtraction(db, started.extractionId).then(() => undefined));
  return { ok: true, extractionId: started.extractionId };
}
