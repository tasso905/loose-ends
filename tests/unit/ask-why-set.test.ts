import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { askWhy, NO_RECORD_MESSAGE, type AskWhyAnswer, type RetrievedDecision } from "@/lib/ai/askWhy";
import { createRecordedModel, type Recording } from "@/lib/ai/fake";
import { AskWhyOutput } from "@/lib/ai/schema";
import { judgeAskWhy, loadAskWhySet, type AskWhyQuestion } from "@/evals/ask-why/set";

/**
 * The Ask-why eval set (evals/ask-why) without any live model call:
 * 1. Format and consistency: 10 answerable + 10 unanswerable, IDs resolve, "user_reason" expectations
 *    match whether a reason was recorded, synthetic data only.
 * 2. Unanswerable: zero retrieved records → askWhy() returns the no-record message and never calls
 *    the model (rule 7). Zero rows from real Postgres full-text search is pinned in
 *    tests/integration/ask-why-retrieval.test.ts.
 * 3. Answerable "perfect model" replay through the fake provider and askWhy()'s server checks: the
 *    judge finds no fabrication and no miss, so a live-eval failure is a model or retrieval failure,
 *    not a golden error.
 * 4. The judge flags each fabrication kind.
 */

const set = loadAskWhySet();
const byId = new Map(set.decisions.map((d) => [d.id, d]));
const answerable = set.questions.flatMap((q) => (q.answerable ? [q] : []));
const unanswerable = set.questions.filter((q) => !q.answerable);

/** A model that fails the test if askWhy() ever calls it. */
const forbiddenModel = () =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error("askWhy() called the model with zero retrieved decisions");
    },
  });

/** Retrieved set for a replay: the expected decisions plus the next decision as a distractor. */
function retrievedFor(q: Extract<AskWhyQuestion, { answerable: true }>): RetrievedDecision[] {
  const ids = new Set(q.expect.decision_ids);
  const distractor = set.decisions.find((d) => !ids.has(d.id))!;
  return [...q.expect.decision_ids.map((id) => byId.get(id)!), distractor];
}

/** What a correct model returns: cite the expected decisions, their whole reasons and facts. */
function perfectResponse(q: Extract<AskWhyQuestion, { answerable: true }>) {
  const parts = q.expect.decision_ids.flatMap((id) => {
    const d = byId.get(id)!;
    return [
      ...(d.reason_user ? [{ kind: "user_reason" as const, text: d.reason_user, ref: d.id }] : []),
      ...d.context_facts.map((f) => ({ kind: "source_fact" as const, text: f.text, ref: f.evidence_id ?? d.id })),
    ];
  });
  return AskWhyOutput.parse({ answer_found: true, decision_ids: q.expect.decision_ids, answer_parts: parts });
}

describe("Ask-why eval set: format", () => {
  it("has 10 answerable and 10 unanswerable questions with unique IDs and questions", () => {
    expect(answerable).toHaveLength(10);
    expect(unanswerable).toHaveLength(10);
    expect(new Set(set.questions.map((q) => q.id)).size).toBe(20);
    expect(new Set(set.questions.map((q) => q.question.toLowerCase())).size).toBe(20);
  });

  it("decision, thread and evidence IDs are unique; every decision is dated before the questions", () => {
    const ids = set.decisions.flatMap((d) => [d.id, d.thread_id, ...d.context_facts.flatMap((f) => (f.evidence_id ? [f.evidence_id] : []))]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of set.decisions) expect(Date.parse(d.decided_at), d.id).toBeLessThan(Date.parse(set.meta.asked_at));
  });

  it("answerable expectations resolve and match whether a reason was recorded", () => {
    for (const q of answerable) {
      for (const id of q.expect.decision_ids) {
        const d = byId.get(id);
        expect(d, `${q.id} cites ${id}`).toBeDefined();
        expect(q.expect.user_reason, q.id).toBe(d!.reason_user === null ? "absent" : "required");
      }
    }
    // At least one answerable question per "no reason recorded" decision path.
    expect(answerable.filter((q) => q.expect.user_reason === "absent").length).toBeGreaterThanOrEqual(1);
  });

  it("is synthetic: reserved example domains only", () => {
    const all = JSON.stringify(set);
    for (const m of all.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) expect(m[1], m[0]).toMatch(/(^|\.)example\.(com|org|net)$/i);
  });
});

