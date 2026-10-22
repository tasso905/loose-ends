import * as chrono from "chrono-node";
import { parseInstant } from "@/lib/time";
import { containsWholePhrase } from "./verifyQuotes";

/**
 * Rule 3 for the Explain card's model-written lines (interpretation lines and "Not sure about"):
 * a line may not state a date or an amount that the source does not contain as written. The model
 * could otherwise compute "Oct 30" from "in 30 days", or round "$1,470.00" to "$1,500", and the card
 * would show an invented fact under an Interpretation label. Such a line is dropped, never edited.
 *
 * Detection only: chrono finds the date phrases in the line (its reference instant is irrelevant to
 * which spans it finds, so a fixed one is used instead of a clock); amounts are currency figures.
 * Each phrase must occur in the source as whole words (containsWholePhrase, same check as items).
 */

const SPAN_REFERENCE = parseInstant("2000-01-01T12:00:00Z");
/** "now" is a figure of speech in an explanation, not a date claim. */
const NOT_A_DATE = /^(right\s+)?now$/i;
const AMOUNT = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|k)\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|euros|pounds|USD|EUR|GBP)\b)/giu;

export type ClaimKind = "date" | "amount";

/** The kinds of claim in `line` that the source does not support (empty when the line is fine). */
export function unsupportedClaims(line: string, sourceText: string): ClaimKind[] {
  const out: ClaimKind[] = [];
  // Amounts are blanked before the date search: chrono reads "$1,500 a year" as the time "500 a".
  const withoutAmounts = line.replace(AMOUNT, (m) => " ".repeat(m.length));
  const dates = chrono.parse(withoutAmounts, SPAN_REFERENCE).map((r) => r.text.trim()).filter((t) => t !== "" && !NOT_A_DATE.test(t));
  if (dates.some((d) => !containsWholePhrase(sourceText, d, "date"))) out.push("date");
  const amounts = [...line.matchAll(AMOUNT)].map((m) => m[0].trim());
  if (amounts.some((a) => !containsWholePhrase(sourceText, a, "amount"))) out.push("amount");
  return out;
}
