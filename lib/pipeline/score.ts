import type { Certainty, ItemType, Owner } from "@/lib/ai/schema";
import type { Band } from "@/lib/schemas";
import type { DateAgreement } from "./resolveDates";
import type { MatchKind } from "./verifyQuotes";

/**
 * Confidence & Uncertainty Model (PRD). The model never reports a number: its categorical
 * `certainty` is combined with deterministic signals into a 0–1 score, then banded.
 * Labels and reasons come from the band and signals (F19); no LLM call.
 *
 * Arithmetic is done in hundredths so band edges are exact.
 */

export const BASE: Record<Certainty, number> = { explicit: 80, implied: 55, speculative: 30 };

export const WEIGHTS = {
  exactQuote: 5,
  ownerUnknown: -25,
  dateAgrees: 5,
  dateDisagrees: -15,
  firstPersonModal: 5,
  hedge: -15,
} as const;

export const BAND_MIN = { high: 75, medium: 50, low: 30 } as const;

const FIRST_PERSON_MODAL = /\b(i'll|i will|i'm going to|i am going to)\b/i;
const HEDGE = /\b(maybe|probably|sometime|might)\b/i;

export type Signal =
  | "exact_quote"
  | "owner_unknown"
  | "date_agrees"
  | "date_disagrees"
  | "first_person_modal"
  | "hedge_words"
  | "no_date";

export interface ScoreInput {
  type: ItemType;
  owner: Owner;
  certainty: Certainty;
  /** Match kinds of the item's verified evidence. */
  matchKinds: MatchKind[];
  /** Verified quote texts (the source's own words). */
  quotes: string[];
  dateAgreement: DateAgreement;
  disabledTypes?: readonly string[];
}

export interface ScoreResult {
  /** null when the item type is disabled by the user (F17): the item is dropped. */
  score: number | null;
  band: Band | null;
  signals: Signal[];
}

/** Apostrophes are folded so "I’ll" and "I'll" both count. */
const fold = (s: string) => s.replace(/[‘’]/g, "'");

export function scoreItem(input: ScoreInput): ScoreResult {
  if (input.disabledTypes?.includes(input.type)) return { score: null, band: null, signals: [] };

  const signals: Signal[] = [];
  let s = BASE[input.certainty];
  const quoteText = fold(input.quotes.join("\n"));

  if (input.matchKinds.includes("exact")) {
    s += WEIGHTS.exactQuote;
    signals.push("exact_quote");
  }
  if (input.owner === "unknown" && (input.type === "commitment" || input.type === "request")) {
    s += WEIGHTS.ownerUnknown;
    signals.push("owner_unknown");
  }
  if (input.dateAgreement === "agree") {
    s += WEIGHTS.dateAgrees;
    signals.push("date_agrees");
  } else if (input.dateAgreement === "disagree" || input.dateAgreement === "model_only") {
    s += WEIGHTS.dateDisagrees;
    signals.push("date_disagrees");
  } else if (input.dateAgreement === "none" || input.dateAgreement === "unanchored") {
    signals.push("no_date");
  }
  if (input.type === "commitment" && FIRST_PERSON_MODAL.test(quoteText)) {
    s += WEIGHTS.firstPersonModal;
    signals.push("first_person_modal");
  }
  if (HEDGE.test(quoteText)) {
    // PRD Question #11, option (b), user decision Oct 18: an intention is hedged by nature, so hedge
    // words don't lower its score ("We should grab lunch sometime" → 0.35, Low / Also noticed). The
    // signal is still recorded so the label can say why it is uncertain.
    if (input.type !== "intention") s += WEIGHTS.hedge;
    signals.push("hedge_words");
  }

  const clamped = Math.max(0, Math.min(100, s));
  return { score: clamped / 100, band: bandFor(clamped), signals };
}

/** Band from a score in hundredths (0–100). */
function bandFor(hundredths: number): Band {
  if (hundredths >= BAND_MIN.high) return "high";
  if (hundredths >= BAND_MIN.medium) return "medium";
  if (hundredths >= BAND_MIN.low) return "low";
  return "ignore";
}

export function bandForScore(score: number): Band {
  return bandFor(Math.round(score * 100));
}

/** User-facing label (D3). Ignore is never shown. */
export const BAND_LABEL: Record<Exclude<Band, "ignore">, "Likely" | "Maybe" | "Also noticed"> = {
  high: "Likely",
  medium: "Maybe",
  low: "Also noticed",
};

const NOUN: Record<ItemType, string> = {
  commitment: "commitment",
  request: "request",
  waiting_on: "promise from someone else",
  deadline: "deadline",
  intention: "plan",
  decision: "decision",
  key_fact: "fact",
};

/**
 * Plain-language reason for the label: always names why the item is or isn't certain
 * (F19; DESIGN_STANDARD Microcopy "Uncertainty"). Strongest doubt first.
 */
export function confidenceReason(type: ItemType, band: Band, signals: Signal[]): string {
  const has = (x: Signal) => signals.includes(x);
  if (band === "high") {
    return has("date_agrees") ? `Clear ${NOUN[type]} with a date.` : `Clear ${NOUN[type]}.`;
  }
  if (has("hedge_words")) return "Possible intention detected, but I'm not confident enough to remind you.";
  if (has("owner_unknown")) return "I'm not sure who said this.";
  if (has("date_disagrees")) return "I'm not sure about the date.";
  if (has("no_date") && (type === "commitment" || type === "request" || type === "waiting_on")) {
    return `Possible ${NOUN[type]}, but no date was mentioned.`;
  }
  return `Possible ${NOUN[type]}, but it isn't stated outright.`;
}

/** Label shown on proposals and threads: dot + word + reason (colour is never the only signal). */
export function confidenceLabel(type: ItemType, band: Band, signals: Signal[]): { word: string; reason: string } | null {
  if (band === "ignore") return null;
  return { word: BAND_LABEL[band], reason: confidenceReason(type, band, signals) };
}
