import { log as defaultLog, type Logger } from "@/lib/log";
import { SOURCES_BUCKET, storageCall, STORAGE_TIMEOUT_CODE } from "./deleteAccount";

/**
 * The owner-independent finisher of the Storage deletion queue (rule 8, S11-D3), run by cron/daily
 * with the service role through public.storage_deletions_sweep() (migration 20261104090000). A file
 * whose first removal failed is removed here even if the user never comes back.
 *
 * Partial failure is safe by construction: the database clears an entry only when storage.objects no
 * longer has the file, so anything not removed stays queued for the next run. Logs carry counts only
 * (rule 9); a path contains IDs and is never logged.
 */

const BATCH = 100;

export interface SweepClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  storage: { from(bucket: string): { remove(paths: string[]): PromiseLike<{ data: unknown; error: unknown }> } };
}

/** `remaining` is capped at the sweep's own page size (1000); more can be queued behind it. */
export type SweepResult = { ok: boolean; found: number; remaining: number | null };

const paths = (data: unknown): string[] | null => (Array.isArray(data) && data.every((p) => typeof p === "string") ? data : null);

/** Retries audit log purges that failed during account deletion (migration 20261104100000). Counts only. */
export async function purgePendingAuditLogs(client: Pick<SweepClient, "rpc">, logger: Logger = defaultLog): Promise<{ ok: boolean; purged: number; pending: number | null }> {
  const { data, error } = await client.rpc("auth_audit_purge_pending");
  const counts = data as { purged?: unknown; pending?: unknown } | null;
  if (error || typeof counts?.purged !== "number" || typeof counts.pending !== "number") {
    logger("cron_sweep_failed", { step: "audit_log", found: null, remaining: null });
    return { ok: false, purged: 0, pending: null };
  }
  if (counts.pending > 0) logger("cron_sweep_failed", { step: "audit_log", found: counts.purged + counts.pending, remaining: counts.pending });
  return { ok: counts.pending === 0, purged: counts.purged, pending: counts.pending };
}

export async function sweepStorageDeletions(client: SweepClient, logger: Logger = defaultLog): Promise<SweepResult> {
  const first = await client.rpc("storage_deletions_sweep");
  const found = paths(first.data);
  if (first.error || !found) {
    logger("cron_sweep_failed", { step: "settle", found: null, remaining: null });
    return { ok: false, found: 0, remaining: null };
  }
  if (found.length === 0) return { ok: true, found: 0, remaining: 0 };

  let failedBatches = 0;
  for (let i = 0; i < found.length; i += BATCH) {
    const { error } = await storageCall(client.storage.from(SOURCES_BUCKET).remove(found.slice(i, i + BATCH)));
    if (!error) continue;
    failedBatches += 1;
    // Timing out means Storage is not answering: the rest would only wait too. They stay queued.
    if ((error as { code?: unknown }).code === STORAGE_TIMEOUT_CODE) break;
  }

  const second = await client.rpc("storage_deletions_sweep");
  const left = paths(second.data);
  if (second.error || !left) {
    logger("cron_sweep_failed", { step: "settle_after", found: found.length, remaining: null });
    return { ok: false, found: found.length, remaining: null };
  }
  if (left.length > 0 || failedBatches > 0) {
    logger("cron_sweep_failed", { step: "files_left", found: found.length, remaining: left.length });
    return { ok: false, found: found.length, remaining: left.length };
  }
  return { ok: true, found: found.length, remaining: 0 };
}
