import * as chrono from "chrono-node";
import { formatInTimeZone, fromZonedTime, getTimezoneOffset } from "date-fns-tz";
import type { DueCertainty } from "@/lib/schemas";

/**
 * Rule 3: dates are deterministic. The model's `date_iso` is never trusted on its own:
 * `chrono-node` re-resolves `date_text` against the source's reference date in the user's
 * timezone. On disagreement chrono wins, the date is marked `inferred` and a "Not sure about"
 * line explains it. If chrono cannot resolve the phrase there is no due date. A date the model
 * produced without any `date_text` anchor is discarded. Nothing is ever filled in.
 */

export type ReferenceDateSource = "user" | "detected" | "defaulted";

export type DateAgreement =
  | "agree" // chrono and the model resolved to the same date (and time, if both had one)
  | "disagree" // both resolved, to different values
  | "chrono_only" // the model gave no resolution; chrono did
  | "model_only" // chrono could not resolve the phrase; the model did (discarded)
  | "unanchored" // the model gave a date with no date_text (discarded)
  | "none"; // no date at all

export interface DateInput {
  date_text: string | null;
  date_iso: string | null;
}

export interface DateContext {
  /** `sources.reference_date`, YYYY-MM-DD: the day the source was written. */
  referenceDate: string;
  referenceDateSource: ReferenceDateSource;
  /** IANA timezone of the user, e.g. "America/New_York". */
  timezone: string;
}

export interface ResolvedDate {
  /** UTC ISO instant, or null. Date-only deadlines are stored at 23:59 local time. */
  due_at: string | null;
  /** Calendar date in the user's timezone (YYYY-MM-DD), or null. */
  due_date: string | null;
  due_time_known: boolean;
  due_certainty: DueCertainty;
  agreement: DateAgreement;
  /** Lines for the Explain card "Not sure about" section. */
  not_sure: string[];
  /** Deterministic Why-panel reasoning step, e.g. `I read "Friday" as Fri Oct 9 (message dated Mon Oct 5).` */
  reasoning: string | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
/** Phrases that mean the day the source was written. */
const SAME_DAY = /\b(today|tonight|this (morning|afternoon|evening))\b/i;
/** Phrases that name a period rather than a day ("next week", "end of the month"). */
const VAGUE = /\b(week|weekend|month|year|quarter)\b/i;

/** "the 15th", "on the 3rd": chrono's casual parser does not read a bare day of month. */
const dayOfMonthParser: chrono.Parser = {
  pattern: () => /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/i,
  extract: (context, match) => {
    const day = Number(match[1]);
    if (day < 1 || day > 31) return null;
    const ref = context.reference.instant;
    const offsetMin = typeof context.reference.timezoneOffset === "number" ? context.reference.timezoneOffset : 0;
    const local = new Date(ref.getTime() + offsetMin * 60_000);
    let year = local.getUTCFullYear();
    let month = local.getUTCMonth() + 1;
    if (day < local.getUTCDate()) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return context.createParsingComponents({ day }).imply("month", month).imply("year", year);
  },
};

const parser = chrono.casual.clone();
parser.parsers.push(dayOfMonthParser);

interface Wall {
  date: string; // YYYY-MM-DD
  time: string | null; // HH:mm
  /** True when the phrase gives a clock hour but not AM/PM ("tomorrow at 5"). */
  meridiemGuessed?: boolean;
}

/** A clock time the source actually states: "5pm", "9:30", "at 5", "noon", "8 o'clock". */
const STATED_TIME = /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)(?![\p{L}])|\b\d{1,2}:\d{2}\b|\bat\s+\d{1,2}\b|\b(noon|midnight)\b|o'clock/iu;
const STATED_MERIDIEM = /\d\s*(a\.?m\.?|p\.?m\.?)(?![\p{L}])|\b(noon|midnight)\b/iu;
/** Past window for a month-day with no year (user decision, Oct 18): up to 30 days back. */
export const PAST_WINDOW_DAYS = 30;

