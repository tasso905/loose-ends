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
  | "save_failed";

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
};

const num = (n: number) => n.toLocaleString("en-US");

const COPY: { [K in ErrorCode]: { retryable: boolean; status: number; message: (p: Params[K]) => string } } = {
  input_too_long: {
    retryable: false,
    status: 413,
    message: (p) => `That's ${num(p.n)} characters. The limit is 30,000 — trim it or split it into two pastes.`,
  },
  unsupported_type: { retryable: false, status: 415, message: () => "Loose Ends can read PDF, TXT, MD and DOCX files." },
  file_too_large: {
    retryable: false,
    status: 413,
    message: (p) => `This file is ${num(Math.round(p.sizeMb * 10) / 10)} MB. The limit is 10 MB.`,
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
};

/** `extraction_slow` is a status, not an error (PRD API Requirements). */
export const EXTRACTION_SLOW_MESSAGE = "Still working — we'll show results here.";

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
