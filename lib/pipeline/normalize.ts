/**
 * Text normalization for quote matching (PRD pipeline step 1 and F5 "normalized whitespace").
 *
 * - Runs of whitespace collapse to one space; leading/trailing whitespace is dropped.
 * - Typographic quotes, apostrophes and dashes fold to ASCII, because models routinely
 *   swap ’ for ' when copying. Nothing else changes: case, words and punctuation stay.
 *
 * `map[i]` is the offset in the original text of normalized character i, so a match in
 * normalized text can be highlighted in the original. `map[text.length]` is the original length.
 */

const FOLD: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "′": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "″": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  " ": " ",
};

export interface Normalized {
  text: string;
  map: number[];
}

export function normalizeForMatch(input: string): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  let pendingSpace = -1; // original offset of the first whitespace char in the current run

  for (let i = 0; i < input.length; i++) {
    const raw = input[i] as string;
    const ch = FOLD[raw] ?? raw;
    if (/\s/.test(ch)) {
      if (pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0 && out.length > 0) {
      out.push(" ");
      map.push(pendingSpace);
    }
    pendingSpace = -1;
    out.push(ch);
    map.push(i);
  }
  map.push(input.length);
  return { text: out.join(""), map };
}

/** Normalize a string for comparison only (no offset map). */
export function normalizeText(input: string): string {
  return normalizeForMatch(input).text;
}

/**
 * Map a [start, end) range in normalized text back to the original text.
 * `end` maps to just after the last matched original character.
 */
export function toOriginalRange(n: Normalized, start: number, end: number): { start: number; end: number } {
  const origStart = n.map[start] ?? 0;
  const lastIdx = n.map[end - 1];
  const origEnd = lastIdx === undefined ? origStart : lastIdx + 1;
  return { start: origStart, end: origEnd };
}

/** 1-based page for an original offset, from `sources.page_offsets` (start offset of each page). */
export function pageForOffset(pageOffsets: number[] | null | undefined, offset: number): number | null {
  if (!pageOffsets || pageOffsets.length === 0) return null;
  let page = 1;
  for (let i = 0; i < pageOffsets.length; i++) {
    if ((pageOffsets[i] as number) <= offset) page = i + 1;
    else break;
  }
  return page;
}