const dayNumber = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Year for a month-day with no year (user decision A, Oct 18). Feb 29 skips to a leap year. */
function monthDayYear(mo: number, d: number, referenceDate: string): string | null {
  const refDay = dayNumber(referenceDate);
  const refYear = Number(referenceDate.slice(0, 4));
  let past: string | null = null;
  for (let y = refYear - 1; y <= refYear + 8; y++) {
    const ymd = `${y}-${pad(mo)}-${pad(d)}`;
    if (!isRealDate(ymd)) continue;
    const delta = dayNumber(ymd) - refDay;
    if (delta >= 0) return past ?? ymd;
    if (-delta <= PAST_WINDOW_DAYS) past = ymd;
  }
  return past;
}

function chronoResolve(text: string, ctx: DateContext): Wall | null {
  const refInstant = fromZonedTime(`${ctx.referenceDate}T12:00:00`, ctx.timezone);
  const offsetMin = getTimezoneOffset(ctx.timezone, refInstant) / 60_000;
  const ref = { instant: refInstant, timezone: offsetMin };
  // Phrases look forward from the written-on date ("Friday", "the 15th", "Apr 10").
  // Without forwardDate as a fallback: "Feb 29" written Mar 10, 2028 has no forward reading in 2029.
  const start = parser.parse(text, ref, { forwardDate: true })[0]?.start ?? parser.parse(text, ref)[0]?.start;
  if (!start) return null;
  // A time counts only if the phrase states one: "in 2 hours" and "now" keep the day but not the
  // clock time computed from an assumed noon.
  const hour = start.get("hour") ?? 0;
  const timeKnown = start.isCertain("hour") && STATED_TIME.test(text);
  const time = timeKnown ? `${pad(hour)}:${pad(start.get("minute") ?? 0)}` : null;
  const meridiemGuessed = timeKnown && !STATED_MERIDIEM.test(text) && !/\b\d{1,2}:\d{2}\b/.test(text) ? hour >= 1 && hour <= 12 : false;
  const dayStated = (["year", "month", "day", "weekday"] as const).some((k) => start.isCertain(k));
  if (!dayStated) {
    // "this morning", "tonight at 8": the written-on day. A bare time ("at 5", "5pm") names no
    // day, so it is not a due date.
    return SAME_DAY.test(text) ? { date: ctx.referenceDate, time, meridiemGuessed } : null;
  }
  const y = start.get("year");
  const mo = start.get("month");
  const d = start.get("day");
  if (y === null || mo === null || d === null) return null;
  // A month-day with no year resolves to the past only within PAST_WINDOW_DAYS before the
  // written-on date ("Oct 4" written Oct 5 is overdue); otherwise to its next occurrence.
  if (start.isCertain("month") && start.isCertain("day") && !start.isCertain("year")) {
    const date = monthDayYear(mo, d, ctx.referenceDate);
    return date ? { date, time, meridiemGuessed } : null;
  }
  return { date: `${y}-${pad(mo)}-${pad(d)}`, time, meridiemGuessed };
}

/** The model's date_iso as a wall-clock date/time in the user's timezone, or null if unusable. */
function modelWall(iso: string, timezone: string): Wall | null {
  const s = iso.trim();
  if (DATE_ONLY.test(s)) return isRealDate(s) ? { date: s, time: null } : null;
  const instant = HAS_OFFSET.test(s) ? new Date(s) : fromZonedTime(s, timezone);
  if (Number.isNaN(instant.getTime())) return null;
  return { date: formatInTimeZone(instant, timezone, "yyyy-MM-dd"), time: formatInTimeZone(instant, timezone, "HH:mm") };
}

function isRealDate(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** "Fri Oct 9"; adds the year when it differs from `refYear` ("Fri Jan 8, 2027"). DESIGN_STANDARD "Dates and numbers". */
export function formatDay(ymd: string, refYear?: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const sameYear = refYear === undefined || refYear === y;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })
    .format(dt)
    .replace(/,(?= [A-Z][a-z]{2} \d)/, "");
}

