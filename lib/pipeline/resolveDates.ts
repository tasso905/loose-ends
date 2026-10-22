import * as chrono from "chrono-node";
import { formatInTimeZone, fromZonedTime, getTimezoneOffset } from "date-fns-tz";
import type { DueCertainty } from "@/lib/schemas";

/**
 * Rule 3: dates are deterministic. The model's `date_iso` is never trusted on its own:
 * `chrono-node` re-resolves `date_text` against the source's reference date in the user's
 * timezone. On disagreement chrono wins, the date is marked `inferred` and a "Not sure about"
 * line explains it. If chrono cannot resolve the phrase there is no due date. A date the model
 * produced without any `date_text` anchor is discarded. Nothing is ever filled in.
 *
 * chrono must read the whole phrase as one date expression: a partial match ("in a month" of
 * "in a month of Sundays"), a bare duration ("one day"), a range or two dates is rejected rather
 * than guessed. A day plus a separately parsed time ("Saturday by 6pm") is one expression. A
 * phrase pointing back ("last Saturday") is read backward and never becomes a future date.
 * Deadline idioms ("at the latest", "first thing", "end of day") are ignored around the day; "end
 * of the day" alone is the written-on day. Vague amounts ("a few days") and a weekday that
 * contradicts its date give no date. A bare hour from 1 to 6 with no AM/PM is PM (user decision,
 * Oct 21), and every guessed AM/PM stays inferred with a "Not sure about" line (D32).
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
/**
 * The phrase says AM or PM: "5pm", "noon", or a part of the day ("tomorrow morning at 6", "at 6 in
 * the morning", "tonight at 8"). chrono reads the part of the day into the hour (morning stays AM,
 * afternoon/evening/night become PM), so neither the PM default nor the AM/PM line applies (T-D1).
 */
const STATED_MERIDIEM = /\d\s*(a\.?m\.?|p\.?m\.?)(?![\p{L}])|\b(noon|midnight|morning|afternoon|evening|tonight|night)\b/iu;
/** An explicit "am"/"pm" after a number. */
const EXPLICIT_AMPM = /\d\s*(a\.?m\.?|p\.?m\.?)(?![\p{L}])/iu;
/**
 * T-D2: chrono adds 12 to every hour after "night"/"tonight", so "tonight at 1" became 1 PM, which
 * contradicts "tonight". A night hour that chrono puts between 12:00 and 16:59 is read as the small
 * hours of the next day ("tonight at 1" → 1 AM the next day, "tonight at 12" → midnight), marked
 * inferred with the AM/PM "Not sure about" line. "tonight at 8" (20:00) is unchanged, and so is
 * "tonight at 5" (17:00, an early evening; the tester's D50 guard keeps it 5 PM with no line).
 */
const NIGHT = /\b(tonight|night)\b/i;
/** A 24-hour clock time past noon ("13:00", "23:45"): it states the half of the day. */
const H24_TIME = /\b(1[3-9]|2[0-3]):\d{2}\b/;
/** A zero-padded hour ("01:00", "06:30"): a 24-hour time before noon, so it states AM. */
const ZERO_PADDED_TIME = /\b0\d:\d{2}\b/;
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

/** A phrase pointing back in time ("last Saturday", "the past Monday", "3 days ago"). */
const PAST_MARKER = /\b(last|past|previous|ago|yesterday)\b/i;
/**
 * Words a date phrase may carry around what chrono matched ("by Friday", "due on the 15th",
 * "Saturday no later than 6pm"). Any other leftover word means chrono read only part of the phrase
 * ("in a month" of "in a month of Sundays", "one day" of "one day at a time"), so the phrase is not
 * taken as a date (rule 3: never guess).
 */
const FILLER = new Set(["by", "on", "at", "before", "due", "the", "of", "no", "later", "than"]);
/**
 * Deadline idioms that add nothing to the day: masked before chrono reads the phrase ("Friday at
 * the latest", "first thing Friday", "by end of day Friday"). chrono misreads some of them on its
 * own ("end of the day" → "the day" → tomorrow).
 */
