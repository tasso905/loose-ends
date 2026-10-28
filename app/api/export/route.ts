import { buildExport, exportFileName, type ExportClient } from "@/lib/account/export";
import { track } from "@/lib/analytics/track";
import { errorResponse } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { getNow } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * GET /api/export — one JSON file of every row the user owns (PRD F13, API Requirements). The
 * user's own client: RLS limits every table to the caller. The file is built in full before the
 * response starts, so a failure is an error response, never a partial download (rule 10).
 */
export async function GET() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return errorResponse("unauthenticated");

  const now = getNow();
  const res = await buildExport(supabase as unknown as ExportClient, auth.user.id, now);
  if (!res.ok) return errorResponse("save_failed");
  track(auth.user.id, "data_exported", {});
  return new Response(JSON.stringify(res.data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(now)}"`,
      "Cache-Control": "no-store",
    },
  });
}
