import { createHash } from "node:crypto";
import type { Brief, BriefLine, Item } from "@/lib/ai/schema";
import { log as defaultLog, type Logger } from "@/lib/log";
import { normalizeForMatch, normalizeText, pageForOffset, toOriginalRange, type Normalized } from "./normalize";

/**
 * Rule 1: no verified quote, no item. Every quote is checked against the source text:
 * exact substring of the normalized text first, else the best approximate substring
 * (Sellers edit-distance search) with similarity ≥ 0.9. Unverified quotes are dropped and
 * logged as `quote_unverified`; an item with no verified quote left is dropped.
 *
 * The stored quote is the source's own text at the matched span, never the model's copy.
 */

export const FUZZY_THRESHOLD = 0.9;

export type MatchKind = "exact" | "fuzzy";

export interface QuoteMatch {
  match_kind: MatchKind;
  similarity: number;
  /** Offsets into the original (un-normalized) source text. */
  start_offset: number;
  end_offset: number;
  /** Verbatim source text at [start_offset, end_offset). */
  quote: string;
}

export interface VerifiedEvidence extends QuoteMatch {
  speaker: string | null;
  page: number | null;
  quote_hash: string;
}

export interface VerifiedItem {
  /** Index in the model's items array, for traceability in the extraction log. */
  index: number;
  item: Item;
  evidence: VerifiedEvidence[];
}

export interface DroppedQuote {
  itemIndex: number;
  evidenceIndex: number;
  similarity: number;
}

export interface VerifyResult {
  items: VerifiedItem[];
  droppedQuotes: DroppedQuote[];
  droppedItemIndexes: number[];
}

export interface VerifyOptions {
  pageOffsets?: number[] | null;
  extractionId?: string | null;
  logger?: Logger;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Hash of a quote, insensitive to whitespace and typographic quote differences. */
export function quoteHash(quote: string): string {
  return sha256(normalizeText(quote).toLowerCase());
}

export function sourceTextHash(text: string): string {
  return sha256(normalizeText(text));
}

/** `extraction_items.suppression_hash`: hash(source text hash + quote). Used for dismiss/reject. */
export function suppressionHash(sourceText: string, quote: string): string {
  return sha256(`${sourceTextHash(sourceText)}:${quoteHash(quote)}`);
}

/** Best approximate occurrence of `pattern` anywhere in `text` (edit distance, free start/end in text). */
export function approximateSearch(pattern: string, text: string): { distance: number; start: number; end: number } {
  const m = pattern.length;
  const n = text.length;
  if (m === 0) return { distance: 0, start: 0, end: 0 };

  let prev = new Int32Array(n + 1); // row 0: empty pattern matches anywhere at cost 0
  let prevStart = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prevStart[j] = j;
  let cur = new Int32Array(n + 1);
  let curStart = new Int32Array(n + 1);

  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    curStart[0] = 0;
    const pc = pattern.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = pc === text.charCodeAt(j - 1) ? 0 : 1;
      let best = (prev[j - 1] as number) + cost;
      let start = prevStart[j - 1] as number;
      const up = (prev[j] as number) + 1;
      if (up < best) {
        best = up;
        start = prevStart[j] as number;
      }
      const left = (cur[j - 1] as number) + 1;
      if (left < best) {
        best = left;
        start = curStart[j - 1] as number;
      }
      cur[j] = best;
      curStart[j] = start;
    }
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }

  let bestJ = 0;
  for (let j = 1; j <= n; j++) if ((prev[j] as number) < (prev[bestJ] as number)) bestJ = j;
  return { distance: prev[bestJ] as number, start: prevStart[bestJ] as number, end: bestJ };
}

/** Find a quote in an already-normalized source. Returns null when similarity < threshold. */
export function matchQuote(quote: string, source: Normalized, threshold = FUZZY_THRESHOLD): QuoteMatch | { similarity: number } {
  const q = normalizeText(quote);
  if (q.length === 0) return { similarity: 0 };

  const exactAt = source.text.indexOf(q);
  if (exactAt >= 0) {
    const r = toOriginalRange(source, exactAt, exactAt + q.length);
    return { match_kind: "exact", similarity: 1, start_offset: r.start, end_offset: r.end, quote: "" };
  }

  // Fuzzy: case-insensitive approximate search over the normalized text.
  const { distance, start, end } = approximateSearch(q.toLowerCase(), source.text.toLowerCase());
  const matchLen = end - start;
  const similarity = matchLen === 0 ? 0 : 1 - distance / Math.max(q.length, matchLen);
  if (similarity < threshold) return { similarity };
  const r = toOriginalRange(source, start, end);
  return { match_kind: "fuzzy", similarity, start_offset: r.start, end_offset: r.end, quote: "" };
}

function isMatch(m: QuoteMatch | { similarity: number }): m is QuoteMatch {
  return "match_kind" in m;
}

/** Locate a quote in the original source text, filling in the verbatim source span. */
export function locateQuote(quote: string, sourceText: string, normalized = normalizeForMatch(sourceText)): QuoteMatch | null {
  const m = matchQuote(quote, normalized);
  if (!isMatch(m)) return null;
  return { ...m, quote: sourceText.slice(m.start_offset, m.end_offset) };
}

