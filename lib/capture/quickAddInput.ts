import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { normalizeLineBreaks } from "./pasteInput";

/**
 * F4 quick add input (SITE_CONTRACT §2.2 "Quick-add field", CONTENT_MODEL §2 "Quick-add text"):
 * one line, up to 2,000 characters, the user's wording kept as typed. Shared by the form and the
 * server action (Zod). Length is counted in UTF-16 code units, the unit extract() and the paste
 * form use. Like the paste field, the input has no maxLength: text over the limit is reported, never
 * cut off, because a cut instruction can change what it says.
 *
 * DOCUMENTED copy: tab `Quick add`, placeholder `e.g. Send Mike the proposal Friday`, submit `Add`
 * (SITE_CONTRACT §2.2); toast `Added "{title}"` + `Undo` (SITE_CONTRACT §3.1).
 * The other strings were approved by the user on Nov 24 (D86; the two `unknown` strings later that day).
 */

export const QUICK_ADD_MAX_CHARS = 2_000;

const fmt = (n: number) => n.toLocaleString("en-US");

export const QUICK_ADD_COPY = {
  tab: "Quick add",
  placeholder: "e.g. Send Mike the proposal Friday",
  submit: "Add",
  /** The field's accessible name (visually hidden; the tab names the mode). */
  label: "Quick add",
  /** Hint under the field, in the pattern of D47's `Up to 30,000 characters.` */
  hint: "One line, up to 2,000 characters.",
  /** Empty submit (the Add button is disabled while the field is blank, so a fallback). */
  empty: "Type something first.",
  /** Over the limit, in the pattern of the paste `input_too_long` copy. */
  tooLong: (n: number) => `That's ${fmt(n)} characters. Quick add takes up to 2,000 — use Paste for longer text.`,
  /** SITE_CONTRACT §3.1. */
  toast: (title: string) => `Added "${title}"`,
  /** Undo's accessible name, in the pattern of D47 / D56 (`Undo done: {title}`). */
  undoLabel: (title: string) => `Undo add: ${title}`,
  /** Toast when one quick add creates more than one thread. */
  toastMany: (n: number) => `Added ${fmt(n)} threads`,
  /** Undo's accessible name for that toast. */
  undoLabelMany: (n: number) => `Undo add: ${fmt(n)} threads`,
  /** The response was lost, so the outcome is unknown. Try again is idempotent. */
  addUnknown: "I can't tell if this line was added. Try again: it won't be added twice.",
  /** The same for Undo. */
  undoUnknown: "I can't tell if that was undone. Check Threads to see.",
} as const;

export const QuickAddInput = z.object({
  text: z
    .string()
    .transform(normalizeLineBreaks)
    .refine((s) => s.trim().length > 0, { message: "empty" })
    .refine((s) => s.length <= QUICK_ADD_MAX_CHARS, { message: "too_long" }),
});
export type QuickAddInput = z.infer<typeof QuickAddInput>;

export function parseQuickAddForm(form: { text: unknown }):
  | { ok: true; data: QuickAddInput }
  | { ok: false; reason: "empty" | "too_long"; length: number } {
  const text = typeof form.text === "string" ? form.text : "";
  const parsed = QuickAddInput.safeParse({ text });
  const length = normalizeLineBreaks(text).length;
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, reason: parsed.error.issues[0]?.message === "too_long" ? "too_long" : "empty", length };
}

/**
 * A quick add is written the moment it is sent: its written-on date is today in the user's
 * timezone, a known date (stored as reference_date_source = user), not the paste form's assumed one.
 */
export function quickAddWrittenOn(now: Date, timezone: string): string {
  try {
    return formatInTimeZone(now, timezone, "yyyy-MM-dd");
  } catch {
    return formatInTimeZone(now, "UTC", "yyyy-MM-dd");
  }
}

/** The field error for the current text, or null (the form's live check; same rule as the server). */
export function quickAddFieldError(length: number): string | null {
  return length > QUICK_ADD_MAX_CHARS ? QUICK_ADD_COPY.tooLong(length) : null;
}