describe("Ask-why eval set: unanswerable questions (rule 7: no records, no LLM call)", () => {
  it.each(unanswerable.map((q) => [q.id, q] as const))("%s: no-record message, model never called, no fabrication", async (_id, q) => {
    const answer = await askWhy(q.question, [], { model: forbiddenModel(), logger: () => {} });
    expect(answer).toMatchObject({ answer_found: false, llm_called: false, message: NO_RECORD_MESSAGE, parts: [], decision_ids: [] });
    expect(judgeAskWhy(q, set.decisions, [], answer)).toMatchObject({ fabrications: [], misses: [] });
  });
});

describe("Ask-why eval set: answerable questions, perfect-model replay", () => {
  it.each(answerable.map((q) => [q.id, q] as const))("%s: cites the expected decision with only stored text", async (_id, q) => {
    const retrieved = retrievedFor(q);
    const recording: Recording = { name: `ask-why-${q.id}`, task: "ask_why", input: q.question, responses: [perfectResponse(q)] };
    const answer = await askWhy(q.question, retrieved, { model: createRecordedModel({ recordings: [recording] }), logger: () => {} });

    expect(answer.answer_found).toBe(true);
    expect(answer.llm_called).toBe(true);
    expect(answer.decision_ids.sort()).toEqual([...q.expect.decision_ids].sort());
    for (const id of q.expect.decision_ids) {
      const reasons = answer.parts.filter((p) => p.kind === "user_reason" && p.decision_id === id).map((p) => p.text);
      expect(reasons).toEqual(byId.get(id)!.reason_user === null ? [] : [byId.get(id)!.reason_user]);
    }
    expect(judgeAskWhy(q, set.decisions, retrieved.map((d) => d.id), answer)).toMatchObject({ fabrications: [], misses: [] });
  });
});

describe("judgeAskWhy flags fabrications", () => {
  const q = answerable.find((x) => x.expect.user_reason === "absent")!;
  const d = byId.get(q.expect.decision_ids[0]!)!;
  const base: AskWhyAnswer = {
    answer_found: true,
    decision_ids: [d.id],
    parts: [],
    message: null,
    llm_called: true,
    model: "test",
    promptVersion: "x",
    schemaVersion: "x",
    inputTokens: null,
    outputTokens: null,
    latencyMs: 0,
  };

  it("an answer to an unanswerable question, and a model call with zero records", () => {
    const u = unanswerable[0]!;
    expect(judgeAskWhy(u, set.decisions, [], base).fabrications).toEqual(expect.arrayContaining(["answered_unanswerable", "llm_called_on_zero_match", "cited_outside_retrieved"]));
  });

  it("a 'You wrote' part for a decision with no recorded reason, and a paraphrased fact", () => {
    const answer: AskWhyAnswer = {
      ...base,
      parts: [
        { kind: "user_reason", text: "It was cheaper.", decision_id: d.id, evidence_id: null },
        { kind: "source_fact", text: "Premium about $38", decision_id: d.id, evidence_id: null },
      ],
    };
    expect(judgeAskWhy(q, set.decisions, [d.id], answer).fabrications).toEqual(expect.arrayContaining(["reason_not_stored", "fact_not_stored"]));
  });

  it("a no-record answer whose message is not the exact no-record copy", () => {
    const u = unanswerable[0]!;
    const answer: AskWhyAnswer = { ...base, answer_found: false, decision_ids: [], llm_called: false, message: "Probably because it was cheaper." };
    expect(judgeAskWhy(u, set.decisions, [], answer).fabrications).toContain("answered_unanswerable");
  });
});
