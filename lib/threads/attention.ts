import { formatInTimeZone } from "date-fns-tz";
import type { ThreadStatus } from "@/lib/schemas";
import { parseInstant } from "@/lib/time";

/**
 * F10 ranking (PRD "Notification Philosophy" and "Stored status vs. computed urgency"). Pure and
 * deterministic: the caller passes `now` from getNow() and the user's timezone. Urgency is computed
 * at read time from `due_at` and never stored (D2).
 *
 *   score = urgency_weight × confidence × consequence_weight × freshness_penalty
 *   urgency_weight:     overdue 1.0 · due_today 0.9 · due_soon 0.7 · upcoming 0.3 · none 0.2
 *                       waiting past expected_by 0.6
 *   consequence_weight: 1.2 when the consequence is source-backed, else 1.0
 *   freshness_penalty:  0.5 when seen in a digest in the last 48 h without action (F15, not built: 1.0)
 *
 * Today "Worth your attention" = the top 5 by score with score ≥ 0.3.
 */

export type Urgency = "overdue" | "due_today" | "due_soon" | "upcoming" | "later" | "none";

/**
 * `later` (due more than 14 days out) is not named in the PRD table; it takes the `none` weight,
 * so it can never reach the 0.3 threshold on its own.
 */
export const URGENCY_WEIGHT: Record<Urgency, number> = {
  overdue: 1.0,
  due_today: 0.9,
  due_soon: 0.7,
  upcoming: 0.3,
  later: 0.2,
  none: 0.2,
};
export const WAITING_PAST_WEIGHT = 0.6;
export const SOURCE_CONSEQUENCE_WEIGHT = 1.2;
export const ATTENTION_MIN_SCORE = 0.3;
export const ATTENTION_MAX = 5;
export const COMING_UP_DAYS = 14;
export const DUE_SOON_DAYS = 3;
export const RECENTLY_RESOLVED_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Whole calendar days from `now` to `instant`, both read as dates in `timezone`. Counting dates
 * (not 24 h blocks) keeps a 23 h or 25 h DST day at exactly one day.
 */
export function calendarDaysFrom(instant: string | Date, timezone: string, now: Date): number {
  const day = (d: Date) => Date.parse(`${formatInTimeZone(d, timezone, "yyyy-MM-dd")}T00:00:00Z`);
  const at = typeof instant === "string" ? parseInstant(instant) : instant;
  return Math.round((day(at) - day(now)) / DAY_MS);
}

/** PRD urgency: overdue = before the start of today; due_soon = the next 3 days; upcoming = the next 14. */
export function urgency(dueAt: string | null, timezone: string, now: Date): Urgency {
  if (dueAt === null) return "none";
  const days = calendarDaysFrom(dueAt, timezone, now);
  if (days < 0) return "overdue";
  if (days === 0) return "due_today";
  if (days <= DUE_SOON_DAYS) return "due_soon";
  if (days <= COMING_UP_DAYS) return "upcoming";
  return "later";
}

export interface ScoredThread {
  id: string;
  status: ThreadStatus;
  due_at: string | null;
  expected_by: string | null;
  snoozed_until: string | null;
  resolved_at: string | null;
  /** 0–1 from the proposal it came from; null (no proposal behind it) counts as 1.0. */
  confidence: number | null;
  consequence: string | null;
  consequence_basis: "source" | "interpretation" | null;
  created_at: string;
}

/** A waiting thread surfaces once its expected-by date has passed (a date before today, like overdue). */
export function isWaitingPast(t: Pick<ScoredThread, "status" | "expected_by">, timezone: string, now: Date): boolean {
  return t.status === "waiting" && t.expected_by !== null && calendarDaysFrom(t.expected_by, timezone, now) < 0;
}

/**
 * Snoozed threads stay hidden until `snoozed_until`; once that has passed they rank as open
 * (the wake transition is time-driven, so Today does not wait for it to be written).
 */
export function isAwake(t: Pick<ScoredThread, "status" | "snoozed_until">, now: Date): boolean {
  if (t.status === "open") return true;
  return t.status === "snoozed" && t.snoozed_until !== null && parseInstant(t.snoozed_until).getTime() <= now.getTime();
}

