/**
 * Ask-why eval runner (PRD F12 and Testing Strategy: 10 answerable + 10 unanswerable questions,
 * gate 0 fabrications). Wired into `pnpm eval` by evals/run.ts; data and judge: ./set.ts, README.md.
 *
 * For each question: retrieve with the real F12 query (public.search_decisions over a seeded copy
 * of decisions.json, see ./retrieve.ts), call askWhy() with the retrieved records, judge the answer.
 * The report is content-free (rule 9): question IDs, counts and enums only.
 *
 * Pass: 0 fabrications and no failed calls. Failures that are all provider quota make the run
 * "incomplete_quota" (not judged), as for extraction (D43).
 */
import type { LanguageModel } from "ai";
import { askWhy, type RetrievedDecision } from "@/lib/ai/askWhy";
import { AskWhyFailedError, type AiFailureKind } from "@/lib/ai/errors";
import { ASK_WHY_PROMPT_VERSION } from "@/lib/ai/prompts";
import { ASK_WHY_SCHEMA_VERSION } from "@/lib/ai/schema";
import { NO_THROTTLE, throttledModel, type EvalResult, type Throttle } from "../harness";
import { judgeAskWhy, type AskWhyCaseResult, type AskWhySet, type Fabrication, type Miss } from "./set";

export type Retriever = (question: string) => Promise<RetrievedDecision[]>;

export interface AskWhyCaseReport extends AskWhyCaseResult {
  /** Failure kind when askWhy() threw (no answer to judge). */
  failure: AiFailureKind | null;
}

export interface AskWhyEvalReport {
  model: string;
  prompt_version: string;
  schema_version: string;
  questions: number;
  answerable: number;
  /** Questions with at least one fabrication; the gate is 0. */
  fabrications: number;
  fabrications_by_kind: Partial<Record<Fabrication, number>>;
  misses_by_kind: Partial<Record<Miss, number>>;
  /** Answerable questions with no miss and no fabrication ÷ answerable questions (not gated). */
  answerable_hit_rate: number | null;
  /** Model calls made (unanswerable questions must make none). */
  llm_calls: number;
  failures: number;
  failures_by_kind: Partial<Record<AiFailureKind, number>>;
  result: EvalResult;
  pass: boolean;
  perQuestion: AskWhyCaseReport[];
}

export interface RunAskWhyEvalOptions {
  set: AskWhySet;
  retrieve: Retriever;
  model: LanguageModel;
  modelLabel: string;
  throttle?: Throttle;
}

const bump = <K extends string>(m: Partial<Record<K, number>>, k: K) => {
  m[k] = (m[k] ?? 0) + 1;
};

export async function runAskWhyEval(opts: RunAskWhyEvalOptions): Promise<AskWhyEvalReport> {
  const model = throttledModel(opts.model, opts.throttle ?? NO_THROTTLE);
  const perQuestion: AskWhyCaseReport[] = [];
  const fabricationsByKind: Partial<Record<Fabrication, number>> = {};
  const missesByKind: Partial<Record<Miss, number>> = {};
  const failuresByKind: Partial<Record<AiFailureKind, number>> = {};
  let llmCalls = 0;

  for (const q of opts.set.questions) {
    const retrieved = await opts.retrieve(q.question);
    const ids = retrieved.map((d) => d.id);
    try {
      const answer = await askWhy(q.question, retrieved, { model, modelLabel: opts.modelLabel, logger: () => {} });
      if (answer.llm_called) llmCalls++;
      const r = judgeAskWhy(q, opts.set.decisions, ids, answer);
      for (const f of r.fabrications) bump(fabricationsByKind, f);
      for (const m of r.misses) bump(missesByKind, m);
      perQuestion.push({ ...r, failure: null });
    } catch (err) {
      llmCalls++;
      const kind: AiFailureKind = err instanceof AskWhyFailedError ? err.kind : "unknown";
      bump(failuresByKind, kind);
      perQuestion.push({ id: q.id, answerable: q.answerable, retrieved: ids.length, llm_called: true, answer_found: false, fabrications: [], misses: [], failure: kind });
    }
  }

  const fabrications = perQuestion.filter((r) => r.fabrications.length > 0).length;
  const answerable = perQuestion.filter((r) => r.answerable);
  const hits = answerable.filter((r) => r.failure === null && r.misses.length === 0 && r.fabrications.length === 0).length;
  const failures = perQuestion.filter((r) => r.failure !== null).length;
  const result: EvalResult =
    fabrications > 0 ? "fail" : failures === 0 ? "pass" : failuresByKind.quota === failures ? "incomplete_quota" : "fail";

  return {
    model: opts.modelLabel,
    prompt_version: ASK_WHY_PROMPT_VERSION,
    schema_version: ASK_WHY_SCHEMA_VERSION,
    questions: perQuestion.length,
    answerable: answerable.length,
    fabrications,
    fabrications_by_kind: fabricationsByKind,
    misses_by_kind: missesByKind,
    answerable_hit_rate: answerable.length ? hits / answerable.length : null,
    llm_calls: llmCalls,
    failures,
    failures_by_kind: failuresByKind,
    result,
    pass: result === "pass",
    perQuestion,
  };
}
