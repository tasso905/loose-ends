import { apiError, type ApiError } from "@/lib/errors";
import { log as defaultLog, type Logger } from "@/lib/log";

/**
 * Account deletion (F13 "Account deletion removes all rows and storage objects"; D14; rule 8).
 * Server-only, service role (CLAUDE.md allows it for account deletion). `userId` must come from the
 * signed-in session, never from the request body.
 *
 * Order matters: storage.objects has no foreign key to auth.users, so files are removed first
 * through the Storage API (listing paginated, subfolders included) and the folder is re-listed to
 * prove it is empty. Only then is the auth user deleted, which cascades every table row. If any
 * storage step fails the user is NOT deleted and a retryable error is returned (rule 10).
 *
 * A still-valid session could race the deletion, so the folder is swept once more after the user is
 * deleted (the storage insert policy also refuses uploads once the profile row is gone). If that
 * sweep fails, no retry is possible: the session is dead. The failure is logged (IDs only), the result
 * says files remain (rules 9, 10), and cron/daily finishes the folder from the row prepared up front
 * (migration 20261104110000).
 *
 * The user's auth.audit_log_entries go too (migration 20261104100000). The purge is recorded before
 * anything is deleted, and refusing there stops the deletion. It runs after the auth user is deleted,
 * because that delete writes an entry of its own. If it fails then, the account is already gone and
 * can't be restored: the result says the records remain (rules 9, 10) and cron/daily retries.
 */

export const SOURCES_BUCKET = "sources";

/**
 * How long one Storage call may take. With Storage down a call otherwise hangs for about 60 s at the
 * gateway while the confirmation dialog can't close (rule 10). A slow call that later succeeds is
 * harmless: every caller re-checks, and the queue clears only when the file is really gone.
 */
export const STORAGE_TIMEOUT_MS = 15_000;
export const STORAGE_TIMEOUT_CODE = "storage_timeout";

/** The call's result, or an error result with STORAGE_TIMEOUT_CODE once the time is up. */
export async function storageCall<T>(call: PromiseLike<{ data: T | null; error: unknown }>, ms = STORAGE_TIMEOUT_MS): Promise<{ data: T | null; error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ data: null; error: { code: string } }>((resolve) => {
    timer = setTimeout(() => resolve({ data: null, error: { code: STORAGE_TIMEOUT_CODE } }), ms);
  });
  try {
    return await Promise.race([Promise.resolve(call), timeout]);
  } catch (error) {
    return { data: null, error: error ?? { code: "unknown" } };
  } finally {
    clearTimeout(timer);
  }
}

interface ListedObject {
  name: string;
  /** null for a folder (prefix) entry. */
  id: string | null;
}

