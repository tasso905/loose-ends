import { z } from "zod";

/**
 * AI Extraction Schema v1 (PRD "AI Extraction Schema"). Zod is the source of truth.
 * Changing anything here is a schema change: bump SCHEMA_VERSION and run `pnpm eval`.
 */
export const EXTRACTION_SCHEMA_VERSION = "extraction.v1";

export const ITEM_TYPES = ["commitment", "request", "waiting_on", "deadline", "intention", "decision", "key_fact"] as const;
export const ItemType = z.enum(ITEM_TYPES);
export type ItemType = z.infer<typeof ItemType>;

export const Owner = z.enum(["user", "other", "unknown"]);
export type Owner = z.infer<typeof Owner>;

export const Certainty = z.enum(["explicit", "implied", "speculative"]);
export type Certainty = z.infer<typeof Certainty>;

export const Evidence = z.object({
  quote: z.string().min(3).max(400), // verbatim from source
  speaker: z.string().nullable(), // who wrote/said it, if determinable
});
export type Evidence = z.infer<typeof Evidence>;

export const Item = z.object({
  type: ItemType,
  title: z.string().max(80), // short, imperative where actionable
  owner: Owner,
  counterparty: z.string().nullable(), // person/org as written
  action: z.string().nullable(), // what needs to happen
  date_text: z.string().nullable(), // raw phrase: "Friday", "by Oct 31"
  date_iso: z.string().nullable(), // model's resolution; re-checked server-side
  amount_text: z.string().nullable(), // "$1,470" exactly as written
  certainty: Certainty,
  uncertainty_notes: z.array(z.string()).max(3),
  matches_thread_id: z.string().nullable(), // only from provided list
  evidence: z.array(Evidence).min(1).max(3),
});
export type Item = z.infer<typeof Item>;

export const BriefLine = z.object({
  text: z.string(),
  basis: z.enum(["source", "interpretation"]),
  quote: z.string().nullable(), // required when basis = source
});
export type BriefLine = z.infer<typeof BriefLine>;

export const Brief = z.object({
  what_this_is: z.array(BriefLine),
  what_to_do: z.array(BriefLine),
  by_when: z.array(BriefLine),
  if_you_dont: z.array(BriefLine),
  worth_considering: z.array(BriefLine), // basis must be interpretation
  not_sure_about: z.array(z.string()),
});
export type Brief = z.infer<typeof Brief>;

export const Extraction = z.object({
  source_summary: z.string().max(200),
  participants: z.array(z.object({ name: z.string(), is_user: z.enum(["yes", "no", "unknown"]) })),
  items: z.array(Item).max(12),
  brief: Brief.nullable(), // only for document-like sources
});
export type Extraction = z.infer<typeof Extraction>;

/**
 * Ask-why structured output (PRD F12):
 * `{answer_found, decision_ids[], answer_parts[{kind: user_reason|source_fact|inference, text, ref}]}`.
 * `ref` is a decision ID or evidence ID from the retrieved set; the server rejects anything else.
 */
export const ASK_WHY_SCHEMA_VERSION = "ask-why.v1";

export const AnswerPartKind = z.enum(["user_reason", "source_fact", "inference"]);
export type AnswerPartKind = z.infer<typeof AnswerPartKind>;

export const AskWhyOutput = z.object({
  answer_found: z.boolean(),
  decision_ids: z.array(z.string()),
  answer_parts: z.array(z.object({ kind: AnswerPartKind, text: z.string(), ref: z.string().nullable() })),
});
export type AskWhyOutput = z.infer<typeof AskWhyOutput>;
