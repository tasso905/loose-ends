import { z } from "zod";
import { apiError, type ApiError } from "@/lib/errors";
import { log as defaultLog, type Logger } from "@/lib/log";
import { SOURCES_BUCKET, storageCall } from "./deleteAccount";

/**
 * F13 and F9 Forget (rule 8) with the user's own client: rows are hard-deleted by one SECURITY
 * DEFINER call (public.delete_source / public.forget_thread), which also queues the source's file
 * (migration 20261027122532). The file is then removed through the Storage API, and the queue is
 * settled: success is reported only when no queued file of the user is left in Storage (rule 10).
 * A failed Storage step stays queued; a retry (or cron/daily) finishes it.
 */

/** The slice of a user Supabase client this needs (unit-testable). */
export interface DataClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  storage: { from(bucket: string): { remove(paths: string[]): PromiseLike<{ data: unknown; error: unknown }> } };
}

export type DataResult<T extends object = object> = ({ ok: true } & T) | ({ ok: false; code: "not_found" | "save_failed" } & ApiError);

const code = (error: unknown): string | null => {
  const c = (error as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[\w.-]{1,32}$/.test(c) ? c : null;
};

const Paths = z.array(z.string()).nullable();

/** Removes the user's queued files and settles the queue; ok only when none is left. */
export async function finishStorageDeletions(client: DataClient, logger: Logger = defaultLog): Promise<DataResult<{ filesRemoved: number }>> {
  const fail = (step: string, error: unknown): DataResult<{ filesRemoved: number }> => {
    logger("data_delete_failed", { step, code: code(error) ?? (error ? "unknown" : "bad_result") });
    return { ok: false, code: "save_failed", ...apiError("save_failed") };
  };
  const first = await client.rpc("storage_deletions_settle");
  const queued = Paths.safeParse(first.data);
  if (first.error || !queued.success) return fail("settle", first.error);
  const paths = queued.data ?? [];
  if (paths.length === 0) return { ok: true, filesRemoved: 0 };
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await storageCall(client.storage.from(SOURCES_BUCKET).remove(paths.slice(i, i + 100)));
    if (error) return fail("storage_remove", error);
  }
  const second = await client.rpc("storage_deletions_settle");
  const left = Paths.safeParse(second.data);
  if (second.error || !left.success) return fail("settle_after", second.error);
  if ((left.data ?? []).length > 0) {
    logger("data_delete_failed", { step: "files_left", code: "files_left", files: left.data!.length });
    return { ok: false, code: "save_failed", ...apiError("save_failed") };
  }
  return { ok: true, filesRemoved: paths.length };
}

const DeleteSourceOut = z.union([
  z.object({ ok: z.literal(true), source_id: z.uuid(), threads_forgotten: z.number().int(), file_queued: z.boolean() }),
  z.object({ ok: z.literal(false), error: z.literal("not_found") }),
]);

/**
 * "Delete source only" (`everything = false`: threads keep their quotes) or "Delete source and
 * everything from it" (`everything = true`: its threads are forgotten too). A source that is
 * already gone still finishes any queued file, so `Try again` after a Storage failure completes; it
 * then answers not_found, which the UI shows as gone (no one is told a deletion ran that did not).
 */
export async function deleteSource(
  client: DataClient,
  sourceId: string,
  everything: boolean,
  logger: Logger = defaultLog,
): Promise<DataResult<{ threadsForgotten: number }>> {
  const { data, error } = await client.rpc("delete_source", { p_source_id: sourceId, p_everything: everything });
  const parsed = DeleteSourceOut.safeParse(data);
  if (error || !parsed.success) {
    logger("data_delete_failed", { step: "delete_source", code: code(error) ?? (error ? "unknown" : "bad_result") });
    return { ok: false, code: "save_failed", ...apiError("save_failed") };
  }
  const files = await finishStorageDeletions(client, logger);
  if (!files.ok) return files;
  if (!parsed.data.ok) return { ok: false, code: "not_found", ...apiError("not_found") };
  return { ok: true, threadsForgotten: parsed.data.threads_forgotten };
}

const ForgetOut = z.object({ threads: z.number().int(), sources: z.number().int() }).loose();

/** Forget permanently (F9, D29, D35): the thread and everything that came with it; optionally its source. */
export async function forgetThread(
  client: DataClient,
  threadId: string,
  alsoDeleteSource: boolean,
  logger: Logger = defaultLog,
): Promise<DataResult<{ sourceDeleted: boolean }>> {
  const { data, error } = await client.rpc("forget_thread", { p_thread_id: threadId, p_delete_source: alsoDeleteSource });
  if (code(error) === "P0002") {
    // Already gone, for instance by an earlier attempt whose Storage step failed: `Try again` lands
    // here and must still finish the queued file (rule 8). not_found only once none is left.
    const left = await finishStorageDeletions(client, logger);
    return left.ok ? { ok: false, code: "not_found", ...apiError("not_found") } : left;
  }
  const parsed = ForgetOut.safeParse(data);
  if (error || !parsed.success) {
    logger("data_delete_failed", { step: "forget_thread", code: code(error) ?? (error ? "unknown" : "bad_result") });
    return { ok: false, code: "save_failed", ...apiError("save_failed") };
  }
  const files = await finishStorageDeletions(client, logger);
  if (!files.ok) return files;
  return { ok: true, sourceDeleted: parsed.data.sources > 0 };
}
