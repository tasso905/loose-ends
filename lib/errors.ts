/**
 * Error envelope `{error: {code, message, retryable}}` with the user-facing copy from
 * SITE_CONTRACT §2.13. Copy here must match the contract word for word.
 */

export type ErrorCode =
  | "input_too_long"
  | "unsupported_type"
  | "file_too_large"
  | "too_many_pages"
  | "unsupported_scan"
  | "extraction_failed"
  | "rate_limited"
  | "invalid_transition"
  | "offline"
  | "save_failed"
  | "not_found"
  | "unauthenticated"
  | "invalid_input"
  | "retry_limit";

export interface ApiError {
  error: { code: ErrorCode; message: string; retryable: boolean };
}

type Params = {
  input_too_long: { n: number };
  unsupported_type: undefined;
  file_too_large: { sizeMb: number };
  too_many_pages: { n: number };
  unsupported_scan: undefined;
  extraction_failed: undefined;
  rate_limited: { limit: number; kind: "sources" | "questions"; timezone: string };
  invalid_transition: undefined;
  offline: undefined;
  save_failed: undefined;
  not_found: undefined;
  unauthenticated: undefined;
  invalid_input: { field: InputField };
  retry_limit: { n: number };
};

/** Fields that can carry an `invalid_input` error on the Add form. */
export type InputField = "text" | "title" | "written_on";

const num = (n: number) => n.toLocaleString("en-US");
/**
 * A size to one decimal that never rounds down onto the 10 MB limit: a file just over the limit
 * reads "10.1 MB", not "10 MB. The limit is 10 MB."
 */
const sizeOverLimit = (mb: number) => {
  const r = Math.round(mb * 10) / 10;
  return mb > 10 && r <= 10 ? Math.ceil(mb * 10) / 10 : r;
};

const COPY: { [K in ErrorCode]: { retryable: boolean; status: number; message: (p: Params[K]) => string } } = {
  input_too_long: {
    retryable: false,
    status: 413,
    message: (p) => `That's ${num(p.n)} characters. The limit is 30,000 — trim it or split it into two pastes.`,
  },
  unsupported_type: { retryable: false, status: 415, message: () => "Loose Ends can read PDF, TXT and MD files." },
  file_too_large: {
    retryable: false,
    status: 413,
    message: (p) => `This file is ${num(sizeOverLimit(p.sizeMb))} MB. The limit is 10 MB.`,
  },
  too_many_pages: { retryable: false, status: 413, message: (p) => `This document has ${num(p.n)} pages. The limit is 30.` },
  unsupported_scan: { retryable: false, status: 422, message: () => "This looks like a scan. I can't read scans yet." },
  extraction_failed: { retryable: true, status: 502, message: () => "Something went wrong reading this. Your text is saved." },
  rate_limited: {
    retryable: false,
    status: 429,
    message: (p) =>
      `You've reached today's limit of ${num(p.limit)} ${p.kind}. It resets at midnight (${p.timezone}).`,
  },
  invalid_transition: {
    retryable: false,
    status: 409,
    message: () => "That change isn't possible any more. Refresh to see the latest.",
  },
  offline: { retryable: true, status: 503, message: () => "You're offline. Nothing was saved." },
  save_failed: { retryable: true, status: 500, message: () => "That didn't save. Try again." },
  // HTTP-only codes for route handlers (S2 poll route). Not in §2.13 yet: pages render the
  // not-found page and the sign-in redirect instead, so users do not normally see these strings.
  not_found: { retryable: false, status: 404, message: () => "This doesn't exist or was deleted." },
  unauthenticated: { retryable: false, status: 401, message: () => "Sign in to continue." },
  // APPROVED copy (S2-4; user, Oct 21; not in §2.13 yet). Shown at the field, not as a retryable
  // save failure, because resubmitting the same value can never succeed.
  invalid_input: { retryable: false, status: 422, message: (p) => INVALID_INPUT_COPY[p.field] },
  // APPROVED copy for the Try again cap (MAX_RETRIES_PER_SOURCE = 3 per source; user, Oct 21. It
  // replaces "always offered" in SITE_CONTRACT §2.13).
  retry_limit: {
    retryable: false,
    status: 429,
    message: (p) => `I couldn't read this after ${num(p.n)} more tries. Your text is saved.`,
  },
};

/** APPROVED field copy (S2-4; user, Oct 21). */
const INVALID_INPUT_COPY: Record<InputField, string> = {
  text: "Paste some text first.",
  title: "Titles can be up to 120 characters.",
  written_on: "Enter a real date between 1900 and 2100.",
};

/** `extraction_slow` is a status, not an error (PRD API Requirements). */
export const EXTRACTION_SLOW_MESSAGE = "Still working. I'll show results here.";

export function apiError<K extends ErrorCode>(
  code: K,
  ...params: Params[K] extends undefined ? [] : [Params[K]]
): ApiError {
  const spec = COPY[code];
  return { error: { code, message: spec.message(params[0] as Params[K]), retryable: spec.retryable } };
}

export function errorStatus(code: ErrorCode): number {
  return COPY[code].status;
}

/** Route-handler helper: JSON error envelope with the matching HTTP status. */
export function errorResponse<K extends ErrorCode>(
  code: K,
  ...params: Params[K] extends undefined ? [] : [Params[K]]
): Response {
  return Response.json(apiError(code, ...params), { status: COPY[code].status });
}
