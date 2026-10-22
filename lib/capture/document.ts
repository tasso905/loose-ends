import { extractText, getDocumentProxy } from "unpdf";
import { PASTE_MAX_CHARS } from "./pasteInput";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_PAGES } from "./uploadInput";

/**
 * F3 upload: turns an uploaded file into source text (PRD pipeline step 1, SITE_CONTRACT §2.2).
 *
 * - The type is sniffed from the bytes, never taken from the file name or the browser's MIME type.
 *   PDF: `%PDF-` near the start. Text (TXT, MD): valid UTF-8 with no NUL bytes; the name only picks
 *   between text/plain and text/markdown. DOCX is a ZIP and is refused while DOCX is deferred
 *   (D17, Oct 25 review). Anything else is refused.
 * - Limits: 10 MB, 30 pages, and the same 30,000-character cap as paste (extract() never sees more).
 * - A PDF whose pages carry no text layer is a scan and is refused with `unsupported_scan`: nothing
 *   is guessed (F3).
 * - PDF pages are joined with a blank line; `pageOffsets[i]` is where page i + 1 starts in the
 *   text, so a verified quote can say "p. 2" (`pageForOffset`).
 */

export { UPLOAD_MAX_BYTES, UPLOAD_MAX_PAGES };
/** A page with fewer letters and digits than this is treated as having no text layer. */
export const SCAN_MIN_CHARS_PER_PAGE = 25;
const PAGE_SEPARATOR = "\n\n";

export type UploadMimeType = "application/pdf" | "text/plain" | "text/markdown";
/** "text" is UTF-8; "text1252" is a Windows-1252 / Latin-1 text file (not valid UTF-8). */
export type SniffedType = "pdf" | "text" | "text1252" | "zip" | "unknown";

export type ReadFailure =
  | { reason: "file_too_large"; sizeMb: number }
  | { reason: "unsupported_type" }
  | { reason: "docx" }
  | { reason: "unreadable_pdf" }
  | { reason: "too_many_pages"; n: number }
  | { reason: "scan" }
  | { reason: "empty" }
  | { reason: "too_long"; n: number };

export interface ReadDocument {
  text: string;
  mimeType: UploadMimeType;
  /** Start offset of each page (PDF only). */
  pageOffsets: number[] | null;
  pageCount: number | null;
}

export type ReadResult = ({ ok: true } & ReadDocument) | ({ ok: false } & ReadFailure);

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

function indexOfBytes(bytes: Uint8Array, needle: string): number {
  const n = Uint8Array.from(needle, (c) => c.charCodeAt(0));
  outer: for (let i = 0; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

export function sniffType(bytes: Uint8Array): SniffedType {
  // PDF readers accept the header anywhere in the first 1024 bytes.
  if (indexOfBytes(bytes.subarray(0, 1024), "%PDF-") >= 0) return "pdf";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "PK\x03\x04") return "zip";
  if (bytes.includes(0)) return "unknown";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "text";
  } catch {
    // Mostly UTF-8 with a stray byte (a mixed-encoding export, a file cut mid-character): the valid
    // multi-byte letters stay as written and the stray byte becomes U+FFFD, never mojibake.
    if (!hasStrayControlBytes(bytes) && mostlyUtf8(bytes)) return "text";
    return isWindows1252Text(bytes) ? "text1252" : "unknown";
  }
}

/** Control bytes other than tab, line breaks and form feed (text files have none; binaries do). */
const hasStrayControlBytes = (bytes: Uint8Array) =>
  bytes.some((b) => (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d) || b === 0x7f);

/** At most this share of a mostly-UTF-8 file may be stray (invalid) bytes. */
const UTF8_MAX_STRAY_SHARE = 0.01;

/**
 * UTF-8 with a few stray bytes: well-formed multi-byte sequences at least twice the stray high
 * bytes, and the stray bytes at most 1% of the file (a random buffer has far more). A Windows-1252
 * file has the reverse, an accidental valid pair ("É" + NBSP in "RÉSUMÉ :") among many stray
 * accented letters, so it is read as Windows-1252.
 */
