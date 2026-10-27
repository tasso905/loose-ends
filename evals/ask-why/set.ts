/**
 * Ask-why eval set (PRD F12 and Testing Strategy: 10 answerable + 10 unanswerable questions, 0
 * fabrications). Data: decisions.json and questions.json in this folder; format: README.md.
 *
 * This module only loads and validates the set and judges one answer. It reads no env, resolves no
 * provider and makes no call; the runner that retrieves and calls askWhy() is built with F12 (S9).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { NO_RECORD_MESSAGE, type AskWhyAnswer, type RetrievedDecision } from "@/lib/ai/askWhy";

export const ASK_WHY_SET_DIR = join(process.cwd(), "evals", "ask-why");

const Uuid = z.string().uuid();

export const SetDecision = z
  .object({
    id: Uuid,
    thread_id: Uuid,
    thread_title: z.string().min(1),
    counterparty: z.string().min(1).nullable(),
    choice: z.string().min(1),
    reason_user: z.string().min(1).nullable(),
    decided_at: z.string().datetime(),
    context_facts: z.array(z.object({ text: z.string().min(1), evidence_id: Uuid.nullable() }).strict()),
  })
  .strict();

export const DecisionSet = z
  .object({
    description: z.string(),
    user: z.object({ display_name: z.string(), aliases: z.array(z.string()) }).strict(),
    timezone: z.string(),
    /** When the questions are asked; every decided_at is before it. */
    asked_at: z.string().datetime(),
    decisions: z.array(SetDecision).min(1),
  })
  .strict();

const Answerable = z
  .object({
    id: z.string().regex(/^a\d{2}$/),
    question: z.string().min(5).max(500),
    answerable: z.literal(true),
    expect: z
      .object({
        /** Decisions the answer must cite (and retrieval must return in its top 5). */
        decision_ids: z.array(Uuid).min(1),
        /** "required": a user_reason part with the whole stored reason. "absent": no reason was recorded, so no user_reason part. */
        user_reason: z.enum(["required", "absent"]),
      })
      .strict(),
    note: z.string().optional(),
  })
  .strict();

const Unanswerable = z
  .object({
    id: z.string().regex(/^u\d{2}$/),
    question: z.string().min(5).max(500),
    answerable: z.literal(false),
    note: z.string().optional(),
  })
  .strict();

export const AskWhyQuestion = z.discriminatedUnion("answerable", [Answerable, Unanswerable]);
export type AskWhyQuestion = z.infer<typeof AskWhyQuestion>;

export const QuestionSet = z.object({ description: z.string(), questions: z.array(AskWhyQuestion) }).strict();

export interface AskWhySet {
  decisions: RetrievedDecision[];
  meta: Omit<z.infer<typeof DecisionSet>, "decisions">;
  questions: AskWhyQuestion[];
}

export function loadAskWhySet(dir = ASK_WHY_SET_DIR): AskWhySet {
  const d = DecisionSet.parse(JSON.parse(readFileSync(join(dir, "decisions.json"), "utf8")));
  const q = QuestionSet.parse(JSON.parse(readFileSync(join(dir, "questions.json"), "utf8")));
  const { decisions, ...meta } = d;
  return { decisions, meta, questions: q.questions };
}

/**
 * Fabrication kinds. Any one makes the case a fabrication (gate: 0).
 * - answered_unanswerable: answer_found on a question with no recorded decision.
 * - llm_called_on_zero_match: retrieval returned nothing but the model was called (rule 7).
 * - cited_outside_retrieved: a cited decision was not in the retrieved set.
 * - reason_not_stored: a "You wrote" part whose text is not its decision's whole stored reason
 *   (or whose decision has no reason).
 * - fact_not_stored: a "From the source" part whose text is not one of its decision's stored facts.
 */
export type Fabrication = "answered_unanswerable" | "llm_called_on_zero_match" | "cited_outside_retrieved" | "reason_not_stored" | "fact_not_stored";

/** Non-fabrication misses, reported but not the 0-fabrication gate. */
export type Miss =
  | "retrieved_for_unanswerable" // retrieval returned rows for an unanswerable question (set or retrieval problem)
  | "expected_not_retrieved" // an expected decision was not in the top 5
  | "not_answered" // answerable question answered with the no-record message
  | "expected_not_cited"
  | "reason_missing"; // a reason was recorded but no "You wrote" part was given

export interface AskWhyCaseResult {
  id: string;
  answerable: boolean;
  retrieved: number;
  llm_called: boolean;
  answer_found: boolean;
  fabrications: Fabrication[];
  misses: Miss[];
}

/**
 * Judges one answer. `retrievedIds` is what retrieval returned (in order); `answer` is askWhy()'s
 * result for the decisions with those IDs. Content-free result (rule 9): IDs and enums only.
 */
export function judgeAskWhy(q: AskWhyQuestion, decisions: RetrievedDecision[], retrievedIds: string[], answer: AskWhyAnswer): AskWhyCaseResult {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const retrieved = new Set(retrievedIds);
  const fabrications = new Set<Fabrication>();
  const misses = new Set<Miss>();

  if (retrievedIds.length === 0 && answer.llm_called) fabrications.add("llm_called_on_zero_match");
  if (answer.answer_found && !q.answerable) fabrications.add("answered_unanswerable");
  if (!answer.answer_found && answer.message !== NO_RECORD_MESSAGE) fabrications.add("answered_unanswerable");
  for (const id of answer.decision_ids) if (!retrieved.has(id)) fabrications.add("cited_outside_retrieved");
  for (const p of answer.parts) {
    if (p.decision_id !== null && !retrieved.has(p.decision_id)) fabrications.add("cited_outside_retrieved");
    const d = p.decision_id ? byId.get(p.decision_id) : undefined;
    if (p.kind === "user_reason" && (!d || d.reason_user === null || p.text !== d.reason_user)) fabrications.add("reason_not_stored");
    if (p.kind === "source_fact" && (!d || !d.context_facts.some((f) => f.text === p.text))) fabrications.add("fact_not_stored");
  }

  if (!q.answerable) {
    if (retrievedIds.length > 0) misses.add("retrieved_for_unanswerable");
  } else {
    const top5 = new Set(retrievedIds.slice(0, 5));
    if (q.expect.decision_ids.some((id) => !top5.has(id))) misses.add("expected_not_retrieved");
    if (!answer.answer_found) misses.add("not_answered");
    if (q.expect.decision_ids.some((id) => !answer.decision_ids.includes(id))) misses.add("expected_not_cited");
    if (q.expect.user_reason === "required") {
      const ok = q.expect.decision_ids.every((id) => answer.parts.some((p) => p.kind === "user_reason" && p.decision_id === id));
      if (!ok) misses.add("reason_missing");
    }
  }

  return {
    id: q.id,
    answerable: q.answerable,
    retrieved: retrievedIds.length,
    llm_called: answer.llm_called,
    answer_found: answer.answer_found,
    fabrications: [...fabrications],
    misses: [...misses],
  };
}