export function verifyQuotes(items: Item[], sourceText: string, opts: VerifyOptions = {}): VerifyResult {
  const logger = opts.logger ?? defaultLog;
  const normalized = normalizeForMatch(sourceText);
  const result: VerifyResult = { items: [], droppedQuotes: [], droppedItemIndexes: [] };

  items.forEach((item, itemIndex) => {
    const evidence: VerifiedEvidence[] = [];
    item.evidence.forEach((ev, evidenceIndex) => {
      const m = matchQuote(ev.quote, normalized);
      if (!isMatch(m)) {
        const similarity = Math.round(m.similarity * 1000) / 1000;
        result.droppedQuotes.push({ itemIndex, evidenceIndex, similarity });
        logger("quote_unverified", { extraction_id: opts.extractionId ?? null, item_index: itemIndex, evidence_index: evidenceIndex, similarity });
        return;
      }
      const quote = sourceText.slice(m.start_offset, m.end_offset);
      evidence.push({
        ...m,
        quote,
        speaker: ev.speaker,
        page: pageForOffset(opts.pageOffsets, m.start_offset),
        quote_hash: quoteHash(quote),
      });
    });

    if (evidence.length === 0) {
      result.droppedItemIndexes.push(itemIndex);
      return;
    }
    result.items.push({ index: itemIndex, item: verifyFields(item, normalized.text, itemIndex, opts, logger), evidence });
  });

  return result;
}

/**
 * Rule 3: never fill a missing date, amount or name. `date_text`, `amount_text` and `counterparty`
 * must appear in the source (case-insensitive, normalized); otherwise they are cleared and logged.
 * A cleared `date_text` leaves any model `date_iso` unanchored, so no due date is set.
 */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when `needle` occurs in `haystack` as whole words: normalized, case-insensitive, and not
 * glued to a letter or digit on either side (Unicode-aware). "May" is not in "Maybe", "Mon" is
 * not in "Monica"; "10/9", "Oct. 9" and "$2,400" match where they appear as written, but not as
 * the front or back of a longer number. Dates also refuse a following year; amounts refuse a
 * following space-separated digit group.
 */
export function containsWholePhrase(haystack: string, needle: string, kind: "date" | "amount" | "text" = "text"): boolean {
  const n = normalizeText(needle);
  if (n.length === 0) return false;
  // Not glued to a letter or digit, and not the front or back of a longer number
  // ("$2,400" in "$2,400,000", "$1,470" in "$1,470.50", "10/9" in "10/9/2027").
  let after = "(?![\\p{L}\\p{N}])(?![.,/:-]\\p{N})";
  // A date phrase must not drop a year written after it ("Oct 9" in "Oct 9, 2027", "9 Oct 2027").
  if (kind === "date") after += "(?!,?\\s*(?:\\d{4}|'\\d{2})(?!\\p{N}))";
  // An amount must not be the front of a space-grouped number ("$2,400" in "$2,400 000").
  if (kind === "amount") after += "(?!\\s\\d{3}(?!\\p{N}))";
  // ...nor a year written before it ("Oct 9" in "2027 Oct 9").
  const before = kind === "date" ? "(?<!(?:\\d{4}|'\\d{2}),?\\s*)" : "";
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?<!\\p{N}[.,/:-])${before}${escapeRegExp(n)}${after}`, "iu");
  return re.test(normalizeText(haystack));
}

function verifyFields(item: Item, normalizedSource: string, itemIndex: number, opts: VerifyOptions, logger: Logger): Item {
  const KIND = { date_text: "date", amount_text: "amount", counterparty: "text" } as const;
  const out = { ...item };
  for (const field of ["date_text", "amount_text", "counterparty"] as const) {
    const v = out[field];
    if (v !== null && !containsWholePhrase(normalizedSource, v, KIND[field])) {
      out[field] = null;
      logger("field_unverified", { extraction_id: opts.extractionId ?? null, item_index: itemIndex, field });
    }
  }
  return out;
}

export interface VerifiedBriefLine extends BriefLine {
  match: QuoteMatch | null;
}

export type VerifiedBrief = { [K in keyof Omit<Brief, "not_sure_about">]: VerifiedBriefLine[] } & { not_sure_about: string[] };

/**
 * Explain card lines: a `source` line keeps its place only if its quote verifies (it then
 * carries the verbatim span); otherwise it is dropped. `worth_considering` is interpretation by
 * definition. Interpretation lines never carry a quote (DESIGN_STANDARD "Three voices").
 */
export function verifyBrief(brief: Brief, sourceText: string, opts: VerifyOptions = {}): VerifiedBrief {
  const logger = opts.logger ?? defaultLog;
  const normalized = normalizeForMatch(sourceText);
  const section = (lines: BriefLine[], name: string, forceInterpretation = false): VerifiedBriefLine[] =>
    lines.flatMap((line, i): VerifiedBriefLine[] => {
      if (forceInterpretation || line.basis === "interpretation") {
        return [{ text: line.text, basis: "interpretation" as const, quote: null, match: null }];
      }
      const m = line.quote ? locateQuote(line.quote, sourceText, normalized) : null;
      if (!m) {
        logger("quote_unverified", { extraction_id: opts.extractionId ?? null, brief_section: name, line_index: i, similarity: null });
        return [];
      }
      return [{ text: line.text, basis: "source" as const, quote: m.quote, match: m }];
    });

  return {
    what_this_is: section(brief.what_this_is, "what_this_is"),
    what_to_do: section(brief.what_to_do, "what_to_do"),
    by_when: section(brief.by_when, "by_when"),
    if_you_dont: section(brief.if_you_dont, "if_you_dont"),
    worth_considering: section(brief.worth_considering, "worth_considering", true),
    not_sure_about: [...brief.not_sure_about],
  };
}
