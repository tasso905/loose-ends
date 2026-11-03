import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { DueCertainty as DueCertaintySchema, type Band, type DueCertainty, type ThreadKind, type ThreadStatus } from "@/lib/schemas";
import { parseInstant } from "@/lib/time";
import { calendarDaysFrom, isWaitingPast } from "./attention";
import { StoredOrigin, threadNotSure } from "./explain";
import { sourceCaption } from "./view";

/**
 * why(): the F8 / F10 template strings (PRD F8 Technical, D34). Every line is built from stored
 * fields with fixed templates; nothing here calls a model (rule 6). Pure: the caller passes `now`
 * from getNow() and the user's timezone.
 *
 * Copy from the docs: the panel title, the reason-line shape `You told Mike "Friday" on Oct 5`, the
 * Why-now line `It's still open. It's due tomorrow.`, the correction `You changed the date from
 * Oct 9 to Oct 12` and `Original source deleted on {date}.` Every other string here is PROPOSED
 * (not in the docs; needs the user's approval) and is marked so where it is defined.
 */

export const WHY_COPY = {
  /** SITE_CONTRACT §2.8. */
  title: "Why am I seeing this?",
  /** SITE_CONTRACT §2.5 / CONTENT_MODEL §4: the reason line ends with this link. */
  why: "Why?",
  /** SITE_CONTRACT §2.8 actions. */
  thisIsWrong: "This is wrong",
  openSource: "Open source",
  /** SITE_CONTRACT §2.14: Why panel error. */
  loadFailed: "Couldn't load this explanation.",
  tryAgain: "Try again",
  /** PROPOSED: the close button's accessible name and label. */
  close: "Close",
  /** PROPOSED: the spinner's accessible name while the panel loads. */
  loading: "Loading the explanation",
  /** PROPOSED: heading over the Not sure about lines (the Explain card's own heading, reused). */
  notSure: "Not sure about",
  /** PROPOSED: heading over the user's corrections (the You wrote voice). */
  corrections: "You changed",
  /** PROPOSED: deleted source when no deletion date is recorded (F13 records one). */
  sourceDeletedNoDate: "Original source deleted.",
  /** PROPOSED: a thread with no quote behind it (a quick add has its text as the quote). */
  noQuote: "There's no source quote for this thread.",
} as const;

/** `Original source deleted on Oct 12.` (CONTENT_MODEL §7); the plain form when no date is recorded. */
export function sourceDeletedLine(deletedAt: string | null, timezone: string): string {
  if (!deletedAt) return WHY_COPY.sourceDeletedNoDate;
  return `Original source deleted on ${formatInTimeZone(parseInstant(deletedAt), timezone, "MMM d")}.`;
}

/** A YYYY-MM-DD written-on date as "Oct 5" (a calendar date, so no timezone shift). */
export function shortDate(ymd: string): string {
  return formatInTimeZone(parseInstant(`${ymd}T12:00:00Z`), "UTC", "MMM d");
}

const shortInstant = (iso: string, timezone: string) => formatInTimeZone(parseInstant(iso), timezone, "MMM d");
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export interface ReasonSource {
  title: string | null;
  kind: string;
  /** YYYY-MM-DD, the written-on date. */
  reference_date: string;
}

export interface ReasonThread {
  kind: ThreadKind;
  status: ThreadStatus;
  counterparty: string | null;
  waiting_on: string | null;
  expected_by: string | null;
  created_at: string;
}

/** The source's name as the reason line says it; PROPOSED `Uploaded file` and `Quick add` (as sourceCaption). */
function sourceName(s: ReasonSource): string {
  if (s.title) return s.title;
  return s.kind === "paste" ? "Pasted text" : s.kind === "upload" ? "Uploaded file" : s.kind === "quick_add" ? "Quick add" : "Source";
}

/**
 * The Today reason line, without the trailing `· Why?` link (the row adds it). It reuses the
 * source's own date phrase in quotes ("Source words first", DESIGN_STANDARD). `dateText` is the
 * stored `date_text` of the proposal the thread came from; `source` is null once it was deleted.
 *
 * Templates (only the first is in the docs; the rest are PROPOSED):
 *   commitment + counterparty + date text  You told Mike "Friday" on Oct 5
 *   commitment + counterparty              You told Mike on Oct 5
 *   commitment + date text                 You said "Friday" on Oct 5
 *   request + counterparty                 Mike asked you on Oct 5   (+ `: "Friday"` with a date text)
 *   waiting past expected-by               Expected from Mike by Oct 9
 *   waiting                                Waiting on Mike
 *   anything else with a source            From Renewal notice, Oct 5   (+ ` · "Nov 1"` with a date text)
 *   no source                              You added this on Oct 5
 */
