import { z } from "zod";
import { apiError, type ApiError } from "@/lib/errors";
import type { RpcDb } from "@/lib/extraction/service";
import { log as defaultLog, type Logger } from "@/lib/log";
import { Band } from "@/lib/schemas";

/**
 * F6 accept / reject / undo through the SQL functions in migration 20261020225037 (one transaction
 * per call, RLS-scoped). Results carry ids and bands only, so the caller can send
 * `proposal_reviewed` without touching content (rule 9).
 */

const Entry = z.object({ item_id: z.uuid(), band: Band, thread_id: z.uuid().nullable().optional() });
export type ReviewEntry = z.infer<typeof Entry>;

const Refused = z.object({ ok: z.literal(false), error: z.literal("not_found") });
const AcceptOut = z.union([
  z.object({ ok: z.literal(true), created: z.array(Entry), already: z.array(Entry), invalid: z.array(Entry) }),
  Refused,
]);
const RejectOut = z.union([
  z.object({ ok: z.literal(true), rejected: z.array(Entry), already: z.array(Entry), invalid: z.array(Entry) }),
  Refused,
]);
const UndoOut = z.union([z.object({ ok: z.literal(true), restored: z.array(Entry), invalid: z.array(Entry) }), Refused]);

export type ReviewFailure = { ok: false; notFound: boolean; error: ApiError };
export type AcceptResult = { ok: true; created: ReviewEntry[]; already: ReviewEntry[]; invalid: ReviewEntry[] } | ReviewFailure;
export type RejectResult = { ok: true; rejected: ReviewEntry[]; already: ReviewEntry[]; invalid: ReviewEntry[] } | ReviewFailure;
export type UndoResult = { ok: true; restored: ReviewEntry[]; invalid: ReviewEntry[] } | ReviewFailure;

const errCode = (error: unknown): string | null => {
  const c = (error as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[\w.-]{1,32}$/.test(c) ? c : null;
};

async function call<T extends z.ZodType>(
  db: RpcDb,
  fn: string,
  args: Record<string, unknown>,
  schema: T,
  logger: Logger,
): Promise<{ ok: true; data: z.infer<T> } | ReviewFailure> {
  const { data, error } = await db.rpc(fn, args);
  const parsed = schema.safeParse(data);
  if (error || !parsed.success) {
    logger("review_persist_failed", { step: fn, code: errCode(error) ?? (error ? "unknown" : "bad_result") });
    return { ok: false, notFound: false, error: apiError("save_failed") };
  }
  const out = parsed.data as { ok: boolean };
  if (!out.ok) return { ok: false, notFound: true, error: apiError("not_found") };
  return { ok: true, data: parsed.data };
}

export async function acceptProposals(
  db: RpcDb,
  extractionId: string,
  itemIds: string[],
  opts: { now: Date; logger?: Logger },
): Promise<AcceptResult> {
  const res = await call(
    db,
    "accept_proposals",
    { p_extraction_id: extractionId, p_item_ids: itemIds, p_now: opts.now.toISOString() },
    AcceptOut,
    opts.logger ?? defaultLog,
  );
  if (!res.ok) return res;
  const d = res.data as Extract<z.infer<typeof AcceptOut>, { ok: true }>;
  return { ok: true, created: d.created, already: d.already, invalid: d.invalid };
}

export async function rejectProposals(
  db: RpcDb,
  extractionId: string,
  itemIds: string[],
  opts: { now: Date; logger?: Logger },
): Promise<RejectResult> {
  const res = await call(
    db,
    "reject_proposals",
    { p_extraction_id: extractionId, p_item_ids: itemIds, p_now: opts.now.toISOString() },
    RejectOut,
    opts.logger ?? defaultLog,
  );
  if (!res.ok) return res;
  const d = res.data as Extract<z.infer<typeof RejectOut>, { ok: true }>;
  return { ok: true, rejected: d.rejected, already: d.already, invalid: d.invalid };
}

export async function undoRejectProposals(
  db: RpcDb,
  extractionId: string,
  itemIds: string[],
  opts: { logger?: Logger } = {},
): Promise<UndoResult> {
  const res = await call(
    db,
    "undo_reject_proposals",
    { p_extraction_id: extractionId, p_item_ids: itemIds },
    UndoOut,
    opts.logger ?? defaultLog,
  );
  if (!res.ok) return res;
  const d = res.data as Extract<z.infer<typeof UndoOut>, { ok: true }>;
  return { ok: true, restored: d.restored, invalid: d.invalid };
}
