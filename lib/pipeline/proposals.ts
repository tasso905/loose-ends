import type { Extraction, Item } from "@/lib/ai/schema";
import { log as defaultLog, type Logger } from "@/lib/log";
import type { Band } from "@/lib/schemas";
import { datePhrases, statesDate, stripDatePhrases } from "./briefClaims";
import { resolveDate, type DateContext, type ResolvedDate } from "./resolveDates";
import { confidenceLabel, scoreItem, type Signal } from "./score";
import { containsWholePhrase, suppressionHash, verifyBrief, verifyQuotes, type VerifiedBrief, type VerifiedEvidence } from "./verifyQuotes";

const TITLE_MAX = 80;

/**
 * Rule 3 for title and action: every date phrase they state must be inside the item's verified
 * date_text (which verifyFields already required to be inside the item's own quote). Unbacked
 * phrases are stripped with their connector ("by Thursday"); if that leaves no usable line, the
 * fallback is used. Returns `text` itself when nothing changed.
 */
export function unbackedDateFree<F extends string | null>(text: string, dateText: string | null, fallback: () => F): string | F {
  // chrono may include a leading connector ("on Thursday"); the date words are what must be backed.
  const core = (s: string) => s.trim().replace(/^(?:on|by|before|until|at|due)\s+/iu, "");
  const unbacked = datePhrases(text).filter((p) => dateText === null || !containsWholePhrase(dateText, core(p.text), "text"));
  if (unbacked.length === 0) return text;
  return stripDatePhrases(text, unbacked) ?? fallback();
}

/** A title made from the item's first verified quote (source words only), cut at a word under 80 characters. */
export function quoteTitle(quote: string): string {
  const q = quote.replace(/\s+/g, " ").trim();
  if (q.length <= TITLE_MAX) return q;
  const cut = q.slice(0, TITLE_MAX - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > 20 ? cut.slice(0, atWord) : cut).replace(/[\s,;:-]+$/u, "")}…`;
}

/**
 * Deterministic post-processing of one validated model output (PRD pipeline steps 5–7):
 * verify quotes → re-resolve dates → score and band. Dedupe (step 8, F14) is not built (D16).
 * Nothing here writes to the database; the caller persists proposals as `extraction_items`.
 */

export interface Proposal {
  /** Index in the model's items array. */
  index: number;
  /** Model item after field verification (unverifiable amount/counterparty cleared). */
  item: Item;
  evidence: VerifiedEvidence[];
  date: ResolvedDate;
  score: number;
  band: Band;
  signals: Signal[];
  /** Dot + word + reason; null for the Ignore band, which is never shown (D3). */
  label: { word: string; reason: string } | null;
  /** Item uncertainty notes plus date notes, for "Not sure about". */
  not_sure: string[];
  suppression_hash: string;
}

export interface ProcessedExtraction {
  proposals: Proposal[];
  brief: VerifiedBrief | null;
  droppedItemIndexes: number[];
  droppedTypeIndexes: number[];
  unverifiedQuoteCount: number;
}

export interface ProcessOptions extends DateContext {
  sourceText: string;
  pageOffsets?: number[] | null;
  disabledTypes?: readonly string[];
  extractionId?: string | null;
  logger?: Logger;
}

export function processExtraction(output: Extraction, opts: ProcessOptions): ProcessedExtraction {
  const verified = verifyQuotes(output.items, opts.sourceText, {
    pageOffsets: opts.pageOffsets,
    extractionId: opts.extractionId,
    logger: opts.logger,
  });

  const proposals: Proposal[] = [];
  const droppedTypeIndexes: number[] = [];

  for (const v of verified.items) {
    // A date_text not inside the item's own quote was cleared by verifyFields, so the item has no
    // due date. Its "Not sure about" notes must not claim one either: a note stating a date is
    // about the cleared date and is dropped (rule 3).
    const date = resolveDate(v.item, opts);
    const logger = opts.logger ?? defaultLog;
    const dateCleared = output.items[v.index]?.date_text != null && v.item.date_text === null;
    const notes = dateCleared ? v.item.uncertainty_notes.filter((n) => !statesDate(n)) : v.item.uncertainty_notes;
    if (notes.length < v.item.uncertainty_notes.length) {
      logger("field_unverified", {
        extraction_id: opts.extractionId ?? null,
        item_index: v.index,
        field: "uncertainty_notes",
        reason: "date_cleared",
        dropped: v.item.uncertainty_notes.length - notes.length,
      });
    }
    // Title and action are model words shown as the item's name: a date they state must be the
    // verified in-quote date_text, or it is stripped (title falls back to the quote, action to null
    // when stripping leaves no usable line).
    const firstQuote = (v.evidence[0] as VerifiedEvidence).quote;
    const title = unbackedDateFree(v.item.title, v.item.date_text, () => quoteTitle(firstQuote));
    const action = v.item.action === null ? null : unbackedDateFree(v.item.action, v.item.date_text, () => null);
    for (const [field, before, after] of [
      ["title", v.item.title, title],
      ["action", v.item.action, action],
    ] as const) {
      if (before !== after) {
        logger("field_unverified", {
          extraction_id: opts.extractionId ?? null,
          item_index: v.index,
          field,
          reason: after === null ? "date_unbacked_cleared" : "date_unbacked_stripped",
        });
      }
    }
    const item: Item =
      notes === v.item.uncertainty_notes && title === v.item.title && action === v.item.action
        ? v.item
        : { ...v.item, uncertainty_notes: notes, title, action };
    const s = scoreItem({
      type: v.item.type,
      owner: v.item.owner,
      certainty: v.item.certainty,
      matchKinds: v.evidence.map((e) => e.match_kind),
      quotes: v.evidence.map((e) => e.quote),
      dateAgreement: date.agreement,
      disabledTypes: opts.disabledTypes,
    });
    if (s.score === null || s.band === null) {
      droppedTypeIndexes.push(v.index);
      continue;
    }
    proposals.push({
      index: v.index,
      item,
      evidence: v.evidence,
      date,
      score: s.score,
      band: s.band,
      signals: s.signals,
      label: confidenceLabel(v.item.type, s.band, s.signals),
      not_sure: [...notes, ...date.not_sure],
      suppression_hash: suppressionHash(opts.sourceText, firstQuote),
    });
  }

  return {
    proposals,
    brief: output.brief
      ? verifyBrief(output.brief, opts.sourceText, { pageOffsets: opts.pageOffsets, extractionId: opts.extractionId, logger: opts.logger })
      : null,
    droppedItemIndexes: verified.droppedItemIndexes,
    droppedTypeIndexes,
    unverifiedQuoteCount: verified.droppedQuotes.length,
  };
}
