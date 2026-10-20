import type { LanguageModel } from "ai";
import { z } from "zod";
import { extract, ExtractionFailedError } from "@/lib/ai/extract";
import { EXTRACT_PROMPT_VERSION } from "@/lib/ai/prompts";
import { safeErrorFields } from "@/lib/ai/safeError";
import { EXTRACTION_SCHEMA_VERSION } from "@/lib/ai/schema";
import type { PasteInput } from "@/lib/capture/pasteInput";
import { apiError, type ApiError } from "@/lib/errors";
import { log as defaultLog, type Logger } from "@/lib/log";
import { processExtraction } from "@/lib/pipeline/proposals";
import { DAILY_LIMITS, RATE_LIMIT_TIMEZONE } from "@/lib/rateLimit";
import { Band, ReviewStatus } from "@/lib/schemas";
import { parseInstant } from "@/lib/time";
import { ProposalPayload, toPayload } from "./payload";

/**
 * F2 → F5 extraction lifecycle (S2). Every database step is one SQL function (migration
 * 20261020222601_paste_extraction.sql), called through the user-scoped client so RLS applies:
 *
 *   startExtraction  consume_usage once + sources + extractions(running, stage "reading")
 *   runExtraction    stage "finding" → extract() → stage "checking" → processExtraction()
 *                    → complete_extraction (all items, every band, atomically) or fail_extraction
 *   retryExtraction  "Try again": a new attempt on the same source, not counted again (A3)
 *   readExtraction   poll read; a running row older than 90 s is marked failed (A2)
 *
 * Rule 9: failures are logged with safeErrorFields() only. The model's raw text is stored on the
 * extractions row for debugging and never logged.
 */

export interface RpcDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export type ExtractionStage = "reading" | "finding" | "checking";

/** Extractions slower than this show `extraction_slow` (PRD Technical Architecture, D40). */
export const SLOW_AFTER_MS = 45_000;
/** A running extraction older than this is marked failed by the next poll (A2). */
export const STALE_AFTER_MS = 90_000;

/** `extractions.model` before the call has resolved a model; replaced by extract()'s label after. */
export function configuredModelLabel(env: Record<string, string | undefined> = process.env): string {
  return `${env.AI_PROVIDER?.trim() || "unset"}:${env.AI_MODEL?.trim() || "unset"}`;
}

