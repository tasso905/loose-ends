import { classifyAiError, isRetryableKind, safeErrorName, AskWhyFailedError, type AiFailureKind } from "./errors";
import { ExtractionFailedError } from "./extract";

/**
 * The only fields of an AI error that routes may log or send to Sentry (rule 9).
 *
 * Built field by field from an allow-list, never by spreading the error: `ExtractionFailedError`
 * carries `rawText` (the model's output, which quotes the source), provider errors carry the
 * request body and response text, and any `cause` can hold either. None of that is copied here,
 * and neither is `message` or `stack` (an arbitrary error's message can echo the request).
 *
 * Never throws: every read of the error happens inside try, so a throwing getter or a hostile
 * Proxy yields the "unknown" fallback instead of escaping with its own (possibly content) error.
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

const KINDS: readonly AiFailureKind[] = ["quota", "unavailable", "safety", "malformed", "rejected", "config", "unknown"];
const kindOf = (v: unknown): AiFailureKind => (KINDS.includes(v as AiFailureKind) ? (v as AiFailureKind) : "unknown");

const fallback = (error: string): SafeErrorFields => ({
  error,
  kind: "unknown",
  status: null,
  retryable: false,
  code: null,
  attempts: null,
  model: null,
  latency_ms: null,
  cause_error: null,
});

export function safeErrorFields(err: unknown): SafeErrorFields {
  try {
    return unsafeFields(err);
  } catch {
    return fallback(safeErrorName(err));
  }
}

function unsafeFields(err: unknown): SafeErrorFields {
  const base = fallback(safeErrorName(err));

  if (err instanceof ExtractionFailedError) {
    const kind = kindOf(err.kind);
    return {
      ...base,
      kind,
      status: num(err.status),
      retryable: isRetryableKind(kind),
      code: err.code === "extraction_failed" ? err.code : null,
      attempts: num(err.attempts),
      model: typeof err.model === "string" && MODEL.test(err.model) ? err.model : null,
      latency_ms: num(err.latencyMs),
      cause_error: safeName(err.causeMessage),
    };
  }
  if (err instanceof AskWhyFailedError) {
    return { ...base, kind: kindOf(err.kind), status: num(err.status), retryable: err.retryable === true, latency_ms: num(err.latencyMs) };
  }
  const f = classifyAiError(err);
  return { ...base, kind: f.kind, status: num(f.status), retryable: f.retryable };
}