/** The slice of a service-role Supabase client this needs (keeps it unit-testable). */
export interface AccountAdminClient {
  storage: {
    from(bucket: string): {
      list(prefix: string, opts: { limit: number; offset: number }): PromiseLike<{ data: ListedObject[] | null; error: unknown }>;
      remove(paths: string[]): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
  auth: { admin: { deleteUser(id: string): PromiseLike<{ data: unknown; error: unknown }> } };
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/** ok means the account is gone. The flags say what isn't, yet; cron/daily finishes both. */
export type DeleteAccountResult = { ok: true; objectsRemoved: number; signInRecordsRemain?: true; filesRemain?: true } | ({ ok: false } & ApiError);

export interface DeleteAccountOptions {
  /** The session's email, to find audit log entries that name it. Without it, the one on the auth user. */
  email?: string | null;
  /** Listing page size (Storage API maximum is 1000; small values are for tests). */
  pageSize?: number;
  logger?: Logger;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class StorageStepError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

const stepError = (message: string, error: unknown) => new StorageStepError(message, (error as { code?: unknown } | null)?.code === STORAGE_TIMEOUT_CODE);

/** Storage isn't answering: anything else that needs it would only wait out the limit too. */
export const isStorageTimeout = (e: unknown) => e instanceof StorageStepError && e.timedOut;

type FolderClient = Pick<AccountAdminClient, "storage">;

async function listAll(client: FolderClient, prefix: string, pageSize: number, depth = 0): Promise<string[]> {
  if (depth > 10) throw new StorageStepError("folder nesting too deep");
  const bucket = client.storage.from(SOURCES_BUCKET);
  const paths: string[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await storageCall(bucket.list(prefix, { limit: pageSize, offset }));
    if (error || !data) throw stepError("list failed", error);
    for (const o of data) {
      const path = `${prefix}/${o.name}`;
      if (o.id === null) paths.push(...(await listAll(client, path, pageSize, depth + 1)));
      else paths.push(path);
    }
    if (data.length < pageSize) break;
  }
  return paths;
}

/** Removes everything under the user's prefix and proves it is empty, or throws. Returns the count. */
export async function sweepUserFolder(client: FolderClient, userId: string, pageSize = 1000): Promise<number> {
  const paths = await listAll(client, userId, pageSize);
  for (let i = 0; i < paths.length; i += pageSize) {
    const { error } = await storageCall(client.storage.from(SOURCES_BUCKET).remove(paths.slice(i, i + pageSize)));
    if (error) throw stepError("remove failed", error);
  }
  // Prove the folder is empty.
  if ((await listAll(client, userId, pageSize)).length > 0) throw new StorageStepError("objects remain");
  return paths.length;
}

/** A user that no longer exists counts as deleted, so a retry after a failed final sweep can finish. */
const isNotFound = (error: unknown) =>
  typeof error === "object" && error !== null && ((error as { status?: number }).status === 404 || (error as { code?: string }).code === "user_not_found");

/** True only when the database confirms nothing identifying the user is left. Logs IDs only. */
async function purgeAuditLog(client: AccountAdminClient, userId: string, email: string | null, logger: Logger): Promise<boolean> {
  let remaining: unknown;
  try {
    const { data, error } = await client.rpc("auth_audit_purge", { p_user_id: userId, p_email: email });
    remaining = error ? undefined : (data as { remaining?: unknown } | null)?.remaining;
  } catch {
    remaining = undefined;
  }
  if (remaining === 0) return true;
  logger("account_delete_audit_failed", { user_id: userId, step: "purge", remaining: typeof remaining === "number" ? remaining : null });
  return false;
}

export async function deleteAccount(client: AccountAdminClient, userId: string, opts: DeleteAccountOptions = {}): Promise<DeleteAccountResult> {
  if (!UUID.test(userId)) return { ok: false, ...apiError("save_failed") };
  const pageSize = Math.min(Math.max(opts.pageSize ?? 1000, 1), 1000);
  const logger = opts.logger ?? defaultLog;
  const email = opts.email || null;
  let removed = 0;

  // First, so that a purge that could never run deletes nothing at all, not even the files.
  try {
    const { error } = await client.rpc("auth_audit_purge_prepare", { p_user_id: userId, p_email: email });
    if (error) throw error;
  } catch {
    logger("account_delete_audit_failed", { user_id: userId, step: "prepare", remaining: null });
    return { ok: false, ...apiError("save_failed") };
  }

  try {
    removed = await sweepUserFolder(client, userId, pageSize);
  } catch {
    return { ok: false, ...apiError("save_failed") };
  }

  try {
    const { error } = await client.auth.admin.deleteUser(userId);
    if (error && !isNotFound(error)) return { ok: false, ...apiError("save_failed") };
  } catch {
    return { ok: false, ...apiError("save_failed") };
  }

  // The user is gone from here on, so the purge runs whatever the final sweep does.
  const auditPurged = await purgeAuditLog(client, userId, email, logger);

  // Final sweep for anything uploaded between the check and the user deletion.
  let filesGone = true;
  try {
    const late = await sweepUserFolder(client, userId, pageSize);
    if (late > 0) logger("account_delete_late_objects", { user_id: userId, objects: late });
    removed += late;
  } catch {
    filesGone = false;
    logger("account_delete_sweep_failed", { user_id: userId });
  }
  // The folder is empty, so nothing is pending. If this call fails, cron/daily clears the row instead.
  if (filesGone) await Promise.resolve(client.rpc("account_file_purge_clear", { p_user_id: userId })).catch(() => undefined);
  return {
    ok: true,
    objectsRemoved: removed,
    ...(auditPurged ? {} : { signInRecordsRemain: true as const }),
    ...(filesGone ? {} : { filesRemain: true as const }),
  };
}
