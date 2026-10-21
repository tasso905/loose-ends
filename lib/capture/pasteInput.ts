import { z } from "zod";

/**
 * F2 paste input (SITE_CONTRACT §2.2, CONTENT_MODEL §2): text up to 30,000 characters with a
 * counter from 27,000, an optional title up to 120 characters and an optional written-on date that
 * defaults to today (`Assumed`). Shared by the form (live counter) and the server action (Zod).
 *
 * Length is counted in UTF-16 code units (`String.length`), the same unit the textarea and
 * extract() use. Line breaks are normalized to `\n` first: browsers submit form text with `\r\n`,
 * which would otherwise make the server count more characters than the counter showed.
 */

/** Same limit as extract() (MAX_INPUT_CHARS); kept here so the client bundle does not import lib/ai. */
export const PASTE_MAX_CHARS = 30_000;
export const PASTE_COUNTER_FROM = 27_000;
export const TITLE_MAX_CHARS = 120;

export const normalizeLineBreaks = (s: string) => s.replace(/\r\n?/g, "\n");

/** Real calendar date, YYYY-MM-DD. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2100;
});

export const PasteInput = z.object({
  text: z
    .string()
    .transform(normalizeLineBreaks)
    .refine((s) => s.trim().length > 0, { message: "empty" })
    .refine((s) => s.length <= PASTE_MAX_CHARS, { message: "too_long" }),
  title: z
    .string()
    .optional()
    .transform((s) => (s ?? "").trim())
    .refine((s) => s.length <= TITLE_MAX_CHARS, { message: "title_too_long" })
    .transform((s) => (s === "" ? null : s)),
  /** Only set when the user picked a date; otherwise the server uses today (`defaulted`). */
  writtenOn: z
    .string()
    .optional()
    .transform((s) => (s ? s : null))
    .pipe(isoDate.nullable()),
});
export type PasteInput = z.infer<typeof PasteInput>;

export type PasteInputError = "empty" | "too_long" | "title_too_long" | "invalid_date";

export function parsePasteForm(form: { text: unknown; title: unknown; writtenOn: unknown; writtenOnSet: unknown }):
  | { ok: true; data: PasteInput }
  | { ok: false; reason: PasteInputError; length: number } {
  const text = typeof form.text === "string" ? form.text : "";
  const parsed = PasteInput.safeParse({
    text,
    title: typeof form.title === "string" ? form.title : undefined,
    writtenOn: form.writtenOnSet === "1" && typeof form.writtenOn === "string" ? form.writtenOn : undefined,
  });
  const length = normalizeLineBreaks(text).length;
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  const reason: PasteInputError =
    issue?.path[0] === "writtenOn"
      ? "invalid_date"
      : issue?.message === "too_long"
        ? "too_long"
        : issue?.message === "title_too_long"
          ? "title_too_long"
          : "empty";
  return { ok: false, reason, length };
}

/** Live counter state for the textarea: hidden below 27,000, over-limit blocks submit. */
export function pasteCounter(length: number): { visible: boolean; over: boolean; text: string } {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return {
    visible: length >= PASTE_COUNTER_FROM,
    over: length > PASTE_MAX_CHARS,
    text: `${fmt(length)} / ${fmt(PASTE_MAX_CHARS)}`,
  };
}

/** Written-on date for display, e.g. "Tue Oct 20" (same year as `today`) or "Fri Jan 8, 2027". */
export function formatWrittenOn(iso: string, today: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: iso.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
    timeZone: "UTC",
  }).formatToParts(new Date(Date.UTC(y, m - 1, d)));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const base = `${get("weekday")} ${get("month")} ${get("day")}`;
  return get("year") ? `${base}, ${get("year")}` : base;
}
