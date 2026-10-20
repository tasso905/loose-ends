import { generateObject, type LanguageModel } from "ai";
import { log as defaultLog, type Logger } from "@/lib/log";
import { normalizeText } from "@/lib/pipeline/normalize";
import { AskWhyFailedError, classifyAiError } from "./errors";
import { ASK_WHY_SCHEMA_VERSION, AskWhyModelSchema, type AnswerPartKind } from "./schema";
import { ASK_WHY_PROMPT_VERSION, block, loadPrompt } from "./prompts";
import { getModel } from "./provider";

/**
 * F12 Ask why (rule 7). Answers only from the decisions retrieval returned:
 *  - zero retrieved decisions → NO_RECORD_MESSAGE with no LLM call;
 *  - decision/evidence IDs outside the retrieved set are rejected;
 *  - `user_reason` and `source_fact` parts must cite a retrieved record; the model's text for them
 *    is ignored and the server shows the cited record's stored text (the whole `reason_user`, or
 *    the whole stored fact), so nothing but stored text is ever shown as the user's or the source's;
 *  - `inference` parts keep the model's text and are always labeled Interpretation.
 * If no retrieved decision is cited after filtering, the answer is NO_RECORD_MESSAGE.
 * A failed model call is retried once only when classifyAiError() marks it retryable (D43 parity
 * with extract(); SDK retries are off), then throws AskWhyFailedError, which carries only the
 * failure kind (rule 9).
 */

export const NO_RECORD_MESSAGE = "I don't have a recorded decision about that.";

export interface RetrievedDecision {
  id: string;
  thread_id: string;
  thread_title: string;
  counterparty: string | null;
  choice: string;
  reason_user: string | null;
  decided_at: string;
  context_facts: Array<{ text: string; evidence_id: string | null }>;
}

export interface AnswerPart {
  kind: AnswerPartKind;
  text: string;
  decision_id: string | null;
  evidence_id: string | null;
}

