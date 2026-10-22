import type { Extraction, Item } from "@/lib/ai/schema";
import type { Logger } from "@/lib/log";
import type { Band } from "@/lib/schemas";
import { resolveDate, type DateContext, type ResolvedDate } from "./resolveDates";
import { confidenceLabel, scoreItem, type Signal } from "./score";
import { suppressionHash, verifyBrief, verifyQuotes, type VerifiedBrief, type VerifiedEvidence } from "./verifyQuotes";

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
    // A date_text not found in the source was cleared by verifyFields, so the item has no due date.
    const date = resolveDate(v.item, opts);
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
    const firstQuote = (v.evidence[0] as VerifiedEvidence).quote;
    proposals.push({
      index: v.index,
      item: v.item,
      evidence: v.evidence,
      date,
      score: s.score,
      band: s.band,
      signals: s.signals,
      label: confidenceLabel(v.item.type, s.band, s.signals),
      not_sure: [...v.item.uncertainty_notes, ...date.not_sure],
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
