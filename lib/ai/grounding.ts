import { normalizeText } from "@/lib/pipeline/normalize";

/**
 * Grounding checks for Ask-why answer parts (rule 7). No word lists, no clause splitting: a part
 * that repeats stored text must be the WHOLE stored text, so no fragment can drop a negation,
 * condition or later correction. Comparison ignores whitespace, quote/dash style, case and
 * trailing punctuation. The answer then shows the stored text, never the model's copy.
 */

const clean = (s: string) => normalizeText(s).replace(/[\s.,;:!?]+$/u, "").toLowerCase();

/** user_reason and source_fact: the part must equal the whole stored text. */
export function isWholeText(part: string, stored: string): boolean {
  const p = clean(part);
  return p.length > 0 && p === clean(stored);
}

/** The stored fact if `part` is the whole of it, else null. */
export function matchFactUnit(part: string, fact: string): string | null {
  return isWholeText(part, fact) ? normalizeText(fact).replace(/[\s.,;:!?]+$/u, "") : null;
}
