import { formatInTimeZone } from "date-fns-tz";
import { parseInstant } from "@/lib/time";

/**
 * Due-date label (DESIGN_STANDARD "Dates and numbers"), in the user's timezone, relative to the
 * `now` the caller got from getNow(). A time is shown only when the source gave one.
 */
export function formatDue(dueAt: string, opts: { timeKnown: boolean; timezone: string; now: Date }): string {
  const due = parseInstant(dueAt);
  const day = (d: Date) => formatInTimeZone(d, opts.timezone, "yyyy-MM-dd");
  const days = Math.round((Date.parse(`${day(due)}T00:00:00Z`) - Date.parse(`${day(opts.now)}T00:00:00Z`)) / 86_400_000);
  const time = opts.timeKnown ? `, ${formatInTimeZone(due, opts.timezone, "h:mm a")}` : "";

  if (days < 0) return `${-days} ${days === -1 ? "day" : "days"} overdue`;
  if (days === 0) return `Due today${time}`;
  if (days === 1) return `Due tomorrow${time}`;
  if (days <= 6) return `Due ${formatInTimeZone(due, opts.timezone, "EEE")}${time}`;
  const sameYear = formatInTimeZone(due, opts.timezone, "yyyy") === formatInTimeZone(opts.now, opts.timezone, "yyyy");
  return `${formatInTimeZone(due, opts.timezone, sameYear ? "EEE MMM d" : "EEE MMM d, yyyy")}${time}`;
}
