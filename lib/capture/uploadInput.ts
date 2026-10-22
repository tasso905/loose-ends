import { z } from "zod";
import { apiError, type ApiError } from "@/lib/errors";
import type { ReadFailure } from "./document";
import { parsePasteForm, TITLE_MAX_CHARS } from "./pasteInput";

/**
 * F3 upload form fields and the copy for every way a file can be refused (SITE_CONTRACT §2.2,
 * §2.13). Client-safe: no unpdf here.
 *
 * Copy marked PROPOSED is not in SITE_CONTRACT or CONTENT_MODEL and needs the user's approval:
 *   - unsupported_type while DOCX is deferred (D17): "Loose Ends can read PDF, TXT and MD files."
 *     §2.13's documented copy names DOCX, which would be untrue until DOCX is built.
 *   - a DOCX file: "I can't read Word files yet. Save it as a PDF, or paste the text instead."
 *   - a damaged or password-protected PDF: "I couldn't open this PDF. It may be damaged or locked with a password."
 *   - a text file with nothing in it: "This file has no text in it."
 *   - extracted text over 30,000 characters: "This document has {n} characters of text. The limit is 30,000."
 *   - drop zone hint without DOCX: "PDF, TXT or MD · up to 10 MB and 30 pages"
 *   - the chosen-file row's remove button: "Remove" (DESIGN_STANDARD names the button, not its label)
 *   - Add mode tabs show `Paste` and `Upload` only until Quick add (F4) ships
 */

export { SOURCES_BUCKET } from "@/lib/account/deleteAccount";

/** Fields that can carry an upload error. */
export type UploadField = "file" | "title" | "written_on";

/** SITE_CONTRACT §2.2: ≤ 10 MB (also the bucket's file_size_limit) and ≤ 30 pages. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MAX_PAGES = 30;

/** A hint for the picker only: the server sniffs the type from the bytes. */
export const UPLOAD_ACCEPT = ".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown";

const num = (n: number) => n.toLocaleString("en-US");

/** PROPOSED copy (see above); the codes are the documented ones. */
export const UPLOAD_COPY = {
  unsupportedType: "Loose Ends can read PDF, TXT and MD files.",
  docx: "I can't read Word files yet. Save it as a PDF, or paste the text instead.",
  unreadablePdf: "I couldn't open this PDF. It may be damaged or locked with a password.",
  empty: "This file has no text in it.",
  tooLong: (n: number) => `This document has ${num(n)} characters of text. The limit is 30,000.`,
  dropHint: "PDF, TXT or MD · up to 10 MB and 30 pages",
  remove: "Remove",
} as const;

/** The refusal shown for a file (never retryable: the same file can never succeed). */
export function uploadFailure(f: ReadFailure): ApiError["error"] {
  const as = (code: ApiError["error"]["code"], message: string): ApiError["error"] => ({ code, message, retryable: false });
  switch (f.reason) {
    case "file_too_large":
      return apiError("file_too_large", { sizeMb: f.sizeMb }).error;
    case "too_many_pages":
      return apiError("too_many_pages", { n: f.n }).error;
    case "scan":
      return apiError("unsupported_scan").error;
    case "unsupported_type":
      return as("unsupported_type", UPLOAD_COPY.unsupportedType);
    case "docx":
      return as("unsupported_type", UPLOAD_COPY.docx);
    case "unreadable_pdf":
      return as("unsupported_type", UPLOAD_COPY.unreadablePdf);
    case "empty":
      return as("unsupported_type", UPLOAD_COPY.empty);
    case "too_long":
      return as("input_too_long", UPLOAD_COPY.tooLong(f.n));
  }
}

export const UploadForm = z.object({ sourceId: z.uuid(), fileName: z.string().max(1000) });

export type UploadInputError = "bad_upload" | "title_too_long" | "invalid_date";

/**
 * The upload's other fields reuse the paste rules (title ≤ 120, written-on 1900–2100). The title
 * defaults to the file name without its extension, cut to 120 characters.
 */
export function parseUploadForm(form: {
  sourceId: unknown;
  fileName: unknown;
  title: unknown;
  writtenOn: unknown;
  writtenOnSet: unknown;
}):
  | { ok: true; data: { sourceId: string; fileName: string; title: string | null; writtenOn: string | null } }
  | { ok: false; reason: UploadInputError } {
  const ids = UploadForm.safeParse({ sourceId: form.sourceId, fileName: form.fileName });
  if (!ids.success) return { ok: false, reason: "bad_upload" };
  // Paste's parser checks title and date; a placeholder stands in for the text it requires.
  const rest = parsePasteForm({ text: "x", title: form.title, writtenOn: form.writtenOn, writtenOnSet: form.writtenOnSet });
  if (!rest.ok) return { ok: false, reason: rest.reason === "invalid_date" ? "invalid_date" : "title_too_long" };
  const fromName = ids.data.fileName.replace(/\.[^./\\]{1,10}$/, "").trim().slice(0, TITLE_MAX_CHARS).trim();
  return {
    ok: true,
    data: {
      sourceId: ids.data.sourceId,
      fileName: ids.data.fileName,
      title: rest.data.title ?? (fromName === "" ? null : fromName),
      writtenOn: rest.data.writtenOn,
    },
  };
}

/** `{size} MB` for the chosen-file row, one decimal. */
export function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 0.1 ? `${num(Math.round(mb * 10) / 10)} MB` : `${num(Math.max(1, Math.round(bytes / 1024)))} KB`;
}
