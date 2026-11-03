import type { Extraction, Item } from "@/lib/ai/schema";
import { log as defaultLog, type Logger } from "@/lib/log";
import type { Band } from "@/lib/schemas";
import { datePhrases, statesDate, stripDatePhrases } from "./briefClaims";
import { resolveDate, type DateContext, type ResolvedDate } from "./resolveDates";
import { confidenceLabel, scoreItem, type Signal } from "./score";
import { containsWholePhrase, suppressionHash, verifyBrief, verifyQuotes, type VerifiedBrief, type VerifiedEvidence } from "./verifyQuotes";

const TITLE_MAX = 80;

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WEEKDAYS = "mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";
/** A month or weekday word on its own ("June", "Friday"): it may be a name or part of an event name. */
const BARE_WORD = new RegExp(`^(?:${MONTHS}|${WEEKDAYS})\\.?$`, "iu");
/** Words before a bare month/weekday that make it a person ("Call June", "Ask April") or a place ("to Sunday school"). */
const NAME_BEFORE = new Set(["call", "ask", "email", "e-mail", "text", "tell", "meet", "with", "to", "thank", "remind", "invite", "cc", "ping", "message", "phone", "visit", "and"]);
/** Words after a date that keep it a date ("Friday at 5", "Friday and Monday"), not a modifier ("Sunday school"). */
const DATE_AFTER = new Set(["at", "by", "on", "before", "after", "morning", "afternoon", "evening", "night", "noon", "and", "or", "to", "for", "the", "if", "so", "then"]);

/** chrono may include a leading connector ("on Thursday"); the date words are what is compared. */
const core = (s: string) => s.trim().replace(/^(?:on|by|before|until|at|due)\s+/iu, "");

/**
 * T-T1: a bare month or weekday word that reads as a name or an event name, not a date: "Call June
 * about the lease", "Email August Wilson", "Drive Mia to Sunday school", "the Black Friday sale",
 * "the March trip". Signals: a capitalized neighbour (not the line's first word), a name-taking
 * word before it, or a following word that makes it a modifier.
 */
function nameLike(text: string, index: number, phrase: string): boolean {
  if (!BARE_WORD.test(core(phrase))) return false;
  const before = text.slice(0, index).match(/([\p{L}'’-]+)\W*$/u);
  const after = text.slice(index + phrase.length).match(/^\W*?([\p{L}'’-]+)/u);
  const prev = before?.[1] ?? null;
  const next = after?.[1] ?? null;
  const prevIsFirst = prev !== null && text.slice(0, before!.index).trim() === "";
  if (next && /^\p{Lu}/u.test(next)) return true;
  if (prev && /^\p{Lu}/u.test(prev) && !prevIsFirst) return true;
  if (prev && NAME_BEFORE.has(prev.toLowerCase())) return true;
  if (next && /^\p{Ll}/u.test(next) && !DATE_AFTER.has(next.toLowerCase())) return true;
  return false;
}

export interface TitleDateContext extends DateContext {
  /** The stored, verified due date (YYYY-MM-DD) the item carries, or null. */
  dueDate: string | null;
}

/**
 * Rule 3 for title and action. A date phrase they state is stripped (with its connector, "by
 * Thursday") when it is not backed by the verified in-quote date_text:
 *  - the item has no verified date_text (the model claimed none, or its claim was cleared);
 *  - or the phrase names a different day than the stored due date (resolved with chrono against the
 *    written-on date when `ctx` is given; without it, the phrase must be inside date_text).
 * A bare month or weekday word that reads as a name or event name is never stripped (T-T1). If
 * stripping leaves no usable line, the fallback is used. Returns `text` itself when nothing changed.
 */
export function unbackedDateFree<F extends string | null>(
  text: string,
  dateText: string | null,
  fallback: () => F,
  ctx?: TitleDateContext,
): string | F {
  const backed = (phrase: string): boolean => {
    if (dateText === null) return false;
    if (ctx?.dueDate) {
      const day = resolveDate({ date_text: core(phrase), date_iso: null }, ctx).due_date;
      if (day !== null) return day === ctx.dueDate;
    }
    return containsWholePhrase(dateText, core(phrase), "text");
  };
  const unbacked = datePhrases(text).filter((p) => !nameLike(text, p.index, p.text) && !backed(p.text));
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
    const titleCtx: TitleDateContext = { referenceDate: opts.referenceDate, referenceDateSource: opts.referenceDateSource, timezone: opts.timezone, dueDate: date.due_date };
    const title = unbackedDateFree(v.item.title, v.item.date_text, () => quoteTitle(firstQuote), titleCtx);
    const action = v.item.action === null ? null : unbackedDateFree(v.item.action, v.item.date_text, () => null, titleCtx);
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
