import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { purgePendingAuditLogs, sweepStorageDeletions, type SweepClient } from "@/lib/account/sweep";
import { errorResponse, apiError } from "@/lib/errors";
import { log } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * cron/daily (PRD API Requirements; D62). Today it finishes deletions (rule 8): the Storage deletion
 * queue (S11-D3) and audit log purges that failed during account deletion; digests join it with F15.
 * Service role, as CLAUDE.md allows here.
 *
 * Authorization: `Bearer CRON_SECRET`, compared in constant time. With no secret configured every
 * request is refused. Vercel Cron sends GET with that header; the PRD names POST, so both answer.
 * A partial failure answers 500 with the counts, so the run shows as failed; whatever was not
 * removed stays queued for the next run.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`));
}

async function run(request: Request): Promise<Response> {
  if (!authorized(request)) return errorResponse("unauthenticated");
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    log("cron_sweep_failed", { step: "config", found: null, remaining: null });
    return errorResponse("save_failed");
  }
  const sweep = await sweepStorageDeletions(admin as unknown as SweepClient);
  const audit = await purgePendingAuditLogs(admin as unknown as SweepClient);
  const counts = { files_found: sweep.found, files_remaining: sweep.remaining, audit_purged: audit.purged, audit_pending: audit.pending };
  if (!sweep.ok || !audit.ok) return NextResponse.json({ ...apiError("save_failed"), ...counts }, { status: 500 });
  return NextResponse.json({ ok: true, ...counts });
}

export const GET = run;
export const POST = run;