function mostlyUtf8(bytes: Uint8Array): boolean {
  const cont = (b: number | undefined) => b !== undefined && b >= 0x80 && b <= 0xbf;
  let valid = 0;
  let stray = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 0x80) continue;
    const n = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;
    let ok = n > 0;
    for (let k = 1; ok && k <= n; k++) if (!cont(bytes[i + k])) ok = false;
    if (ok) {
      valid++;
      i += n;
    } else {
      stray++;
    }
  }
  return valid > 0 && valid >= 2 * stray && stray <= Math.max(1, bytes.length * UTF8_MAX_STRAY_SHARE);
}

/** Bytes Windows-1252 leaves undefined. */
const CP1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
/** Latin-1 prose has a few accented letters, not a majority of high bytes. */
const CP1252_MAX_HIGH_SHARE = 0.3;

/**
 * Not UTF-8, but plausibly a Windows-1252 / Latin-1 text file (common for exported notes): no
 * control bytes other than tab, line breaks and form feed, no byte 1252 leaves undefined, and
 * mostly ASCII. Binary formats almost always fail the control-byte check.
 */
function isWindows1252Text(bytes: Uint8Array): boolean {
  if (hasStrayControlBytes(bytes)) return false;
  let high = 0;
  for (const b of bytes) {
    if (CP1252_UNDEFINED.has(b)) return false;
    if (b >= 0x80) high++;
  }
  return bytes.length > 0 && high / bytes.length <= CP1252_MAX_HIGH_SHARE;
}

/** Word documents name their main part `word/document.xml` in the ZIP directory (stored uncompressed). */
const isDocx = (bytes: Uint8Array) => indexOfBytes(bytes, "word/document.xml") >= 0;

const visibleChars = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** Line breaks to `\n`, no NULs, no trailing spaces on a line, no blank lines at either end. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/^﻿/, "")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/^\n+|\n+$/g, "");
}

/** Joins cleaned pages and records where each starts. */
export function joinPages(pages: string[]): { text: string; pageOffsets: number[] } {
  const pageOffsets: number[] = [];
  let text = "";
  pages.forEach((page, i) => {
    if (i > 0) text += PAGE_SEPARATOR;
    pageOffsets.push(text.length);
    text += page;
  });
  return { text, pageOffsets };
}

async function readPdf(bytes: Uint8Array): Promise<ReadResult> {
  let pages: string[];
  try {
    // pdf.js takes ownership of the buffer it is given: pass a copy so the caller keeps its bytes.
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    if (doc.numPages > UPLOAD_MAX_PAGES) return { ok: false, reason: "too_many_pages", n: doc.numPages };
    pages = (await extractText(doc, { mergePages: false })).text.map(cleanText);
  } catch {
    // Damaged, encrypted or not really a PDF.
    return { ok: false, reason: "unreadable_pdf" };
  }
  if (!pages.some((p) => visibleChars(p) >= SCAN_MIN_CHARS_PER_PAGE)) return { ok: false, reason: "scan" };
  const { text, pageOffsets } = joinPages(pages);
  if (text.length > PASTE_MAX_CHARS) return { ok: false, reason: "too_long", n: text.length };
  return { ok: true, text, mimeType: "application/pdf", pageOffsets, pageCount: pages.length };
}

export async function readDocument(bytes: Uint8Array, fileName: string): Promise<ReadResult> {
  if (bytes.length > UPLOAD_MAX_BYTES) return { ok: false, reason: "file_too_large", sizeMb: bytes.length / (1024 * 1024) };
  const type = sniffType(bytes);
  if (type === "pdf") return readPdf(bytes);
  if (type === "zip") return isDocx(bytes) ? { ok: false, reason: "docx" } : { ok: false, reason: "unsupported_type" };
  if (type !== "text" && type !== "text1252") return { ok: false, reason: "unsupported_type" };

  const text = cleanText(new TextDecoder(type === "text" ? "utf-8" : "windows-1252").decode(bytes));
  if (text.trim() === "") return { ok: false, reason: "empty" };
  if (text.length > PASTE_MAX_CHARS) return { ok: false, reason: "too_long", n: text.length };
  const mimeType: UploadMimeType = /\.(md|markdown)$/i.test(fileName) ? "text/markdown" : "text/plain";
  return { ok: true, text, mimeType, pageOffsets: null, pageCount: null };
}