export function reasonLine(
  t: ReasonThread,
  ctx: { dateText: string | null; source: ReasonSource | null; timezone: string; now: Date },
): string {
  const on = ctx.source ? ` on ${shortDate(ctx.source.reference_date)}` : "";
  const quoted = ctx.dateText ? `"${ctx.dateText}"` : null;
  const who = t.counterparty;

  if (t.status === "waiting") {
    const them = t.waiting_on ?? who;
    if (t.expected_by && isWaitingPast(t, ctx.timezone, ctx.now)) {
      return them ? `Expected from ${them} by ${shortInstant(t.expected_by, ctx.timezone)}` : `Expected by ${shortInstant(t.expected_by, ctx.timezone)}`;
    }
    if (them) return `Waiting on ${them}`;
  }
  if (t.kind === "commitment" && (who || quoted)) {
    if (who) return quoted ? `You told ${who} ${quoted}${on}` : `You told ${who}${on}`;
    return `You said ${quoted}${on}`;
  }
  if (t.kind === "request" && who) return `${who} asked you${on}${quoted ? `: ${quoted}` : ""}`;
  if (ctx.source) {
    return `From ${sourceName(ctx.source)}, ${shortDate(ctx.source.reference_date)}${quoted ? ` · ${quoted}` : ""}`;
  }
  return `You added this on ${shortInstant(t.created_at, ctx.timezone)}`;
}

export interface NowThread extends ReasonThread {
  due_at: string | null;
  resolved_at: string | null;
  snoozed_until: string | null;
}

/**
 * Why now (CONTENT_MODEL §7, e.g. `It's still open. It's due tomorrow.`): the status sentence,
 * then the timing sentence. Only the example sentences are in the docs; the rest are PROPOSED.
 */
export function whyNow(t: NowThread, timezone: string, now: Date): string {
  if (t.status === "resolved") return t.resolved_at ? `You resolved this on ${shortInstant(t.resolved_at, timezone)}.` : "You resolved this.";
  if (t.status === "dismissed") return "You dismissed this.";
  if (t.status === "snoozed" && t.snoozed_until && parseInstant(t.snoozed_until).getTime() > now.getTime()) {
    return `It's snoozed until ${shortInstant(t.snoozed_until, timezone)}.`;
  }
  if (t.status === "waiting") {
    const them = t.waiting_on ?? t.counterparty;
    const first = them ? `You're still waiting on ${them}.` : "You're still waiting.";
    if (!t.expected_by) return first;
    const past = calendarDaysFrom(t.expected_by, timezone, now) < 0;
    return `${first} ${past ? "It was expected by" : "It's expected by"} ${shortInstant(t.expected_by, timezone)}.`;
  }
  return `It's still open. ${dueSentence(t.due_at, timezone, now)}`;
}

function dueSentence(dueAt: string | null, timezone: string, now: Date): string {
  if (dueAt === null) return "It has no due date.";
  const d = calendarDaysFrom(dueAt, timezone, now);
  if (d < 0) return `It's ${days(-d)} overdue.`;
  if (d === 0) return "It's due today.";
  if (d === 1) return "It's due tomorrow.";
  if (d <= 14) return `It's due in ${days(d)}.`;
  return `It's due ${shortInstant(dueAt, timezone)}.`;
}

/** The stored date fields of the proposal behind a thread (extraction_items.payload.date). */
export interface StoredDate {
  due_at: string | null;
  due_certainty: DueCertainty;
  reasoning: string | null;
}

/**
 * Reasoning steps about the date (PRD F8: "what the system concluded and how"). The pipeline's own
 * deterministic step (`I read "Friday" as Fri Oct 9 (message dated Mon Oct 5).`) is shown only while
 * the thread still holds that date; once the user changed it, the correction says so instead and the
 * AI's value is never shown as current. PROPOSED: `The source doesn't give a date.`
 */
export function dateSteps(thread: { due_at: string | null; due_certainty: DueCertainty }, stored: StoredDate | null): string[] {
  if (!stored) return [];
  const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : parseInstant(a).getTime() === parseInstant(b).getTime());
  if (!same(thread.due_at, stored.due_at)) return [];
  if (thread.due_at === null) return stored.due_certainty === "none" ? ["The source doesn't give a date."] : [];
  return stored.reasoning ? [stored.reasoning] : [];
}

