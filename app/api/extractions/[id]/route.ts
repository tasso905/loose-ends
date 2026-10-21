import { z } from "zod";
import { errorResponse } from "@/lib/errors";
import { log } from "@/lib/log";
import { trackTimedOut } from "@/lib/extraction/analytics";
import { readExtraction } from "@/lib/extraction/service";
import { rpcDb } from "@/lib/extraction/supabaseDb";
import { createClient } from "@/lib/supabase/server";
import { getNow } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * GET /api/extractions/:id — poll an extraction (PRD API Requirements). RLS-scoped: another
 * user's id and an unknown id both answer 404. A running row older than 90 s is marked failed
 * here (A2). Response: ExtractionView {id, sourceId, status, stage, slow, proposals[], brief, error}.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return errorResponse("not_found");

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return errorResponse("unauthenticated");

  try {
    const view = await readExtraction(rpcDb(supabase), id, { now: getNow() });
    if (!view) return errorResponse("not_found");
    trackTimedOut(auth.user.id, view);
    return Response.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch {
    log("extraction_persist_failed", { extraction_id: id, step: "read" });
    return errorResponse("save_failed");
  }
}
