import { DATA_COPY } from "@/lib/account/copy";
import { apiError, type ApiError } from "@/lib/errors";
import { log as defaultLog, type Logger } from "@/lib/log";

/**
 * Account deletion (F13 "Account deletion removes all rows and storage objects"; D14; rule 8).
 * Server-only, service role (CLAUDE.md allows it for account deletion). `userId` must come from the
 * signed-in session, never from the request body.
 *
 * Order matters (S11-D6). Nothing goes before the auth user does, so a refused deletion leaves the
 * account whole: first the pending purges are recorded and Storage has to answer, or nothing is
 * deleted. Then the auth user is deleted, which cascades every table row. Then the folder is swept
 * (storage.objects has no foreign key to auth.users; listing paginated, subfolders included) and
 * re-listed to prove it is empty. The storage insert policy refuses uploads once the profile is gone.
 *
 * Once the user is gone no retry is possible: the session is dead. A sweep that fails then is logged
 * (IDs only), the result says files remain (rules 9, 10), and cron/daily finishes the folder from the
 * row prepared up front (migration 20261104110000).
 *
 * deleteUser can report an error though the user went, so any error is checked with getUserById.
 * Still there: a plain failure, and a retry works. Gone: the deletion carries on. If the check fails
 * too, nothing more is deleted here and the message says it couldn't confirm (rule 10); cron/daily
 * finishes the rest if the user did go. A deleteUser that timed out may still land, so even "still
 * there" can't be trusted after one: that is unconfirmed as well.
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

/** The same limit for Auth calls: with Auth hung, the confirmation dialog can't close either. */
export const authCall = <T>(call: PromiseLike<{ data: T | null; error: unknown }>, ms = STORAGE_TIMEOUT_MS) => storageCall(call, ms);

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
  auth: {
    admin: {
      deleteUser(id: string): PromiseLike<{ data: unknown; error: unknown }>;
      getUserById(id: string): PromiseLike<{ data: { user: unknown } | null; error: unknown }>;
    };
  };
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

/** Asks Auth, after deleteUser reported an error. null: Auth didn't answer either. */
async function userIsGone(client: AccountAdminClient, userId: string): Promise<boolean | null> {
  const { data, error } = await authCall(client.auth.admin.getUserById(userId));
  if (error) return isNotFound(error) ? true : null;
  return data?.user ? false : null;
}

/** Not knowing whether the user went, "That didn't save" could be untrue (rule 10). */
export const unconfirmed = (): { ok: false } & ApiError => {
  const failed = apiError("save_failed");
  return { ok: false, error: { ...failed.error, message: DATA_COPY.accountDeleteUnconfirmed } };
};

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

  // First, so that a purge that could never run deletes nothing at all, not even the files.
  try {
    const { error } = await client.rpc("auth_audit_purge_prepare", { p_user_id: userId, p_email: email });
    if (error) throw error;
  } catch {
    logger("account_delete_audit_failed", { user_id: userId, step: "prepare", remaining: null });
    return { ok: false, ...apiError("save_failed") };
  }

  // Storage has to answer before anything is deleted. It removes nothing.
  const probe = await storageCall(client.storage.from(SOURCES_BUCKET).list(userId, { limit: 1, offset: 0 }));
  if (probe.error || !probe.data) {
    logger("account_delete_sweep_failed", { user_id: userId, step: "storage_check" });
    return { ok: false, ...apiError("save_failed") };
  }

  const { error: deleteError } = await authCall(client.auth.admin.deleteUser(userId));
  if (deleteError && !isNotFound(deleteError)) {
    const gone = await userIsGone(client, userId);
    const mayStillLand = (deleteError as { code?: unknown }).code === STORAGE_TIMEOUT_CODE;
    if (gone === false && !mayStillLand) return { ok: false, ...apiError("save_failed") };
    if (gone !== true) {
      logger("account_delete_sweep_failed", { user_id: userId, step: "user_unconfirmed" });
      return unconfirmed();
    }
  }

  // The user is gone from here on, so the purge runs whatever the sweep does.
  const auditPurged = await purgeAuditLog(client, userId, email, logger);

  let filesGone = true;
  let removed = 0;
  try {
    removed = await sweepUserFolder(client, userId, pageSize);
  } catch {
    filesGone = false;
    logger("account_delete_sweep_failed", { user_id: userId, step: "sweep" });
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