/**
 * The PRD score for an open or waiting thread; null for a thread Today never ranks (resolved,
 * dismissed, still snoozed, or waiting before its expected-by date).
 */
export function attentionScore(t: ScoredThread, timezone: string, now: Date, opts: { seenInDigest?: boolean } = {}): number | null {
  let weight: number;
  if (isAwake(t, now)) weight = URGENCY_WEIGHT[urgency(t.due_at, timezone, now)];
  else if (isWaitingPast(t, timezone, now)) weight = WAITING_PAST_WEIGHT;
  else return null;
  const confidence = t.confidence ?? 1;
  const consequence = t.consequence !== null && t.consequence_basis === "source" ? SOURCE_CONSEQUENCE_WEIGHT : 1;
  const freshness = opts.seenInDigest ? 0.5 : 1;
  return weight * confidence * consequence * freshness;
}

const time = (s: string | null) => (s === null ? null : parseInstant(s).getTime());

/** Deterministic order: score, then earliest due (undated last), then oldest, then id. */
function byRank<T extends ScoredThread>(a: { t: T; score: number }, b: { t: T; score: number }): number {
  if (a.score !== b.score) return b.score - a.score;
  const da = time(a.t.due_at ?? a.t.expected_by);
  const db = time(b.t.due_at ?? b.t.expected_by);
  if (da !== db) return da === null ? 1 : db === null ? -1 : da - db;
  return time(a.t.created_at)! - time(b.t.created_at)! || a.t.id.localeCompare(b.t.id);
}

const byDue = <T extends ScoredThread>(key: "due_at" | "expected_by") => (a: T, b: T) => {
  const da = time(a[key]);
  const db = time(b[key]);
  if (da !== db) return da === null ? 1 : db === null ? -1 : da - db;
  return time(a.created_at)! - time(b.created_at)! || a.id.localeCompare(b.id);
};

export interface TodaySections<T> {
  /** At most 5, score ≥ 0.3, highest first. */
  attention: T[];
  /** Waiting threads not surfaced into attention, by expected-by date (none last). */
  waiting: T[];
  /** Open threads due today through the next 14 days that are not in attention, soonest first. */
  comingUp: T[];
  /** Resolved in the last 7 days, newest first. */
  resolved: T[];
}

/**
 * Splits the user's threads into the Today sections (SITE_CONTRACT §2.5). Threads are already
 * accepted, so an unaccepted proposal (any band) can never be here (rule 4); an accepted Low thread
 * is ranked like any other (D4). Overdue threads beyond the cap of 5 are not repeated in Coming up.
 */
export function todaySections<T extends ScoredThread>(threads: T[], timezone: string, now: Date): TodaySections<T> {
  const scored = threads.flatMap((t) => {
    const score = attentionScore(t, timezone, now);
    return score === null ? [] : [{ t, score }];
  });
  // Floating-point products such as 0.6 × 0.5 land a hair below 0.3; compare with a tolerance.
  const attention = scored
    .filter((s) => s.score >= ATTENTION_MIN_SCORE - 1e-9)
    .sort(byRank)
    .slice(0, ATTENTION_MAX)
    .map((s) => s.t);
  const inAttention = new Set(attention.map((t) => t.id));

  const waiting = threads.filter((t) => t.status === "waiting" && !inAttention.has(t.id)).sort(byDue("expected_by"));
  const comingUp = threads
    .filter((t) => {
      if (inAttention.has(t.id) || !isAwake(t, now) || t.due_at === null) return false;
      const days = calendarDaysFrom(t.due_at, timezone, now);
      return days >= 0 && days <= COMING_UP_DAYS;
    })
    .sort(byDue("due_at"));
  const since = now.getTime() - RECENTLY_RESOLVED_DAYS * DAY_MS;
  const resolved = threads
    .filter((t) => t.status === "resolved" && t.resolved_at !== null && parseInstant(t.resolved_at).getTime() >= since)
    .sort((a, b) => time(b.resolved_at)! - time(a.resolved_at)! || a.id.localeCompare(b.id));

  return { attention, waiting, comingUp, resolved };
}
