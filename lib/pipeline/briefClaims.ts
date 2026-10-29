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
const AMOUNT = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|k)\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:(?:hundred|thousand|million|billion)\s+)?(?:dollars|euros|pounds|USD|EUR|GBP)\b)/giu;

/** A percentage ("22.5%", "15 percent"); it must occur in the source as written. */
const PERCENT = /\b\d[\d,]*(?:\.\d+)?\s?(?:%|per\s?cent\b)/giu;
const NUMBER_WORD =
  "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)";
/**
 * An amount or percentage in words ("fifteen hundred dollars", "two-hundred and fifty euros",
 * "twenty percent"). Matched only after the figure amounts (AMOUNT, PERCENT) are blanked: in
 * "2.5 million dollars" or "3 hundred dollars" the scale word belongs to the figure amount. A word
 * amount after any other figure ("In 2027 fifty dollars", "Room 12 twenty dollars") is still checked.
 */
const WORDS_AMOUNT = new RegExp(
  `\\b${NUMBER_WORD}(?:[\\s-]+(?:and[\\s-]+)?${NUMBER_WORD})*\\s+(?:dollars?|euros?|pounds?|bucks|cents?|per\\s?cent)\\b`,
  "giu",
);
/** Replaces every match with spaces (offsets are kept). */
const blank = (s: string, patterns: RegExp[]) => patterns.reduce((l, re) => l.replace(re, (m) => " ".repeat(m.length)), s);
/** Word amounts compared whole: case, hyphens and "and" do not matter, a missing word does. */
const wordAmounts = (s: string) =>
  [...blank(s, [AMOUNT, PERCENT]).matchAll(WORDS_AMOUNT)].map((m) => m[0].toLowerCase().replace(/[\s-]+/g, " ").replace(/ and /g, " ").replace("per cent", "percent").trim());

export type ClaimKind = "date" | "amount";

/** The kinds of claim in `line` that the source does not support (empty when the line is fine). */
export function unsupportedClaims(line: string, sourceText: string): ClaimKind[] {
  const out: ClaimKind[] = [];
  const amountPatterns = [AMOUNT, PERCENT, WORDS_AMOUNT];
  // Amounts are blanked before the date search: chrono reads "$1,500 a year" as the time "500 a".
  const withoutAmounts = blank(line, amountPatterns);
  const dates = chrono.parse(withoutAmounts, SPAN_REFERENCE).map((r) => r.text.trim()).filter((t) => t !== "" && !NOT_A_DATE.test(t));
  // Whole words, but the source may write a year after the date the line repeats without one
  // ("October 31" from "October 31, 2026"): the same date, not an invented one. A line that adds a
  // year the source lacks still fails, because the year is part of the phrase it must find.
  if (dates.some((d) => !containsWholePhrase(sourceText, d, "text"))) out.push("date");
  const amounts = [AMOUNT, PERCENT].flatMap((re) => [...line.matchAll(re)].map((m) => m[0].trim()));
  // A word amount must be a whole word amount of the source: "five dollars" is not supported by
  // "twenty-five dollars", nor "fifty euros" by "two hundred and fifty euros".
  const sourceWords = new Set(wordAmounts(sourceText));
  if (amounts.some((a) => !containsWholePhrase(sourceText, a, "amount")) || wordAmounts(line).some((w) => !sourceWords.has(w))) {
    out.push("amount");
  }
  return out;
}
