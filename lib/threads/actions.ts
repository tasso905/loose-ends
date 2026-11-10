import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { zonedInstant } from "@/lib/dates";
import { ThreadKind, ThreadStatus } from "@/lib/schemas";
import { parseInstant } from "@/lib/time";
import { charCount, EDIT_LIMITS, isBlankText } from "./transition";

/**
 * S12 (F9) thread actions beyond Done and Resolve: Mark waiting, Snooze, Edit, Dismiss, Reopen,
 * plus the lifecycle table's Back to me and Wake now. Input validation, date rules and copy.
 * Client-safe (no I/O). Status changes themselves go through transition() in TypeScript and the
 * matching SQL function (migration 20261110120000).
 *
 * DOCUMENTED copy: `Mark waiting`, `Snooze`, `Edit`, `Dismiss`, `Reopen`, `More actions`
 * (SITE_CONTRACT §2.7, CONTENT_MODEL §6); `Waiting on`, `Expected by` (§2.7 Mark waiting form);
 * `Tomorrow, 9:00`, `Next Monday, 9:00`, `Pick a date…` (§2.7, D11, DESIGN_STANDARD Snooze menu);
 * `Back to me`, `Wake now` (PRD lifecycle table action names); `Cancel` (D56); field copy reused
 * from D47 (`Titles can be up to 120 characters.`, `Enter a real date between 1900 and 2100.`).
 *
 * PROPOSED copy (not in the docs; for user sign-off): every string marked PROPOSED below.
 */
export const ACTIONS_COPY = {
  markWaiting: "Mark waiting",
  snooze: "Snooze",
  edit: "Edit",
  dismiss: "Dismiss",
  reopen: "Reopen",
  backToMe: "Back to me",
  wakeNow: "Wake now",
  cancel: "Cancel",
  waitingOn: "Waiting on",
  /** PROPOSED: `(optional)` added, as D47's `Title (optional)`. */
  expectedBy: "Expected by (optional)",
  tomorrow: "Tomorrow, 9:00",
  nextMonday: "Next Monday, 9:00",
  pickDate: "Pick a date…",
  /** PROPOSED: the date field and button after `Pick a date…`. */
  snoozeDateLabel: "Snooze until",
  snoozeConfirm: "Snooze",
  /** PROPOSED: Edit sheet. */
  editHeading: "Edit thread",
  editSave: "Save changes",
  title: "Title",
  kind: "Loop type",
  nextAction: "Next action",
  counterparty: "Person or organization",
  dueDate: "Due date",
  dueTime: "Time (optional)",
  snoozedUntil: "Snoozed until",
  /** PROPOSED: field errors. */
  titleRequired: "Give this thread a title.",
  waitingOnRequired: "Write who you're waiting on.",
  pickFutureDate: "Pick a date after today.",
  /** D47 (approved for the Add form), reused. */
  titleTooLong: "Titles can be up to 120 characters.",
  badDate: "Enter a real date between 1900 and 2100.",
  /** PROPOSED: undo toasts and their Undo labels, in the pattern of D47 / D56. */
  markWaitingToast: (title: string) => `Marked waiting: "${title}"`,
  markWaitingUndo: (title: string) => `Undo mark waiting: ${title}`,
  snoozeToast: (title: string) => `Snoozed: "${title}"`,
  snoozeUndo: (title: string) => `Undo snooze: ${title}`,
  dismissToast: (title: string) => `Dismissed: "${title}"`,
  dismissUndo: (title: string) => `Undo dismiss: ${title}`,
  editToast: (title: string) => `Saved changes to "${title}"`,
  editUndo: (title: string) => `Undo edit: ${title}`,
} as const;

/** Snooze presets are all at 9:00 in the user's timezone (D11). */
export const SNOOZE_TIME = "09:00";
/** A date-only deadline or expected-by date is stored at 23:59 local time (as the pipeline does). */
export const END_OF_DAY = "23:59";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real calendar date YYYY-MM-DD between 1900 and 2100 (the D47 rule). */
export function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2100;
}

