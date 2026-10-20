import { jsonSchema, zodSchema, type JSONSchema7, type Schema } from "ai";
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

/**
 * Length and count constraints are stripped from the JSON schema sent to the model. Gemini (D42)
 * refuses the extraction schema with HTTP 400 when it carries `minLength`/`maxLength`/`minItems`/
 * `maxItems` (each bound multiplies the constrained-decoding state space). The limits are not
 * weakened: the model still gets them as prompt instructions, and every response is validated
 * against the full Zod schema above, which rejects anything out of bounds (→ retry, then
 * `extraction_failed`). Only constraint keywords are removed; structure, enums, required fields
 * and `additionalProperties: false` are sent unchanged.
 */
export const MODEL_SCHEMA_STRIPPED_KEYWORDS = ["minLength", "maxLength", "minItems", "maxItems"] as const;

type Json = JSONSchema7 | JSONSchema7[] | boolean | undefined;

function stripConstraints<T extends Json>(node: T): T {
  if (Array.isArray(node)) return node.map(stripConstraints) as T;
  if (node === undefined || typeof node === "boolean") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if ((MODEL_SCHEMA_STRIPPED_KEYWORDS as readonly string[]).includes(k)) continue;
    if (k === "properties" || k === "$defs" || k === "definitions") {
      // Keys here are property names, not keywords: keep every key, recurse into each value.
      out[k] = Object.fromEntries(Object.entries(v as Record<string, JSONSchema7>).map(([n, d]) => [n, stripConstraints(d)]));
    } else if (k === "items" || k === "additionalProperties" || k === "anyOf" || k === "oneOf" || k === "allOf" || k === "not") {
      out[k] = stripConstraints(v as Json);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** The schema passed to `generateObject`: constraint-free JSON schema for the model, full Zod validation. */
export function modelSchema<T>(schema: z.ZodType<T>): Schema<T> {
  const zod = zodSchema(schema);
  return jsonSchema<T>(async () => stripConstraints(await zod.jsonSchema), { validate: (value) => zod.validate!(value) });
}

export const ExtractionModelSchema = modelSchema(Extraction);
export const AskWhyModelSchema = modelSchema(AskWhyOutput);