const NEUTRAL = /\b(at the (very )?latest|first thing( in the morning)?|end of (the )?(business )?day|close of business|eod|cob)\b/giu;
/** "end of (the) day", "EOD", "close of business" with no other day: the written-on day. */
const END_OF_DAY = /\b(end of (the )?(business )?day|close of business|eod|cob)\b/iu;
/** A vague amount ("a few days", "a couple of days", "several days") is never a date. */
const VAGUE_AMOUNT = /\b(few|couple|several)\b/iu;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
/** Connectors allowed between a day and a separately parsed time ("Saturday by 6pm"). */
const TIME_CONNECTOR = new Set(["by", "at", "before", "no", "later", "than", "on"]);
/** A bare duration is an amount of time, not a date ("one day", "a minute"); "in a day" is a date. */
const BARE_DURATION = /^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|few|couple|\d+)\s+(of\s+)?(seconds?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)$/i;

const tokens = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const dayCertain = (s: chrono.ParsedComponents) => (["year", "month", "day", "weekday"] as const).some((k) => s.isCertain(k));

/**
 * The parse results that make up the phrase, or null when the phrase is not one date expression:
 * a range ("Saturday until 6pm"), two dates ("Friday or Monday"), a bare duration, or a match
 * that leaves non-filler words. A day followed by a separately parsed time joined by a connector
 * ("Saturday by 6pm") is one expression: the day's date with the time's clock time.
 */
function wholePhrase(text: string, results: chrono.ParsedResult[]): { day: chrono.ParsedResult; time: chrono.ParsedResult | null } | null {
  if (results.length === 0 || results.length > 2) return null;
  if (results.some((r) => r.end)) return null;
  if (results.some((r) => BARE_DURATION.test(r.text.trim()))) return null;
  if (VAGUE_AMOUNT.test(text)) return null;
  let day = results[0]!;
  let time: chrono.ParsedResult | null = null;
  if (results.length === 2) {
    const [a, b] = results as [chrono.ParsedResult, chrono.ParsedResult];
    const timeOnly = (r: chrono.ParsedResult) => r.start.isCertain("hour") && !dayCertain(r.start);
    const dated = (r: chrono.ParsedResult) => dayCertain(r.start) && !r.start.isCertain("hour");
    const between = tokens(text.slice(a.index + a.text.length, b.index));
    if (!between.every((w) => TIME_CONNECTOR.has(w))) return null;
    if (dated(a) && timeOnly(b)) [day, time] = [a, b];
    else if (timeOnly(a) && dated(b)) [day, time] = [b, a];
    else return null;
  }
  let rest = text;
  for (const r of [day, time]) if (r) rest = rest.slice(0, r.index) + " ".repeat(r.text.length) + rest.slice(r.index + r.text.length);
  return tokens(rest).every((w) => FILLER.has(w)) ? { day, time } : null;
}

/** chrono's reading, null when there is none, or a refusal with its own "Not sure about" line. */
type ChronoReading = Wall | { refused: string } | null;

