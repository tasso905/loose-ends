import { z } from "zod";
import { ItemType } from "@/lib/ai/schema";

/** Shared domain schemas and types for rows in PRD "Database Schema". */

export const THREAD_STATUSES = ["open", "waiting", "snoozed", "resolved", "dismissed"] as const; // D2: 5 statuses
export const ThreadStatus = z.enum(THREAD_STATUSES);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

export const ThreadKind = z.enum(["commitment", "request", "waiting_on", "admin", "decision"]);
export type ThreadKind = z.infer<typeof ThreadKind>;

export const Resolution = z.enum(["done", "decided", "not_needed"]);
export type Resolution = z.infer<typeof Resolution>;

export const DueCertainty = z.enum(["explicit", "inferred", "none"]);
export type DueCertainty = z.infer<typeof DueCertainty>;

export const Band = z.enum(["high", "medium", "low", "ignore"]);
export type Band = z.infer<typeof Band>;

export const ReviewStatus = z.enum(["pending", "accepted", "edited", "rejected", "auto_created"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const Actor = z.enum(["user", "ai", "system"]);
export type Actor = z.infer<typeof Actor>;

export const ThreadEventType = z.enum([
  "created",
  "edited",
  "status_changed",
  "snoozed",
  "source_linked",
  "resolved",
  "reopened",
  "digest_sent",
  "marked_not_useful",
  // Proposed D44 (a): an 8 s undo of the latest event appends this; history is never rewritten.
  "undone",
]);
export type ThreadEventType = z.infer<typeof ThreadEventType>;

const isoInstant = z.iso.datetime({ offset: true });

export const Thread = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  title: z.string().min(1),
  kind: ThreadKind,
  next_action: z.string().nullable(),
  counterparty: z.string().nullable(),
  due_at: isoInstant.nullable(),
  due_certainty: DueCertainty,
  due_time_known: z.boolean(),
  consequence: z.string().nullable(),
  consequence_basis: z.enum(["source", "interpretation"]).nullable(),
  status: ThreadStatus,
  resolution: Resolution.nullable(),
  waiting_on: z.string().nullable(),
  expected_by: isoInstant.nullable(),
  snoozed_until: isoInstant.nullable(),
  primary_source_id: z.uuid().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  created_at: isoInstant,
  updated_at: isoInstant,
  resolved_at: isoInstant.nullable(),
});
export type Thread = z.infer<typeof Thread>;

export const ThreadEvent = z.object({
  id: z.number().int().optional(),
  user_id: z.uuid(),
  thread_id: z.uuid(),
  actor: Actor,
  type: ThreadEventType,
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  created_at: isoInstant.optional(),
});
export type ThreadEvent = z.infer<typeof ThreadEvent>;

export const ExtractionItemRow = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  extraction_id: z.uuid(),
  /** Versioned proposal payload (A11); parse with ProposalPayload from lib/extraction/payload.ts. */
  payload: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1),
  band: Band,
  review_status: ReviewStatus,
  thread_id: z.uuid().nullable(),
  suppression_hash: z.string().nullable(),
  reviewed_at: isoInstant.nullable(),
  /** Index in extractions.raw_output.items; lets Forget blank the model's copy. */
  item_index: z.number().int().nullable(),
});
export type ExtractionItemRow = z.infer<typeof ExtractionItemRow>;

export { ItemType };