const errCode = (error: unknown): string | null => {
  const c = (error as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[\w.-]{1,32}$/.test(c) ? c : null;
};

export type StartResult = { ok: true; sourceId: string; extractionId: string } | { ok: false; error: ApiError };

export async function startExtraction(
  db: RpcDb,
  input: PasteInput & { kind?: "paste" },
  opts: { now: Date; logger?: Logger },
): Promise<StartResult> {
  const logger = opts.logger ?? defaultLog;
  const { data, error } = await db.rpc("start_source_extraction", {
    p_kind: input.kind ?? "paste",
    p_text: input.text,
    p_title: input.title,
    p_reference_date: input.writtenOn,
    p_now: opts.now.toISOString(),
    p_model: configuredModelLabel(),
    p_prompt_version: EXTRACT_PROMPT_VERSION,
    p_schema_version: EXTRACTION_SCHEMA_VERSION,
  });
  const out = data as { source_id?: string; extraction_id?: string; error?: string } | null;
  if (error || !out) {
    logger("extraction_start_failed", { code: errCode(error) });
    return { ok: false, error: apiError("save_failed") };
  }
  if (out.error === "rate_limited") {
    return {
      ok: false,
      error: apiError("rate_limited", { limit: DAILY_LIMITS.extraction, kind: "sources", timezone: RATE_LIMIT_TIMEZONE }),
    };
  }
  if (!out.source_id || !out.extraction_id) {
    logger("extraction_start_failed", { code: "no_ids" });
    return { ok: false, error: apiError("save_failed") };
  }
  return { ok: true, sourceId: out.source_id, extractionId: out.extraction_id };
}

export type RetryResult = { ok: true; extractionId: string } | { ok: false; notFound: boolean; error: ApiError };

export async function retryExtraction(db: RpcDb, extractionId: string, opts: { logger?: Logger } = {}): Promise<RetryResult> {
  const logger = opts.logger ?? defaultLog;
  const { data, error } = await db.rpc("retry_extraction", {
    p_extraction_id: extractionId,
    p_model: configuredModelLabel(),
    p_prompt_version: EXTRACT_PROMPT_VERSION,
    p_schema_version: EXTRACTION_SCHEMA_VERSION,
  });
  if (error) {
    logger("extraction_start_failed", { code: errCode(error), retry: true });
    return { ok: false, notFound: false, error: apiError("save_failed") };
  }
  const out = data as { extraction_id?: string; error?: string } | null;
  if (!out) return { ok: false, notFound: true, error: apiError("save_failed") };
  if (out.extraction_id) return { ok: true, extractionId: out.extraction_id };
  logger("extraction_start_failed", { code: out.error ?? "unknown", retry: true });
  return { ok: false, notFound: false, error: apiError("save_failed") };
}

const Context = z.object({
  status: z.enum(["running", "succeeded", "failed"]),
  source_kind: z.enum(["paste", "upload", "quick_add", "email_forward"]),
  source_text: z.string().nullable(),
  reference_date: z.string(),
  reference_date_source: z.enum(["user", "detected", "defaulted"]),
  page_offsets: z.array(z.number()).nullable(),
  timezone: z.string(),
  display_name: z.string(),
  aliases: z.array(z.string()).nullable(),
});

/** Content-free value for `extractions.error`. */
function failureCode(err: unknown): string {
  return `ai_${safeErrorFields(err).kind}`;
}

export interface RunDeps {
  /** Injected model (tests); otherwise extract() resolves AI_PROVIDER / AI_MODEL. */
  model?: LanguageModel;
  /** Label recorded as `extractions.model` for an injected model. */
  modelLabel?: string;
  logger?: Logger;
}

export type RunOutcome = "succeeded" | "failed" | "skipped";

/**
 * Runs one extraction attempt to completion. Never throws: every failure ends with the row marked
 * failed (source kept, no items) or, if the row is no longer running, with nothing written.
 */
export async function runExtraction(db: RpcDb, extractionId: string, deps: RunDeps = {}): Promise<RunOutcome> {
  const logger = deps.logger ?? defaultLog;
  const fail = async (code: string, extra: { model?: string | null; latencyMs?: number | null; raw?: string | null } = {}) => {
    const { error } = await db.rpc("fail_extraction", {
      p_extraction_id: extractionId,
      p_error: code,
      p_model: extra.model ?? null,
      p_latency_ms: extra.latencyMs ?? null,
      // The model's last raw text, kept for debugging only (never logged, never shown).
      p_raw_output: extra.raw ?? null,
    });
    if (error) logger("extraction_persist_failed", { extraction_id: extractionId, step: "fail", code: errCode(error) });
    return "failed" as const;
  };

  try {
    const ctxRes = await db.rpc("extraction_context", { p_extraction_id: extractionId });
    const parsed = Context.safeParse(ctxRes.data);
    if (ctxRes.error || !parsed.success) {
      logger("extraction_persist_failed", { extraction_id: extractionId, step: "context", code: errCode(ctxRes.error) });
      return ctxRes.error ? await fail("context_failed") : "skipped";
    }
    const ctx = parsed.data;
    if (ctx.status !== "running") return "skipped";
    if (ctx.source_text === null) return await fail("source_unavailable");

    await db.rpc("set_extraction_stage", { p_extraction_id: extractionId, p_stage: "finding" });

    let run;
    try {
      run = await extract(
        {
          sourceText: ctx.source_text,
          sourceKind: ctx.source_kind,
          referenceDate: ctx.reference_date,
          referenceDateSource: ctx.reference_date_source,
          timezone: ctx.timezone,
          user: { displayName: ctx.display_name, aliases: ctx.aliases ?? [] },
        },
        { model: deps.model, modelLabel: deps.modelLabel, logger, extractionId },
      );
    } catch (err) {
      logger("extraction_failed", { ...safeErrorFields(err), extraction_id: extractionId });
      const f = err instanceof ExtractionFailedError ? err : null;
      return await fail(failureCode(err), { model: f?.model ?? null, latencyMs: f?.latencyMs ?? null, raw: f?.rawText ?? null });
    }

    await db.rpc("set_extraction_stage", { p_extraction_id: extractionId, p_stage: "checking" });

    const processed = processExtraction(run.output, {
      sourceText: ctx.source_text,
      pageOffsets: ctx.page_offsets,
      referenceDate: ctx.reference_date,
      referenceDateSource: ctx.reference_date_source,
      timezone: ctx.timezone,
      extractionId,
      logger,
    });
    const items = processed.proposals.map((p) => {
      const payload = toPayload(p);
      return {
        item_index: p.index,
        payload,
        confidence: p.score,
        band: p.band,
        suppression_hash: p.suppression_hash,
        evidence: payload.evidence,
      };
    });

    const done = await db.rpc("complete_extraction", {
      p_extraction_id: extractionId,
      p_model: run.model,
      p_input_tokens: run.inputTokens,
      p_output_tokens: run.outputTokens,
      p_latency_ms: run.latencyMs,
      p_raw_output: run.raw,
      p_brief: processed.brief,
      p_items: items,
    });
    const res = done.data as { ok?: boolean; reason?: string } | null;
    if (!done.error && res?.ok) return "succeeded";
    if (res?.reason === "not_running") return "skipped";
    logger("extraction_persist_failed", { extraction_id: extractionId, step: "complete", code: errCode(done.error) ?? res?.reason ?? null });
    return await fail("persist_failed", { model: run.model, latencyMs: run.latencyMs });
  } catch (err) {
    logger("extraction_failed", { ...safeErrorFields(err), extraction_id: extractionId, step: "pipeline" });
    return await fail("pipeline_error").catch(() => "failed" as const);
  }
}

const Row = z.object({
  id: z.string(),
  source_id: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  stage: z.enum(["reading", "finding", "checking"]).nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  brief: z.unknown().nullable(),
  proposals: z.array(
    z.object({
      id: z.string(),
      band: Band,
      confidence: z.coerce.number(),
      review_status: ReviewStatus,
      thread_id: z.string().nullable(),
      payload: z.unknown(),
    }),
  ),
});

export interface ProposalView {
  id: string;
  band: Exclude<Band, "ignore">;
  confidence: number;
  reviewStatus: ReviewStatus;
  threadId: string | null;
  payload: ProposalPayload;
}

export interface ExtractionView {
  id: string;
  sourceId: string;
  status: "running" | "succeeded" | "failed";
  stage: ExtractionStage | null;
  /** Running for 45 s or more: show `extraction_slow`. */
  slow: boolean;
  proposals: ProposalView[];
  brief: unknown;
  error: ApiError["error"] | null;
}

/** Poll read. null = not found for this user (RLS), never revealing whether it exists. */
export async function readExtraction(
  db: RpcDb,
  extractionId: string,
  opts: { now: Date; logger?: Logger },
): Promise<ExtractionView | null> {
  const logger = opts.logger ?? defaultLog;
  const { data, error } = await db.rpc("get_extraction", { p_extraction_id: extractionId, p_now: opts.now.toISOString() });
  if (error) throw new Error(`get_extraction failed: ${errCode(error) ?? "unknown"}`);
  if (data === null || data === undefined) return null;
  const row = Row.parse(data);

  const proposals: ProposalView[] = [];
  for (const p of row.proposals) {
    const payload = ProposalPayload.safeParse(p.payload);
    // Rule 1: a proposal whose stored payload has no verified evidence is never shown.
    if (!payload.success || p.band === "ignore") {
      if (!payload.success) logger("extraction_persist_failed", { extraction_id: row.id, step: "payload_invalid" });
      continue;
    }
    proposals.push({
      id: p.id,
      band: p.band,
      confidence: p.confidence,
      reviewStatus: p.review_status,
      threadId: p.thread_id,
      payload: payload.data,
    });
  }

  const elapsed = opts.now.getTime() - parseInstant(row.created_at).getTime();
  return {
    id: row.id,
    sourceId: row.source_id,
    status: row.status,
    stage: row.status === "running" ? row.stage : null,
    slow: row.status === "running" && elapsed >= SLOW_AFTER_MS,
    proposals: row.status === "succeeded" ? proposals : [],
    brief: row.status === "succeeded" ? row.brief : null,
    error: row.status === "failed" ? apiError("extraction_failed").error : null,
  };
}