function chronoResolve(text: string, ctx: DateContext): ChronoReading {
  const refInstant = fromZonedTime(`${ctx.referenceDate}T12:00:00`, ctx.timezone);
  const offsetMin = getTimezoneOffset(ctx.timezone, refInstant) / 60_000;
  const ref = { instant: refInstant, timezone: offsetMin };
  const past = PAST_MARKER.test(text);
  // Same length, so result indexes still point into `text`.
  const masked = text.replace(NEUTRAL, (m) => " ".repeat(m.length));
  // Phrases look forward from the written-on date ("Friday", "the 15th", "Apr 10"), except a
  // phrase that points back ("last Saturday"): forwardDate would turn it into a future date.
  // Without forwardDate as a fallback: "Feb 29" written Mar 10, 2028 has no forward reading in 2029.
  let results = past ? [] : parser.parse(masked, ref, { forwardDate: true });
  if (results.length === 0) results = parser.parse(masked, ref);
  // "by the end of the day" with no other day is the written-on day; no clock time is stated.
  if (results.length === 0 && END_OF_DAY.test(text) && tokens(masked).every((w) => FILLER.has(w))) {
    return { date: ctx.referenceDate, time: null };
  }
  const phrase = wholePhrase(masked, results);
  if (!phrase) return null;
  const start = phrase.day.start;
  const clock = phrase.time?.start ?? start;
  // A time counts only if the phrase states one: "in 2 hours" and "now" keep the day but not the
  // clock time computed from an assumed noon.
  const rawHour = clock.get("hour") ?? 0;
  const timeKnown = clock.isCertain("hour") && STATED_TIME.test(text);
  // No AM/PM stated and a 12-hour reading ("at 5", "by 6:00"; not "17:00" or a zero-padded "06:00"):
  // the meridiem is a guess, said so in "Not sure about".
  const meridiemGuessed = timeKnown && !STATED_MERIDIEM.test(text) && !ZERO_PADDED_TIME.test(text) && rawHour >= 1 && rawHour <= 12;
  // User decision, Oct 21: a guessed hour from 1 to 6 is PM ("tomorrow at 5" → 5 PM), still inferred.
  const pmHour = meridiemGuessed && rawHour <= 6 ? rawHour + 12 : rawHour;
  // T-D2 after "night"/"tonight"/"last night", where chrono's day is the night's day:
  //  - a 24-hour time ("13:00") says the half of the day and is kept as written;
  //  - an explicit am ("1am") or a zero-padded hour ("01:00", "05:00", which states AM) is the next
  //    morning at the hour written, with no AM/PM line;
  //  - otherwise the written hour 5–11 is the evening (chrono reads "last night at 11" as 11 AM),
  //    and 12 or 1–4 is the next day's small hours, with the AM/PM line because it is a guess.
  //    "tonight at 5" stays 5 PM with no line (D50 guard).
  const night = timeKnown && NIGHT.test(text) && !H24_TIME.test(text);
  let hour = pmHour;
  let smallHours = false;
  let nightGuessed = false;
  if (night && EXPLICIT_AMPM.test(text)) {
    smallHours = hour < 12;
  } else if (night && ZERO_PADDED_TIME.test(text)) {
    hour = rawHour % 12;
    smallHours = true;
  } else if (night) {
    const written = rawHour % 12;
    if (written <= 4) {
      hour = written;
      smallHours = true;
      nightGuessed = true;
    } else {
      hour = written + 12;
    }
  }
  const time = timeKnown ? `${pad(hour)}:${pad(clock.get("minute") ?? 0)}` : null;
  // The small hours belong to the next calendar day.
  const nightDay = (day: string) => (smallHours ? new Date((dayNumber(day) + 1) * 86_400_000).toISOString().slice(0, 10) : day);
  const guessed = meridiemGuessed || nightGuessed;
  const dayStated = (["year", "month", "day", "weekday"] as const).some((k) => start.isCertain(k));
  if (!dayStated) {
    // "this morning", "tonight at 8": the written-on day. A bare time ("at 5", "5pm") names no
    // day, so it is not a due date.
    return SAME_DAY.test(text) ? { date: nightDay(ctx.referenceDate), time, meridiemGuessed: guessed } : null;
  }
  const y = start.get("year");
  const mo = start.get("month");
  const d = start.get("day");
  if (y === null || mo === null || d === null) return null;
  // A month-day with no year resolves to the past only within PAST_WINDOW_DAYS before the
  // written-on date ("Oct 4" written Oct 5 is overdue); otherwise to its next occurrence.
  let date: string | null = `${y}-${pad(mo)}-${pad(d)}`;
  if (start.isCertain("month") && start.isCertain("day") && !start.isCertain("year")) {
    date = monthDayYear(mo, d, ctx.referenceDate);
    if (!date) return null;
  }
  // A phrase that points back never becomes a future date ("previous Tuesday" read as tomorrow).
  if (past && dayNumber(date) > dayNumber(ctx.referenceDate)) return null;
  // A weekday that contradicts the stated date ("Monday Oct 9" when Oct 9 is a Friday): the source
  // contradicts itself, so neither reading is taken.
  const weekday = start.get("weekday");
  if (start.isCertain("weekday") && start.isCertain("day") && weekday !== null) {
    const actual = new Date(dayNumber(date) * 86_400_000).getUTCDay();
    if (actual !== weekday) {
      const refYear = Number(ctx.referenceDate.slice(0, 4));
      const day = formatDay(date, refYear).replace(/^\w+ /, "");
      return { refused: `"${text}" says ${WEEKDAY_NAMES[weekday]}, but ${day} is a ${WEEKDAY_NAMES[actual]}, so I didn't set a date.` };
    }
  }
  return { date: nightDay(date), time, meridiemGuessed: guessed };
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

  const reading = chronoResolve(text, ctx);
  const fromModel = input.date_iso ? modelWall(input.date_iso, ctx.timezone) : null;

  if (!reading || "refused" in reading) {
    return {
      ...NONE,
      agreement: input.date_iso ? "model_only" : "none",
      not_sure: [reading ? reading.refused : `I couldn't work out a date from "${text}", so I didn't set one.`],
    };
  }
  const fromChrono = reading;

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
