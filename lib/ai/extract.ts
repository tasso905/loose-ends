import { NoObjectGeneratedError, generateObject, type LanguageModel } from "ai";
import { log as defaultLog, type Logger } from "@/lib/log";
import { classifyAiError, type AiFailureKind } from "./errors";
import { EXTRACTION_SCHEMA_VERSION, ExtractionModelSchema, type Extraction, type ItemType } from "./schema";
import { EXTRACT_PROMPT_VERSION, block, loadPrompt } from "./prompts";
import { getModel } from "./provider";

/**
 * F5 extraction call: one `generateObject` call, temperature 0, Zod-validated, one retry on
 * failure, then ExtractionFailedError (`extraction_failed`). The retry is skipped when it cannot
 * help (provider quota, safety block, rejected request, config error; see lib/ai/errors.ts), so a
 * failure does not spend a second call. Returns the validated model output
 * plus the trace fields every `extractions` row records (model, prompt version, schema version,
 * token counts, latency). Post-processing (quote verification, date re-resolution, scoring)
 * happens in lib/pipeline and is not done here.
 */

export const MAX_INPUT_CHARS = 30_000;
export const MAX_OPEN_THREADS_IN_CONTEXT = 30;

export interface ExtractInput {
  sourceText: string;
  sourceKind: "paste" | "upload" | "quick_add" | "email_forward";
  /** YYYY-MM-DD */
  referenceDate: string;
  referenceDateSource: "user" | "detected" | "defaulted";
  timezone: string;
  user: { displayName: string; aliases: string[] };
  enabledTypes?: ItemType[];
  openThreads?: Array<{ id: string; title: string }>;
}

export interface ExtractRun {
  output: Extraction;
  /** The model's validated object before server-side sanitizing; stored as `extractions.raw_output`. */
  raw: Extraction;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  attempts: number;
}

export class ExtractionFailedError extends Error {
  readonly code = "extraction_failed" as const;
  constructor(
    readonly attempts: number,
    readonly model: string,
    /** Error class name only (never the provider message, which can echo the request). */
    readonly causeMessage: string,
    readonly latencyMs: number,
    /** Last raw model text, if any; stored in `extractions.raw_output` for debugging, never logged. */
    readonly rawText: string | null,
    readonly kind: AiFailureKind = "unknown",
    readonly status: number | null = null,
  ) {
    super(`Extraction failed after ${attempts} attempt(s): ${kind}${status ? ` (${status})` : ""}`);
    this.name = "ExtractionFailedError";
  }
}

export interface ExtractDeps {
  model?: LanguageModel;
  modelLabel?: string;
  logger?: Logger;
  extractionId?: string;
}

export function buildExtractPrompt(input: ExtractInput): string {
  const threads = (input.openThreads ?? []).slice(0, MAX_OPEN_THREADS_IN_CONTEXT);
  const context = [
    `The user: ${[input.user.displayName, ...input.user.aliases].filter(Boolean).join(", ") || "(no names given)"}`,
    `Timezone: ${input.timezone}`,
    `Reference date (when this was written): ${input.referenceDate} (${input.referenceDateSource})`,
    `Source kind: ${input.sourceKind}`,
    `Item types to look for: ${(input.enabledTypes ?? []).length ? input.enabledTypes!.join(", ") : "all"}`,
    `Open threads (id: title):${threads.length ? "\n" + threads.map((t) => `- ${t.id}: ${t.title}`).join("\n") : " none"}`,
  ].join("\n");
  return `${block("context", context)}\n\n${block("source", input.sourceText)}`;
}

export async function extract(input: ExtractInput, deps: ExtractDeps = {}): Promise<ExtractRun> {
  if (input.sourceText.length > MAX_INPUT_CHARS) {
    throw new RangeError(`Input is ${input.sourceText.length} characters; the limit is ${MAX_INPUT_CHARS}.`);
  }
  const resolved = deps.model ? null : getModel();
  const model = deps.model ?? resolved!.model;
  const label = deps.modelLabel ?? resolved?.label ?? "injected";
  const logger = deps.logger ?? defaultLog;
  const system = loadPrompt(EXTRACT_PROMPT_VERSION);
  const prompt = buildExtractPrompt(input);
  const allowedThreadIds = new Set((input.openThreads ?? []).slice(0, MAX_OPEN_THREADS_IN_CONTEXT).map((t) => t.id));

  const started = performance.now();
  let lastError = "unknown error";
  let lastRawText: string | null = null;
  let lastFailure = classifyAiError(undefined);
  let attempt = 0;
  while (attempt < 2) {
    attempt++;
    try {
      const result = await generateObject({ model, schema: ExtractionModelSchema, system, prompt, temperature: 0, maxRetries: 0 });
      const output: Extraction = {
        ...result.object,
        // matches_thread_id is honored only if that ID was in the context list (PRD pipeline step 8).
        items: result.object.items.map((it) =>
          it.matches_thread_id && !allowedThreadIds.has(it.matches_thread_id) ? { ...it, matches_thread_id: null } : it,
        ),
      };
      return {
        output,
        raw: result.object,
        model: label,
        promptVersion: EXTRACT_PROMPT_VERSION,
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
        latencyMs: Math.round(performance.now() - started),
        attempts: attempt,
      };
    } catch (err) {
      // Rule 9: only the error class name and the classification are kept; provider errors carry
      // the request body (source text) and must not be logged or rethrown.
      lastError = err instanceof Error ? err.name : "non_error_thrown";
      lastRawText = NoObjectGeneratedError.isInstance(err) ? (err.text ?? null) : null;
      lastFailure = classifyAiError(err);
      if (!lastFailure.retryable) break;
      if (attempt === 1) {
        logger("extraction_retry", {
          extraction_id: deps.extractionId ?? null,
          error: lastError,
          kind: lastFailure.kind,
          status: lastFailure.status,
        });
      }
    }
  }
  throw new ExtractionFailedError(
    attempt,
    label,
    lastError,
    Math.round(performance.now() - started),
    lastRawText,
    lastFailure.kind,
    lastFailure.status,
  );
}
