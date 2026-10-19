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
 * sweep fails, the failure is logged (IDs only) and returned; a retry finds the user already gone
 * (treated as deleted) and sweeps again.
 */

export const SOURCES_BUCKET = "sources";

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
}

export type DeleteAccountResult = { ok: true; objectsRemoved: number } | ({ ok: false } & ApiError);

export interface DeleteAccountOptions {
  /** Listing page size (Storage API maximum is 1000; small values are for tests). */
  pageSize?: number;
  logger?: Logger;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class StorageStepError extends Error {}

async function listAll(client: AccountAdminClient, prefix: string, pageSize: number, depth = 0): Promise<string[]> {
  if (depth > 10) throw new StorageStepError("folder nesting too deep");
  const bucket = client.storage.from(SOURCES_BUCKET);
  const paths: string[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await bucket.list(prefix, { limit: pageSize, offset });
    if (error || !data) throw new StorageStepError("list failed");
    for (const o of data) {
      const path = `${prefix}/${o.name}`;
      if (o.id === null) paths.push(...(await listAll(client, path, pageSize, depth + 1)));
      else paths.push(path);
    }
    if (data.length < pageSize) break;
  }
  return paths;
}

async function sweep(client: AccountAdminClient, userId: string, pageSize: number): Promise<number> {
  const paths = await listAll(client, userId, pageSize);
  for (let i = 0; i < paths.length; i += pageSize) {
    const { error } = await client.storage.from(SOURCES_BUCKET).remove(paths.slice(i, i + pageSize));
    if (error) throw new StorageStepError("remove failed");
  }
  // Prove the folder is empty.
  if ((await listAll(client, userId, pageSize)).length > 0) throw new StorageStepError("objects remain");
  return paths.length;
}

/** A user that no longer exists counts as deleted, so a retry after a failed final sweep can finish. */
const isNotFound = (error: unknown) =>
  typeof error === "object" && error !== null && ((error as { status?: number }).status === 404 || (error as { code?: string }).code === "user_not_found");

export async function deleteAccount(client: AccountAdminClient, userId: string, opts: DeleteAccountOptions = {}): Promise<DeleteAccountResult> {
  if (!UUID.test(userId)) return { ok: false, ...apiError("save_failed") };
  const pageSize = Math.min(Math.max(opts.pageSize ?? 1000, 1), 1000);
  const logger = opts.logger ?? defaultLog;
  let removed = 0;

  try {
    removed = await sweep(client, userId, pageSize);
  } catch {
    return { ok: false, ...apiError("save_failed") };
  }

  try {
    const { error } = await client.auth.admin.deleteUser(userId);
    if (error && !isNotFound(error)) return { ok: false, ...apiError("save_failed") };
  } catch {
    return { ok: false, ...apiError("save_failed") };
  }

  // Final sweep for anything uploaded between the check and the user deletion.
  try {
    const late = await sweep(client, userId, pageSize);
    if (late > 0) logger("account_delete_late_objects", { user_id: userId, objects: late });
    removed += late;
  } catch {
    logger("account_delete_sweep_failed", { user_id: userId });
    return { ok: false, ...apiError("save_failed") };
  }
  return { ok: true, objectsRemoved: removed };
}