export interface AskWhyAnswer {
  answer_found: boolean;
  decision_ids: string[];
  parts: AnswerPart[];
  /** NO_RECORD_MESSAGE when answer_found is false. */
  message: string | null;
  llm_called: boolean;
  model: string | null;
  promptVersion: string;
  schemaVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export interface AskWhyDeps {
  model?: LanguageModel;
  modelLabel?: string;
  logger?: Logger;
}

const base = {
  promptVersion: ASK_WHY_PROMPT_VERSION,
  schemaVersion: ASK_WHY_SCHEMA_VERSION,
};

function noRecord(llmCalled: boolean, model: string | null, latencyMs: number, tokens: [number | null, number | null] = [null, null]): AskWhyAnswer {
  return {
    ...base,
    answer_found: false,
    decision_ids: [],
    parts: [],
    message: NO_RECORD_MESSAGE,
    llm_called: llmCalled,
    model,
    inputTokens: tokens[0],
    outputTokens: tokens[1],
    latencyMs,
  };
}

/**
 * The fact a decision-level `source_fact` ref stands for: the decision's only fact, or its only
 * fact without an evidence ID (the prompt cites the decision for those). Otherwise ambiguous.
 */
function singleFact(d: RetrievedDecision): string | null {
  if (d.context_facts.length === 1) return d.context_facts[0]!.text;
  const unreferenced = d.context_facts.filter((f) => !f.evidence_id);
  return unreferenced.length === 1 ? unreferenced[0]!.text : null;
}

export function buildAskWhyPrompt(question: string, decisions: RetrievedDecision[]): string {
  const records = decisions.map((d) => ({
    id: d.id,
    thread_title: d.thread_title,
    counterparty: d.counterparty,
    choice: d.choice,
    reason_user: d.reason_user,
    decided_at: d.decided_at,
    context_facts: d.context_facts,
  }));
  return `${block("decisions", JSON.stringify(records, null, 2))}\n\n${block("question", question)}`;
}

export async function askWhy(question: string, decisions: RetrievedDecision[], deps: AskWhyDeps = {}): Promise<AskWhyAnswer> {
  if (decisions.length === 0) return noRecord(false, null, 0);

  const resolved = deps.model ? null : getModel();
  const model = deps.model ?? resolved!.model;
  const label = deps.modelLabel ?? resolved?.label ?? "injected";
  const logger = deps.logger ?? defaultLog;

  const started = performance.now();
  // D43 parity with extract(): no SDK-level retries; one retry only when classifyAiError says
  // another attempt can help (never on quota, safety, rejected or config).
  let result: Awaited<ReturnType<typeof generateObject<typeof AskWhyModelSchema>>> | undefined;
  for (let attempt = 1; result === undefined; attempt++) {
    try {
      result = await generateObject({
        model,
        schema: AskWhyModelSchema,
        system: loadPrompt(ASK_WHY_PROMPT_VERSION),
        prompt: buildAskWhyPrompt(question, decisions),
        temperature: 0,
        maxRetries: 0,
      });
    } catch (err) {
      // Provider errors carry the request body (question + decisions); keep only the classification.
      const f = classifyAiError(err);
      const error = err instanceof Error ? err.name : "non_error_thrown";
      if (f.retryable && attempt < 2) {
        logger("ask_why_retry", { kind: f.kind, status: f.status, error });
        continue;
      }
      const latencyMs = Math.round(performance.now() - started);
      logger("ask_why_failed", { kind: f.kind, status: f.status, error, attempts: attempt, latency_ms: latencyMs });
      throw new AskWhyFailedError(f, latencyMs);
    }
  }
  const latencyMs = Math.round(performance.now() - started);
  const tokens: [number | null, number | null] = [result.usage.inputTokens ?? null, result.usage.outputTokens ?? null];

  const byId = new Map(decisions.map((d) => [d.id, d]));
  const evidenceOwner = new Map<string, string>();
  const factByEvidence = new Map<string, string>();
  for (const d of decisions)
    for (const f of d.context_facts)
      if (f.evidence_id) {
        evidenceOwner.set(f.evidence_id, d.id);
        factByEvidence.set(f.evidence_id, f.text);
      }

  const out = result.object;
  if (!out.answer_found) return noRecord(true, label, latencyMs, tokens);

  const rejected = (reason: string) => logger("ask_why_ref_rejected", { reason });

  const decisionIds = out.decision_ids.filter((id) => {
    if (byId.has(id)) return true;
    rejected("decision_id_not_retrieved");
    return false;
  });

  const parts: AnswerPart[] = [];
  const seen = new Set<string>();
  for (const p of out.answer_parts) {
    let decisionId: string | null = null;
    let evidenceId: string | null = null;
    if (p.ref !== null) {
      if (byId.has(p.ref)) decisionId = p.ref;
      else if (evidenceOwner.has(p.ref)) {
        evidenceId = p.ref;
        decisionId = evidenceOwner.get(p.ref)!;
      } else {
        rejected("ref_not_retrieved");
        continue;
      }
    }
    if (p.kind !== "inference" && decisionId === null) {
      rejected("uncited_part");
      continue;
    }

    // user_reason and source_fact: the model's text is ignored; the server shows the stored text
    // of the cited record (rule 7: only stored text is ever shown as "You wrote" / "From the source").
    let text: string;
    if (p.kind === "user_reason") {
      const reason = byId.get(decisionId!)!.reason_user;
      if (!reason || normalizeText(reason).length === 0) {
        rejected("no_recorded_reason");
        continue;
      }
      text = reason;
    } else if (p.kind === "source_fact") {
      const fact = evidenceId ? factByEvidence.get(evidenceId)! : singleFact(byId.get(decisionId!)!);
      if (fact === null) {
        rejected("source_fact_ref_ambiguous");
        continue;
      }
      text = fact;
    } else {
      if (normalizeText(p.text).length === 0) {
        rejected("empty_part");
        continue;
      }
      text = p.text; // Interpretation: model text, always labeled.
    }

    const key = `${p.kind}|${decisionId}|${evidenceId}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push({ kind: p.kind, text, decision_id: decisionId, evidence_id: evidenceId });
  }

  const cited = new Set([...decisionIds, ...parts.flatMap((p) => (p.decision_id ? [p.decision_id] : []))]);
  // The decision record itself (choice + date) is shown from stored fields, so a cited decision with
  // no reason recorded is still an answer; the UI shows the no-recorded-reason state.
  if (cited.size === 0) return noRecord(true, label, latencyMs, tokens);

  return {
    ...base,
    answer_found: true,
    decision_ids: [...cited],
    parts,
    message: null,
    llm_called: true,
    model: label,
    inputTokens: tokens[0],
    outputTokens: tokens[1],
    latencyMs,
  };
}
