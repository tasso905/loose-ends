import { classifyAiError, isRetryableKind, AskWhyFailedError, type AiFailureKind } from "./errors";
import { ExtractionFailedError } from "./extract";

/**
 * The only fields of an AI error that routes may log or send to Sentry (rule 9).
 *
 * Built field by field from an allow-list, never by spreading the error: `ExtractionFailedError`
 * carries `rawText` (the model's output, which quotes the source), provider errors carry the
 * request body and response text, and any `cause` can hold either. None of that is copied here,
 * and neither is `message` or `stack` (an arbitrary error's message can echo the request).
 *
 * Usage: `log("…", { ...safeErrorFields(err), extraction_id })` or
 * `Sentry.captureMessage("ai_failed", { extra: safeErrorFields(err) })`; never pass `err` itself.
 */
export interface SafeErrorFields {
  [key: string]: string | number | boolean | null;
  /** Error class name, e.g. "ExtractionFailedError" or "AI_APICallError". */
  error: string;
  kind: AiFailureKind;
  status: number | null;
  retryable: boolean;
  /** `extraction_failed` for ExtractionFailedError, otherwise null. */
  code: string | null;
  attempts: number | null;
  /** Provider label, e.g. "google:gemini-3.5-flash". */
  model: string | null;
  latency_ms: number | null;
  /** For ExtractionFailedError: the class name of the last underlying error (never its message). */
  cause_error: string | null;
}

const MODEL = /^[\w.:/-]{1,100}$/;
const NAME = /^[A-Za-z_$][\w$.]{0,63}$/;
const safeName = (v: unknown): string => (typeof v === "string" && NAME.test(v) ? v : "Error");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function safeErrorFields(err: unknown): SafeErrorFields {
  const base: SafeErrorFields = {
    error: err instanceof Error ? safeName(err.name) : "non_error_thrown",
    kind: "unknown",
    status: null,
    retryable: false,
    code: null,
    attempts: null,
    model: null,
    latency_ms: null,
    cause_error: null,
  };

  if (err instanceof ExtractionFailedError) {
    return {
      ...base,
      kind: err.kind,
      status: num(err.status),
      retryable: isRetryableKind(err.kind),
      code: err.code,
      attempts: num(err.attempts),
      model: typeof err.model === "string" && MODEL.test(err.model) ? err.model : null,
      latency_ms: num(err.latencyMs),
      cause_error: safeName(err.causeMessage),
    };
  }
  if (err instanceof AskWhyFailedError) {
    return { ...base, kind: err.kind, status: num(err.status), retryable: err.retryable, latency_ms: num(err.latencyMs) };
  }
  const f = classifyAiError(err);
  return { ...base, kind: f.kind, status: num(f.status), retryable: f.retryable };
}
