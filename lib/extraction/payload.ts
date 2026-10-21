import { z } from "zod";
import { Item } from "@/lib/ai/schema";
import type { Proposal } from "@/lib/pipeline/proposals";
import { Band, DueCertainty } from "@/lib/schemas";

/**
 * A11: `extraction_items.payload` is a versioned object holding everything the Review Tray needs,
 * computed once by the pipeline, so the tray renders from stored fields and never recomputes
 * (rule 6: no LLM and no re-scoring at view time).
 *
 * v1 = the model item after field verification (its own unverified quote copies removed), the
 * verified evidence with source offsets, the chrono-resolved date, the scoring signals and score,
 * the confidence label (null for Ignore, which is never shown) and the "Not sure about" lines.
 *
 * `evidence` stays a top-level array of objects with `quote`: forget_thread() reads quotes from
 * `payload -> 'evidence'` to scrub the Explain card (D35).
 */
export const PROPOSAL_PAYLOAD_VERSION = 1 as const;

export const PayloadEvidence = z.object({
  quote: z.string().min(1),
  speaker: z.string().nullable(),
  start_offset: z.number().int().nonnegative(),
  end_offset: z.number().int().nonnegative(),
  page: z.number().int().nullable(),
  match_kind: z.enum(["exact", "fuzzy"]),
  similarity: z.number().min(0).max(1),
  quote_hash: z.string(),
});

export const PayloadDate = z.object({
  due_at: z.string().nullable(),
  due_date: z.string().nullable(),
  due_time_known: z.boolean(),
  due_certainty: DueCertainty,
  agreement: z.enum(["agree", "disagree", "chrono_only", "model_only", "unanchored", "none"]),
  not_sure: z.array(z.string()),
  reasoning: z.string().nullable(),
});

export const ProposalPayloadV1 = z.object({
  v: z.literal(PROPOSAL_PAYLOAD_VERSION),
  item: Item.omit({ evidence: true }),
  evidence: z.array(PayloadEvidence).min(1),
  date: PayloadDate,
  score: z.number().min(0).max(1),
  band: Band,
  signals: z.array(z.string()),
  label: z.object({ word: z.string(), reason: z.string() }).nullable(),
  not_sure: z.array(z.string()),
});
export type ProposalPayloadV1 = z.infer<typeof ProposalPayloadV1>;

/** The one payload version written today; readers parse with this. */
export const ProposalPayload = ProposalPayloadV1;
export type ProposalPayload = ProposalPayloadV1;

export function toPayload(p: Proposal): ProposalPayloadV1 {
  const { evidence: _modelQuotes, ...item } = p.item;
  void _modelQuotes;
  return {
    v: PROPOSAL_PAYLOAD_VERSION,
    item,
    evidence: p.evidence.map((e) => ({
      quote: e.quote,
      speaker: e.speaker,
      start_offset: e.start_offset,
      end_offset: e.end_offset,
      page: e.page,
      match_kind: e.match_kind,
      similarity: e.similarity,
      quote_hash: e.quote_hash,
    })),
    date: {
      due_at: p.date.due_at,
      due_date: p.date.due_date,
      due_time_known: p.date.due_time_known,
      due_certainty: p.date.due_certainty,
      agreement: p.date.agreement,
      not_sure: p.date.not_sure,
      reasoning: p.date.reasoning,
    },
    score: p.score,
    band: p.band,
    signals: p.signals,
    label: p.label,
    not_sure: p.not_sure,
  };
}
