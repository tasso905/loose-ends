import type { LanguageModel } from "ai";
import { z } from "zod";
import { askWhy, NO_RECORD_MESSAGE, type AskWhyAnswer, type RetrievedDecision } from "@/lib/ai/askWhy";
import { apiError, type ApiError } from "@/lib/errors";
import type { RpcDb } from "@/lib/extraction/service";
import { log as defaultLog, type Logger } from "@/lib/log";
import { consumeUsage, DAILY_LIMITS, RATE_LIMIT_TIMEZONE } from "@/lib/rateLimit";
import type { AnswerPartKind } from "@/lib/ai/schema";
import type { AnswerDecision, AskView } from "./view";

export { ASK_MAX, AskInput, type AnswerDecision, type AskView } from "./view";

/**
 * F12 Ask why, server side (PRD F12 and "Decision Memory", SITE_CONTRACT §2.11, rule 7, D33, D54).
 *
 * 1. Counts one ask (consume_usage('ask'), 50 per UTC day) before anything else; over the limit,
 *    or if the counter cannot be read, the answer is `rate_limited` and nothing is retrieved.
 * 2. Retrieves the caller's top 5 decisions (public.search_decisions, RLS applies; lexemes OR'd).
 * 3. askWhy() answers only from those: zero retrieved means NO_RECORD_MESSAGE with no model call;
 *    IDs outside the retrieved set are dropped; user_reason / source_fact parts carry the whole
 *    stored text (D33).
 * 4. The view is built from stored fields only: for each cited decision, its choice and date, its
 *    whole stored reason (or the no-reason state), the stored facts the answer cited, and any
 *    Interpretation the model wrote, always labelled. Any failure is `ask_failed` (D54), whatever
 *    its kind, including provider quota; nothing partial is returned (rule 10).
 */

export type AskResult = { ok: true; view: AskView; counts: Partial<Record<AnswerPartKind, number>> } | { ok: false; error: ApiError };

export interface AskDeps {
  model?: LanguageModel;
  modelLabel?: string;
  logger?: Logger;
}

const Fact = z.object({ text: z.string(), evidence_id: z.string().nullable() });
const Retrieved = z.array(
  z.object({
    id: z.string(),
    thread_id: z.string(),
    thread_title: z.string(),
    counterparty: z.string().nullable(),
    choice: z.string(),
    reason_user: z.string().nullable(),
    decided_at: z.string(),
    context_facts: z.array(Fact),
  }),
);

export async function retrieveDecisions(db: RpcDb, question: string): Promise<RetrievedDecision[] | null> {
  try {
    const { data, error } = await db.rpc("search_decisions", { p_question: question });
    if (error) return null;
    const parsed = Retrieved.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const NO_RECORD: AskView = { found: false, message: NO_RECORD_MESSAGE, decisions: [], interpretations: [] };

/** Builds what the page shows from askWhy()'s answer and the retrieved records (stored text only). */
export function answerView(answer: AskWhyAnswer, retrieved: RetrievedDecision[]): AskView {
  if (!answer.answer_found) return NO_RECORD;
  const byId = new Map(retrieved.map((d) => [d.id, d]));
  const loose: string[] = [];
  const out = new Map<string, AnswerDecision>();
  for (const id of answer.decision_ids) {
    const d = byId.get(id);
    if (!d) continue; // askWhy() already drops these; never show a record that was not retrieved (rule 7)
    out.set(id, {
      id: d.id,
      thread_id: d.thread_id,
      thread_title: d.thread_title,
      choice: d.choice,
      decided_at: d.decided_at,
      reason_user: d.reason_user !== null && d.reason_user.trim().length > 0 ? d.reason_user : null,
      facts: [],
      interpretations: [],
    });
  }
  for (const p of answer.parts) {
    const target = p.decision_id ? out.get(p.decision_id) : undefined;
    if (p.kind === "source_fact") {
      if (target && byId.get(target.id)!.context_facts.some((f) => f.text === p.text) && !target.facts.includes(p.text)) target.facts.push(p.text);
    } else if (p.kind === "inference") {
      if (target) {
        if (!target.interpretations.includes(p.text)) target.interpretations.push(p.text);
      } else if (p.decision_id === null && !loose.includes(p.text)) loose.push(p.text);
    }
    // user_reason: the whole stored reason is shown for every cited decision that has one.
  }
  if (out.size === 0) return NO_RECORD;
  return { found: true, message: null, decisions: [...out.values()], interpretations: loose };
}

function countParts(v: AskView): Partial<Record<AnswerPartKind, number>> {
  if (!v.found) return {};
  return {
    user_reason: v.decisions.filter((d) => d.reason_user !== null).length,
    source_fact: v.decisions.reduce((n, d) => n + d.facts.length, 0),
    inference: v.decisions.reduce((n, d) => n + d.interpretations.length, 0) + v.interpretations.length,
  };
}

export async function askQuestion(db: RpcDb, question: string, deps: AskDeps = {}): Promise<AskResult> {
  const logger = deps.logger ?? defaultLog;
  if (!(await consumeUsage(db, "ask"))) {
    return { ok: false, error: apiError("rate_limited", { limit: DAILY_LIMITS.ask, kind: "questions", timezone: RATE_LIMIT_TIMEZONE }) };
  }

  const retrieved = await retrieveDecisions(db, question);
  if (retrieved === null) {
    logger("ask_failed", { step: "retrieve" });
    return { ok: false, error: apiError("ask_failed") };
  }

  let answer: AskWhyAnswer;
  try {
    answer = await askWhy(question, retrieved, { model: deps.model, modelLabel: deps.modelLabel, logger });
  } catch {
    // askWhy() has already logged the failure kind (rule 9: no content); every kind is ask_failed (D54).
    logger("ask_failed", { step: "answer", retrieved: retrieved.length });
    return { ok: false, error: apiError("ask_failed") };
  }
  const view = answerView(answer, retrieved);
  return { ok: true, view, counts: countParts(view) };
}
