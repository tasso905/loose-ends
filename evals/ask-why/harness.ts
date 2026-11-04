/**
 * Ask-why eval runner (PRD F12 and Testing Strategy: 10 answerable + 10 unanswerable questions,
 * gate 0 fabrications). Wired into `pnpm eval` by evals/run.ts; data and judge: ./set.ts, README.md.
 *
 * For each question: retrieve with the real F12 query (public.search_decisions over a seeded copy
 * of decisions.json, see ./retrieve.ts), call askWhy() with the retrieved records, judge the answer.
 * The report is content-free (rule 9): question IDs, counts and enums only.
 *
 * Pass: 0 fabrications and no failed calls. Failures that are all provider quota make the run
 * "incomplete_quota" (not judged), as for extraction (D43). A question whose final failure is
 * `unavailable` is tried again in later rounds and the extra attempts are reported, as for
 * extraction (../harness.ts retryUnavailable).
 */
import type { LanguageModel } from "ai";
import { askWhy, type RetrievedDecision } from "@/lib/ai/askWhy";
import { AskWhyFailedError, type AiFailureKind } from "@/lib/ai/errors";
import { ASK_WHY_PROMPT_VERSION, promptSha } from "@/lib/ai/prompts";
import { ASK_WHY_SCHEMA_VERSION } from "@/lib/ai/schema";
import { NO_THROTTLE, retryUnavailable, throttledModel, type EvalResult, type Throttle, type UnavailableRetry, type UnavailableRetrySummary } from "../harness";
import { judgeAskWhy, type AskWhyCaseResult, type AskWhySet, type Fabrication, type Miss } from "./set";

export type Retriever = (question: string) => Promise<RetrievedDecision[]>;

export interface AskWhyCaseReport extends AskWhyCaseResult {
  /** Failure kind when askWhy() threw (no answer to judge). */
  failure: AiFailureKind | null;
  /** Extra attempts after `unavailable`, beyond the first. */
  extra_attempts: number;
}

type Outcome = { result: AskWhyCaseResult; failure: AiFailureKind | null };

export interface AskWhyEvalReport {
  model: string;
  prompt_version: string;
  /** First 12 hex of sha256 over the prompt file (lib/ai/prompts.ts promptSha). */
  prompt_sha256: string;
  schema_version: string;
  questions: number;
  answerable: number;
  /** Questions with at least one fabrication; the gate is 0. */
  fabrications: number;
  fabrications_by_kind: Partial<Record<Fabrication, number>>;
  misses_by_kind: Partial<Record<Miss, number>>;
  /** Answerable questions with no miss and no fabrication ÷ answerable questions (not gated). */
  answerable_hit_rate: number | null;
  /** Model calls made, one per attempt (unanswerable questions must make none). */
  llm_calls: number;
  failures: number;
  failures_by_kind: Partial<Record<AiFailureKind, number>>;
  /** Extra attempts made because the provider was unavailable; always reported. */
  unavailable_retries: Omit<UnavailableRetrySummary, "perCase">;
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
  /** Off when omitted; `pnpm eval` passes DEFAULT_UNAVAILABLE_RETRY. */
  unavailableRetry?: UnavailableRetry;
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

  // Retrieve once per question; only the model call is tried again. Nothing is tallied until the
  // retries are over, so a retried attempt leaves no trace in the judgement.
  const cases: { q: AskWhySet["questions"][number]; retrieved: RetrievedDecision[] }[] = [];
  for (const q of opts.set.questions) cases.push({ q, retrieved: await opts.retrieve(q.question) });

  const attempt = async ({ q, retrieved }: (typeof cases)[number]): Promise<Outcome> => {
    const ids = retrieved.map((d) => d.id);
    try {
      const answer = await askWhy(q.question, retrieved, { model, modelLabel: opts.modelLabel, logger: () => {} });
      if (answer.llm_called) llmCalls++;
      return { result: judgeAskWhy(q, opts.set.decisions, ids, answer), failure: null };
    } catch (err) {
      llmCalls++;
      const failure: AiFailureKind = err instanceof AskWhyFailedError ? err.kind : "unknown";
      return { result: { id: q.id, answerable: q.answerable, retrieved: ids.length, llm_called: true, answer_found: false, fabrications: [], misses: [] }, failure };
    }
  };

  const outcomes: Outcome[] = [];
  for (const c of cases) outcomes.push(await attempt(c));
  const retried = await retryUnavailable(outcomes, (o) => o.failure === "unavailable", (i) => attempt(cases[i]!), opts.unavailableRetry);

  for (const [i, { result, failure }] of outcomes.entries()) {
    for (const f of result.fabrications) bump(fabricationsByKind, f);
    for (const m of result.misses) bump(missesByKind, m);
    if (failure) bump(failuresByKind, failure);
    perQuestion.push({ ...result, failure, extra_attempts: retried.perCase[i]! });
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
    prompt_sha256: promptSha(ASK_WHY_PROMPT_VERSION),
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
    unavailable_retries: { rounds: retried.rounds, extra_attempts: retried.extra_attempts, retried: retried.retried, still_unavailable: retried.still_unavailable },
    result,
    pass: result === "pass",
    perQuestion,
  };
}
