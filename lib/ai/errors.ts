import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  JSONParseError,
  LoadAPIKeyError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoSuchModelError,
  RetryError,
  TypeValidationError,
} from "ai";
import { AiConfigError } from "./provider";

/**
 * Classifies a failed model call into a small enum that is safe to log (rule 9) and decides
 * whether another attempt can help. Provider errors from the AI SDK carry the request body
 * (`APICallError.requestBodyValues`, i.e. the prompt and source text) and the response body, so
 * callers log only the `AiFailure` fields and never the original error object.
 *
 * User-facing mapping (SITE_CONTRACT §2.13): every extraction failure, whatever its kind, surfaces
 * as `extraction_failed` via ExtractionFailedError. The provider's own quota (429) is NOT our
 * per-user `rate_limited`: that copy names the user's daily limit, which is not what happened.
 * §2.13 has no Ask-why failure row yet; askWhy() throws AskWhyFailedError and the Decisions page
 * shows its generic page-banner error state (§2.14).
 */

export type AiFailureKind =
  | "quota" // provider 429 / RESOURCE_EXHAUSTED (free-tier per-minute or per-day limit)
  | "unavailable" // provider 5xx, network error, timeout, empty response
  | "safety" // prompt or response blocked by the provider's safety filters
  | "malformed" // output was not valid JSON, failed Zod validation, or was cut off
  | "rejected" // provider 400: the request itself was refused (e.g. an unsupported schema keyword)
  | "config" // missing/invalid key or model, unregistered provider, no recording (fake)
  | "unknown";

export interface AiFailure {
  kind: AiFailureKind;
  /** HTTP status from the provider, if there was one. */
  status: number | null;
  /** Whether repeating the same call could succeed. */
  retryable: boolean;
}

const RETRYABLE: Record<AiFailureKind, boolean> = {
  quota: false, // an immediate repeat hits the same limit and spends more of the free-tier quota
  unavailable: true,
  safety: false,
  malformed: true,
  rejected: false,
  config: false,
  unknown: true,
};

/** Whether a failure of this kind can succeed on another attempt (the table above). */
export const isRetryableKind = (kind: AiFailureKind): boolean => RETRYABLE[kind];

const failure = (kind: AiFailureKind, status: number | null = null): AiFailure => ({ kind, status, retryable: RETRYABLE[kind] });

/**
 * Never throws: an error with a throwing getter or a hostile Proxy classifies as "unknown"
 * instead of escaping the caller's catch block with its own (possibly content-bearing) error.
 */
export function classifyAiError(err: unknown): AiFailure {
  try {
    return classify(err);
  } catch {
    return failure("unknown");
  }
}

const ERROR_NAME = /^[A-Za-z_$][\w$.]{0,63}$/;

/**
 * The error's class name if it looks like an identifier, "Error" otherwise, "non_error_thrown"
 * for non-Errors. Never throws (getters and Proxies are read inside try). The one name helper for
 * every AI log line and safeErrorFields() (rule 9).
 */
export function safeErrorName(err: unknown): string {
  try {
    if (!(err instanceof Error)) return "non_error_thrown";
    const name: unknown = err.name;
    return typeof name === "string" && ERROR_NAME.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

function classify(err: unknown): AiFailure {
  if (RetryError.isInstance(err)) return classify(err.lastError);
  if (err instanceof AiConfigError || LoadAPIKeyError.isInstance(err) || NoSuchModelError.isInstance(err)) return failure("config");
  if (err instanceof Error && err.name === "NoRecordingError") return failure("config");

  if (APICallError.isInstance(err)) {
    const status = err.statusCode ?? null;
    if (status === 429) return failure("quota", status);
    if (status === 401 || status === 403 || status === 404) return failure("config", status);
    if (status !== null && status >= 500) return failure("unavailable", status);
    if (status === 400 || status === 422) return failure("rejected", status);
    return failure(err.isRetryable ? "unavailable" : "unknown", status);
  }

  if (NoObjectGeneratedError.isInstance(err)) {
    // Gemini reports SAFETY / PROHIBITED_CONTENT / prompt blockReason as finishReason "content-filter".
    if (err.finishReason === "content-filter") return failure("safety");
    return failure("malformed");
  }
  if (TypeValidationError.isInstance(err) || JSONParseError.isInstance(err)) return failure("malformed");
  if (NoContentGeneratedError.isInstance(err) || EmptyResponseBodyError.isInstance(err) || InvalidResponseDataError.isInstance(err)) {
    return failure("unavailable");
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return failure("unavailable");
  if (err instanceof TypeError && /fetch/i.test(err.message)) return failure("unavailable");
  return failure("unknown");
}

/**
 * Thrown by askWhy() when the model call fails. Carries only the classification: no message,
 * request or response text from the provider, and no `cause`, so error reporters (Sentry) cannot
 * serialize the question or the retrieved decisions.
 */
export class AskWhyFailedError extends Error {
  readonly kind: AiFailureKind;
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(
    f: AiFailure,
    readonly latencyMs: number,
  ) {
    super(`Ask why failed: ${f.kind}${f.status ? ` (${f.status})` : ""}`);
    this.name = "AskWhyFailedError";
    this.kind = f.kind;
    this.status = f.status;
    this.retryable = f.retryable;
  }
}
