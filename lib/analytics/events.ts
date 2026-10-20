import { z } from "zod";
import { Band, Resolution, ThreadStatus } from "@/lib/schemas";
import { AnswerPartKind } from "@/lib/ai/schema";

/**
 * PostHog event allow-list (PRD "Analytics & Success Metrics", event taxonomy v1.1).
 *
 * Rule 9: properties carry IDs, enums, counts and booleans only — never source text, titles,
 * quotes, names or reasons. Every schema is strict, so an unknown property is rejected, and no
 * property accepts a free string: IDs must be UUIDs, everything else is an enum, a bounded
 * integer or a boolean. Adding an event here does not ship it; it ships with the feature that
 * fires it (D40).
 */

const id = z.uuid();
const count = z.number().int().min(0).max(1_000_000);
/** Counts per key from a closed set. Strict, so an unknown key (free text) is rejected. */
const countsBy = <T extends readonly [string, ...string[]]>(keys: T) =>
  z.strictObject(Object.fromEntries(keys.map((k) => [k, count.optional()])) as { [K in T[number]]: z.ZodOptional<typeof count> });

export const SOURCE_KINDS = ["paste", "upload", "quick_add", "email_forward"] as const; // sources.kind
export const FILE_TYPES = ["pdf", "txt", "md", "docx"] as const; // SITE_CONTRACT §2.13 unsupported_type
/** Character-count buckets for `source_submitted` (the exact count is not sent). */
export const CHAR_COUNT_BUCKETS = ["lt_500", "500_2k", "2k_10k", "10k_30k", "gt_30k"] as const;
export const SURFACES = ["today", "detail", "digest"] as const;
/** Review-tray inline-edit fields (SITE_CONTRACT §2.4): title, loop type, date, counterparty. */
export const REVIEW_EDIT_FIELDS = ["title", "kind", "due_at", "counterparty"] as const;
/** `transition()` action types (lib/threads/transition.ts `ThreadActionType`). */
export const THREAD_ACTIONS = [
  "create",
  "mark_waiting",
  "snooze",
  "done",
  "resolve",
  "dismiss",
  "back_to_me",
  "wake",
  "reopen",
  "edit",
  "forget",
] as const;

const surface = z.enum(SURFACES);
const bandCounts = countsBy(Band.options as unknown as readonly ["high", "medium", "low", "ignore"]);

export const ANALYTICS_EVENTS = {
  source_submitted: z.strictObject({
    kind: z.enum(SOURCE_KINDS),
    char_count_bucket: z.enum(CHAR_COUNT_BUCKETS),
    file_type: z.enum(FILE_TYPES).optional(),
  }),
  extraction_completed: z.strictObject({
    extraction_id: id,
    status: z.enum(["succeeded", "failed"]),
    latency_ms: count,
    item_count: count,
    band_counts: bandCounts,
  }),
  proposals_shown: z.strictObject({ extraction_id: id, band_counts: bandCounts }),
  proposal_reviewed: z.strictObject({
    item_id: id,
    band: Band,
    action: z.enum(["accepted", "edited", "rejected"]),
    fields_edited: z.array(z.enum(REVIEW_EDIT_FIELDS)).max(REVIEW_EDIT_FIELDS.length),
  }),
  clarification_answered: z.strictObject({ choice_kind: z.enum(["participant", "none"]), alias_saved: z.boolean() }),
  thread_action: z.strictObject({
    thread_id: id,
    action: z.enum(THREAD_ACTIONS),
    from_status: ThreadStatus.nullable(),
    to_status: ThreadStatus.nullable(),
    surface,
  }),
  undo_used: z.strictObject({ action: z.enum(THREAD_ACTIONS) }),
  why_opened: z.strictObject({ thread_id: id, surface }),
  marked_wrong: z.strictObject({ thread_id: id, next_step: z.enum(["edit", "dismiss"]) }),
  not_useful: z.strictObject({ thread_id: id, surface }),
  resolve_saved: z.strictObject({ resolution: Resolution, reason_given: z.boolean() }),
  ask_submitted: z.strictObject({
    answer_found: z.boolean(),
    parts_by_kind: countsBy(AnswerPartKind.options as unknown as readonly ["user_reason", "source_fact", "inference"]),
  }),
  source_deleted: z.strictObject({ cascade: z.boolean().optional() }),
  data_exported: z.strictObject({}),
  account_deleted: z.strictObject({}),
  trust_rating: z.strictObject({ score: z.number().int().min(1).max(5) }),
} as const;

export type AnalyticsEvent = keyof typeof ANALYTICS_EVENTS;
export type AnalyticsProps<E extends AnalyticsEvent> = z.input<(typeof ANALYTICS_EVENTS)[E]>;
export const ANALYTICS_EVENT_NAMES = Object.keys(ANALYTICS_EVENTS) as AnalyticsEvent[];

export type ValidatedEvent =
  | { ok: true; event: AnalyticsEvent; props: Record<string, unknown> }
  /** Why it was rejected, as enums and property *names* only — never the rejected values. */
  | { ok: false; reason: "unknown_event" | "invalid_props"; event: AnalyticsEvent | null; fields: string[] };

export function validateEvent(event: string, props: unknown): ValidatedEvent {
  if (!Object.hasOwn(ANALYTICS_EVENTS, event)) return { ok: false, reason: "unknown_event", event: null, fields: [] };
  const name = event as AnalyticsEvent;
  const parsed = ANALYTICS_EVENTS[name].safeParse(props);
  if (parsed.success) return { ok: true, event: name, props: parsed.data as Record<string, unknown> };
  const fields = new Set<string>();
  for (const issue of parsed.error.issues) {
    const base = issue.path.map(String);
    const paths = issue.code === "unrecognized_keys" ? issue.keys.map((k) => [...base, k]) : [base];
    for (const path of paths) fields.add(path.length ? path.map(loggableSegment).join(".") : "(root)");
  }
  return { ok: false, reason: "invalid_props", event: name, fields: [...fields].sort() };
}

/**
 * Property-name segments that may appear in a rejection log line: a closed list, so a key built
 * from content (even an identifier-shaped one like `Pay_Dana_1470_for_the_roof_by_Friday`) can
 * never reach the log. Any other segment is logged as `(invalid_key)`; array indices as numbers.
 */
const LOGGABLE_KEYS: ReadonlySet<string> = new Set([
  // Every taxonomy property name.
  ...Object.values(ANALYTICS_EVENTS).flatMap((schema) => Object.keys(schema.shape)),
  // Count-map keys.
  ...Band.options,
  ...AnswerPartKind.options,
  // Domain field names a caller might wrongly pass (thread and proposal columns, common content
  // fields), named so the log says which mistake was made. Names only; never their values.
  ...["title", "quote", "reason", "name", "email", "text", "note", "content", "source_text"],
  ...["counterparty", "next_action", "action_text", "consequence", "waiting_on", "date_text", "amount_text"],
  ...["evidence", "speaker", "summary", "question", "answer", "display_name", "aliases"],
]);

function loggableSegment(segment: string): string {
  if (/^\d{1,6}$/.test(segment)) return segment;
  return LOGGABLE_KEYS.has(segment) ? segment : "(invalid_key)";
}

/** Bucket a character count for `source_submitted.char_count_bucket`. */
export function charCountBucket(n: number): (typeof CHAR_COUNT_BUCKETS)[number] {
  if (n < 500) return "lt_500";
  if (n < 2_000) return "500_2k";
  if (n < 10_000) return "2k_10k";
  if (n <= 30_000) return "10k_30k";
  return "gt_30k";
}