function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(
    new Date(Date.UTC(2000, 0, 1, h, m)),
  );
}

function formatWall(w: Wall, refYear: number): string {
  return w.time ? `${formatDay(w.date, refYear)}, ${formatTime(w.time)}` : formatDay(w.date, refYear);
}

function sameWall(a: Wall, b: Wall): boolean {
  if (a.date !== b.date) return false;
  return a.time === null || b.time === null || a.time === b.time;
}

/**
 * Wall-clock date/time in an IANA zone → instant. A time inside a spring-forward gap
 * (e.g. 2:30 AM on the US change day) does not exist; it moves forward by the gap (3:30 AM).
 */
function zonedInstant(date: string, hhmm: string, timezone: string): Date {
  const candidate = fromZonedTime(`${date}T${hhmm}:00`, timezone);
  if (formatInTimeZone(candidate, timezone, "yyyy-MM-dd HH:mm") === `${date} ${hhmm}`) return candidate;
  const before = getTimezoneOffset(timezone, new Date(candidate.getTime() - 12 * 3600_000));
  const after = getTimezoneOffset(timezone, new Date(candidate.getTime() + 12 * 3600_000));
  return new Date(candidate.getTime() + Math.max(0, after - before));
}

const NONE: Omit<ResolvedDate, "agreement" | "not_sure"> = {
  due_at: null,
  due_date: null,
  due_time_known: false,
  due_certainty: "none",
  reasoning: null,
};

export function resolveDate(input: DateInput, ctx: DateContext): ResolvedDate {
  const text = input.date_text?.trim() || null;
  const refYear = Number(ctx.referenceDate.slice(0, 4));
  const refLabel = formatDay(ctx.referenceDate);

  if (!text) {
    return { ...NONE, agreement: input.date_iso ? "unanchored" : "none", not_sure: [] };
  }

  const fromChrono = chronoResolve(text, ctx);
  const fromModel = input.date_iso ? modelWall(input.date_iso, ctx.timezone) : null;

  if (!fromChrono) {
    return {
      ...NONE,
      agreement: input.date_iso ? "model_only" : "none",
      not_sure: [`I couldn't work out a date from "${text}", so I didn't set one.`],
    };
  }

  const agreement: DateAgreement = !input.date_iso ? "chrono_only" : fromModel && sameWall(fromChrono, fromModel) ? "agree" : "disagree";

  const label = formatWall(fromChrono, refYear);
  const dated = ctx.referenceDateSource === "defaulted" ? `I assumed this was written today, ${refLabel}` : `message dated ${refLabel}`;
  const reasoning = `I read "${text}" as ${label} (${dated}).`;

  const notSure: string[] = [];
  if (agreement === "disagree" || agreement === "chrono_only") notSure.push(`${reasoning} Check this date.`);
  if (VAGUE.test(text)) notSure.push(`"${text}" doesn't name a day. I read it as ${label}.`);
  if (fromChrono.meridiemGuessed) notSure.push(`"${text}" doesn't say AM or PM. I read it as ${label}.`);
  // A relative phrase read against an assumed written-on date is itself an assumption.
  const relative = !/\b\d{4}\b/.test(text) && !/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d/i.test(text);
  if (ctx.referenceDateSource === "defaulted" && relative && notSure.length === 0) {
    notSure.push(`${reasoning} Change the date if that's wrong.`);
  }

  const wallTime = fromChrono.time ?? "23:59";
  const dueAt = zonedInstant(fromChrono.date, wallTime, ctx.timezone).toISOString();

  return {
    due_at: dueAt,
    due_date: fromChrono.date,
    due_time_known: fromChrono.time !== null,
    due_certainty: notSure.length > 0 ? "inferred" : "explicit",
    agreement,
    not_sure: notSure,
    reasoning,
  };
}

/** Re-resolve the dates of many items with one context. */
export function resolveDates<T extends DateInput>(items: T[], ctx: DateContext): Array<{ item: T; date: ResolvedDate }> {
  return items.map((item) => ({ item, date: resolveDate(item, ctx) }));
}