/** YYYY-MM-DD `n` calendar days after `date`. */
export function addDays(date: string, n: number): string {
  const d = parseInstant(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The user's local date today. */
export const localToday = (now: Date, timezone: string) => formatInTimeZone(now, timezone, "yyyy-MM-dd");
/** An instant as the user's local date and 24 h time, for prefilling date and time fields. */
export const localDate = (iso: string, timezone: string) => formatInTimeZone(parseInstant(iso), timezone, "yyyy-MM-dd");
export const localTime = (iso: string, timezone: string) => formatInTimeZone(parseInstant(iso), timezone, "HH:mm");

export type SnoozeChoice = { preset: "tomorrow" } | { preset: "next_monday" } | { preset: "date"; date: string };

/**
 * The local date a snooze choice wakes on. Next Monday is the first Monday after today (a week
 * ahead when today is a Monday; tomorrow when today is a Sunday).
 */
export function snoozeDate(choice: SnoozeChoice, now: Date, timezone: string): string {
  const today = localToday(now, timezone);
  if (choice.preset === "tomorrow") return addDays(today, 1);
  if (choice.preset === "next_monday") {
    const isoWeekday = Number(formatInTimeZone(now, timezone, "i")); // 1 = Monday … 7 = Sunday
    return addDays(today, 8 - isoWeekday);
  }
  return choice.date;
}

/** The instant a snooze choice wakes at (9:00 local), or null when that is not after `now`. */
export function snoozeUntil(choice: SnoozeChoice, now: Date, timezone: string): string | null {
  const date = snoozeDate(choice, now, timezone);
  if (!isRealDate(date)) return null;
  const until = zonedInstant(date, SNOOZE_TIME, timezone);
  return until.getTime() > now.getTime() ? until.toISOString() : null;
}

/** What the Snooze menu shows: each preset's resolved date, and the earliest date `Pick a date…` allows (tomorrow). */
export interface SnoozeMenuDates {
  tomorrow: string;
  nextMonday: string;
  /** YYYY-MM-DD: past dates and today are disabled in the picker. */
  minDate: string;
}

/** The resolved date right-aligned beside each preset (DESIGN_STANDARD Snooze menu), e.g. `Wed Nov 11`. */
export function snoozeMenuDates(now: Date, timezone: string): SnoozeMenuDates {
  const label = (date: string) => formatInTimeZone(parseInstant(`${date}T12:00:00Z`), "UTC", "EEE MMM d");
  return {
    tomorrow: label(snoozeDate({ preset: "tomorrow" }, now, timezone)),
    nextMonday: label(snoozeDate({ preset: "next_monday" }, now, timezone)),
    minDate: addDays(localToday(now, timezone), 1),
  };
}

/** A date-only field (expected by, a due date with no time) as an instant: 23:59 local. */
export const endOfLocalDay = (date: string, timezone: string) => zonedInstant(date, END_OF_DAY, timezone).toISOString();

// --- Server action inputs ------------------------------------------------------------------------

const DateOnly = z.string().refine(isRealDate, "bad_date");
const Base = { threadId: z.uuid(), fromStatus: ThreadStatus };

const WaitingOn = z
  .string()
  .refine((s) => !isBlankText(s), "required")
  .refine((s) => charCount(s) <= EDIT_LIMITS.waiting_on, "too_long");

export const MarkWaitingInput = z.object({ ...Base, waitingOn: WaitingOn, expectedBy: DateOnly.nullable() });
export type MarkWaitingInput = z.input<typeof MarkWaitingInput>;

export const SnoozeInput = z.object({
  ...Base,
  choice: z.discriminatedUnion("preset", [
    z.object({ preset: z.literal("tomorrow") }),
    z.object({ preset: z.literal("next_monday") }),
    z.object({ preset: z.literal("date"), date: DateOnly }),
  ]),
});
export type SnoozeInput = z.input<typeof SnoozeInput>;

/** Actions with no input of their own. */
export const SimpleAction = z.enum(["dismiss", "back_to_me", "wake", "reopen"]);
export type SimpleAction = z.infer<typeof SimpleAction>;
export const SimpleInput = z.object({ ...Base, action: SimpleAction });
export type SimpleInput = z.input<typeof SimpleInput>;

/** Optional text: blank means "none" (null), never an empty string. */
const optionalText = (max: number) =>
  z
    .string()
    .nullable()
    .refine((s) => s === null || charCount(s) <= max, "too_long")
    .transform((s) => (s === null || isBlankText(s) ? null : s));

/**
 * Edit sends only the fields the user changed. Dates are local calendar dates (and an optional
 * 24 h time for the due date); the server turns them into instants in the user's timezone.
 */
export const EditFields = z.strictObject({
  title: z
    .string()
    .refine((s) => !isBlankText(s), "required")
    .refine((s) => charCount(s) <= EDIT_LIMITS.title, "too_long")
    .optional(),
  kind: ThreadKind.optional(),
  next_action: optionalText(EDIT_LIMITS.next_action).optional(),
  counterparty: optionalText(EDIT_LIMITS.counterparty).optional(),
  due: z
    .object({ date: DateOnly, time: z.string().regex(TIME_RE).nullable() })
    .nullable()
    .optional(),
  waiting_on: WaitingOn.optional(),
  expected_by: DateOnly.nullable().optional(),
  snoozed_until: DateOnly.optional(),
});
export type EditFields = z.input<typeof EditFields>;
export const EditInput = z.object({ ...Base, fields: EditFields });
export type EditInput = z.input<typeof EditInput>;

/** The SQL function's p_fields (transition() EditableFields): instants in the user's timezone. */
export function editFieldsToState(
  f: z.output<typeof EditFields>,
  timezone: string,
  now: Date,
): { ok: true; fields: Record<string, unknown> } | { ok: false; field: "snoozed_until" } {
  const out: Record<string, unknown> = {};
  if (f.title !== undefined) out.title = f.title;
  if (f.kind !== undefined) out.kind = f.kind;
  if (f.next_action !== undefined) out.next_action = f.next_action;
  if (f.counterparty !== undefined) out.counterparty = f.counterparty;
  if (f.due !== undefined) {
    if (f.due === null) out.due_at = null;
    else {
      out.due_at = zonedInstant(f.due.date, f.due.time ?? END_OF_DAY, timezone).toISOString();
      out.due_time_known = f.due.time !== null;
    }
  }
  if (f.waiting_on !== undefined) out.waiting_on = f.waiting_on;
  if (f.expected_by !== undefined) out.expected_by = f.expected_by === null ? null : endOfLocalDay(f.expected_by, timezone);
  if (f.snoozed_until !== undefined) {
    const until = snoozeUntil({ preset: "date", date: f.snoozed_until }, now, timezone);
    if (!until) return { ok: false, field: "snoozed_until" };
    out.snoozed_until = until;
  }
  return { ok: true, fields: out };
}

/** Which actions a thread offers (PRD lifecycle table; D6 for Done on decision threads). */
export function availableActions(t: { status: ThreadStatus; kind: string }) {
  const s = t.status;
  const active = s === "open" || s === "waiting" || s === "snoozed";
  return {
    done: active && t.kind !== "decision",
    resolve: active,
    markWaiting: s === "open",
    backToMe: s === "waiting",
    wake: s === "snoozed",
    // Snoozing a waiting thread is not allowed in the MVP.
    snooze: s === "open",
    edit: true,
    dismiss: active,
    reopen: s === "resolved" || s === "dismissed",
  };
}