export interface CorrectionEvent {
  type: string;
  actor: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * The user's own corrections, oldest first (CONTENT_MODEL §7: `You changed the date from Oct 9 to
 * Oct 12`; user edits win). Only edits by the user count. PROPOSED: `You set the date to Oct 12`,
 * `You removed the date` and `You changed the title to "…"`.
 */
export function corrections(events: CorrectionEvent[], timezone: string): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== "edited" || e.actor !== "user" || !e.after) continue;
    if ("due_at" in e.after) {
      const from = typeof e.before?.due_at === "string" ? shortInstant(e.before.due_at, timezone) : null;
      const to = typeof e.after.due_at === "string" ? shortInstant(e.after.due_at, timezone) : null;
      if (to && from) out.push(`You changed the date from ${from} to ${to}`);
      else if (to) out.push(`You set the date to ${to}`);
      else if (from) out.push("You removed the date");
    }
    if (typeof e.after.title === "string") out.push(`You changed the title to "${e.after.title}"`);
  }
  return out;
}

/** ±200 characters of source context around the quote (PRD F8). */
export const CONTEXT_CHARS = 200;

export interface QuoteContext {
  before: string;
  quote: string;
  after: string;
  /** True when the source goes on past the shown context (the 32 px fade mask, DESIGN_STANDARD). */
  clippedBefore: boolean;
  clippedAfter: boolean;
}

/**
 * The verified quote inside its source context. Uses the stored offsets when the source text still
 * holds the quote there; otherwise the quote's first exact occurrence; otherwise the quote alone
 * (the text was purged or no longer contains it). Never widens a cut into the middle of a UTF-16
 * surrogate pair.
 */
export function quoteContext(text: string | null, ev: { quote: string; start_offset: number | null; end_offset: number | null }): QuoteContext {
  const alone: QuoteContext = { before: "", quote: ev.quote, after: "", clippedBefore: false, clippedAfter: false };
  if (!text) return alone;
  let start = -1;
  if (ev.start_offset !== null && ev.end_offset !== null && text.slice(ev.start_offset, ev.end_offset) === ev.quote) start = ev.start_offset;
  else start = text.indexOf(ev.quote);
  if (start < 0) return alone;
  const end = start + ev.quote.length;
  let from = Math.max(0, start - CONTEXT_CHARS);
  let to = Math.min(text.length, end + CONTEXT_CHARS);
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from -= 1;
  if (to < text.length && isLowSurrogate(text.charCodeAt(to))) to += 1;
  return {
    before: text.slice(from, start),
    quote: text.slice(start, end),
    after: text.slice(end, to),
    clippedBefore: from > 0,
    clippedAfter: to < text.length,
  };
}

const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Everything the Why sheet shows, built on the server from stored fields only (rule 6). */
export interface WhyView {
  threadId: string;
  title: string;
  /** null: no evidence row (nothing to quote). */
  quote: QuoteContext | null;
  /** `Pasted text · Oct 5`, `Renewal notice · p. 2` (sourceCaption); null with no evidence. */
  caption: string | null;
  /** The source row is gone (D47): the quote stays, Open source is replaced by this line. */
  sourceDeleted: string | null;
  /** For Open source → `/sources/{id}?evidence={evidenceId}` once the Source viewer ships. */
  sourceId: string | null;
  evidenceId: string | null;
  steps: string[];
  notSure: string[];
  /** The stored F19 label of the proposal it came from (never recomputed). */
  origin: { band: Exclude<Band, "ignore">; label: { word: string; reason: string } } | null;
  whyNow: string;
  corrections: string[];
}

const StoredPayload = StoredOrigin.and(
  z
    .object({
      label: z.object({ word: z.string(), reason: z.string() }).nullable().optional(),
      date: z
        .object({ due_at: z.string().nullable().optional(), due_certainty: DueCertaintySchema.optional(), reasoning: z.string().nullable().optional() })
        .loose()
        .optional(),
    })
    .loose(),
);

export interface WhyInput {
  thread: NowThread & { id: string; title: string; due_certainty: DueCertainty };
  /** The thread's first evidence row (by id), or null. */
  evidence: { id: string; quote: string; start_offset: number | null; end_offset: number | null; page: number | null; source_id: string | null } | null;
  /** That evidence's source, or null once it was deleted. `text_content` is null after the retention purge. */
  source: (ReasonSource & { id: string; text_content: string | null }) | null;
  /** When the source was deleted, if recorded (F13); null otherwise. */
  sourceDeletedAt: string | null;
  /** The stored proposal behind the thread (band + payload), or null for a thread with none. */
  item: { band: Band; payload: unknown } | null;
  events: CorrectionEvent[];
  timezone: string;
  now: Date;
}

/** why(): assembles the Why sheet from stored rows with the templates above (no model call). */
export function why(input: WhyInput): WhyView {
  const { thread: t, evidence: ev, source, timezone, now } = input;
  const parsed = input.item ? StoredPayload.safeParse(input.item.payload) : null;
  const payload = parsed?.success ? parsed.data : null;
  const stored: StoredDate | null = payload?.date
    ? { due_at: payload.date.due_at ?? null, due_certainty: payload.date.due_certainty ?? "none", reasoning: payload.date.reasoning ?? null }
    : null;
  const label = payload?.label ?? null;
  const sourceGone = ev !== null && (ev.source_id === null || source === null);
  return {
    threadId: t.id,
    title: t.title,
    quote: ev ? quoteContext(source?.text_content ?? null, ev) : null,
    caption: ev ? sourceCaption(source, ev.page) : null,
    sourceDeleted: sourceGone ? sourceDeletedLine(input.sourceDeletedAt, timezone) : null,
    sourceId: sourceGone ? null : (source?.id ?? null),
    evidenceId: ev?.id ?? null,
    steps: dateSteps(t, stored),
    notSure: threadNotSure(payload, t),
    origin: input.item && input.item.band !== "ignore" && label ? { band: input.item.band, label } : null,
    whyNow: whyNow(t, timezone, now),
    corrections: corrections(input.events, timezone),
  };
}
