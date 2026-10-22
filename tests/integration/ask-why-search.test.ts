import type { PGlite } from "@electric-sql/pglite";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runAskWhyEval } from "@/evals/ask-why/harness";
import { EVAL_USER, seedAskWhySet } from "@/evals/ask-why/retrieve";
import { loadAskWhySet } from "@/evals/ask-why/set";
import { renderScorecard, type EvalReport } from "@/evals/harness";
import { NO_RECORD_MESSAGE } from "@/lib/ai/askWhy";
import { createRecordedModel } from "@/lib/ai/fake";
import { askQuestion, retrieveDecisions } from "@/lib/decisions/ask";
import { migratedDb, rpcAs } from "./pglite";

/**
 * S9 F12 Ask why against the real migrations (PGlite): public.search_decisions (retrieval, OR'd
 * lexemes, RLS), askQuestion() (usage limit, no model call on zero matches, ask_failed, stored text
 * only) and the Ask-why eval runner with recorded answers.
 */

const set = loadAskWhySet();
const OTHER = "e7a10000-0000-4000-8000-0000000000ff";
let db: PGlite;

beforeAll(async () => {
  db = await migratedDb();
  await seedAskWhySet(db, set);
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'other@example.com', '{}')`, [OTHER]);
});
afterAll(async () => {
  await db?.close();
});

const asEval = () => rpcAs(db, EVAL_USER);
const ids = async (question: string, as = asEval()) => (await retrieveDecisions(as, question))!.map((d) => d.id);

const quota429 = () =>
  new APICallError({ message: "Resource exhausted", url: "https://example.invalid", requestBodyValues: {}, statusCode: 429, isRetryable: true });

/** A model that must never be called; counts calls if it is. */
function spyModel() {
  const doGenerate = vi.fn(async () => {
    throw new Error("the model must not be called");
  });
  return { model: new MockLanguageModelV4({ doGenerate }), doGenerate };
}

describe("search_decisions: the F12 retrieval over the Ask-why set", () => {
  const answerable = set.questions.flatMap((q) => (q.answerable ? [q] : []));
  const unanswerable = set.questions.filter((q) => !q.answerable);

  it.each(answerable.map((q) => [q.id, q.question, q.expect.decision_ids] as const))("%s: the expected decision ranks first (%s)", async (_id, question, expected) => {
    const got = await ids(question);
    expect(got.length).toBeLessThanOrEqual(5);
    expect(got[0]).toBe(expected[0]);
  });

  it.each(unanswerable.map((q) => [q.id, q.question] as const))("%s: zero rows (%s)", async (_id, question) => {
    expect(await ids(question)).toEqual([]);
  });

  it("finds all 10 answerable questions (plain AND found 5)", async () => {
    let found = 0;
    for (const q of answerable) if ((await ids(q.question)).includes(q.expect.decision_ids[0]!)) found++;
    expect(found).toBe(10);
  });

  it("returns the RetrievedDecision fields, with the thread title and counterparty joined (D31)", async () => {
    const [d] = (await retrieveDecisions(asEval(), "Why did I go with Delgado Plumbing?"))!;
    const src = set.decisions.find((x) => x.id === d!.id)!;
    expect(d).toMatchObject({
      id: src.id,
      thread_id: src.thread_id,
      thread_title: src.thread_title,
      counterparty: src.counterparty,
      choice: src.choice,
      reason_user: src.reason_user,
      context_facts: src.context_facts,
    });
    expect(new Date(d!.decided_at).toISOString()).toBe(new Date(src.decided_at).toISOString());
  });

  it.each([
    ["empty", ""],
    ["only stopwords", "Why did I do that?"],
    ["quotes and backslashes", `Why did I 'pick' "it" \\ or o'brien's \\' plan?`],
    ["tsquery operators", "car & | ! <-> :* ( ) insurance"],
  ])("%s: no error", async (_label, question) => {
    expect(await retrieveDecisions(asEval(), question)).not.toBeNull();
  });

  it("tsquery operators in the question are plain words, not syntax", async () => {
    expect(await ids("car & | ! <-> :* ( ) insurance")).toContain("d0000000-0000-4000-8000-000000000001");
  });

  it("caps the question at 300 characters", async () => {
    expect(await ids(`${"x ".repeat(150)} insurance`)).toEqual([]);
  });

  it("another user retrieves none of these decisions (RLS + auth.uid() filter)", async () => {
    expect(await ids("Why did I choose this car insurance?", rpcAs(db, OTHER))).toEqual([]);
  });

  it("is SECURITY INVOKER with search_path pinned, executable by authenticated only", async () => {
    const { rows } = await db.query<{ definer: boolean; config: string[]; auth: boolean; anon: boolean; volatile: string }>(
      `select p.prosecdef as definer, p.proconfig as config, p.provolatile as volatile,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon
       from pg_proc p where p.proname = 'search_decisions' and p.pronamespace = 'public'::regnamespace`,
    );
    expect(rows).toEqual([{ definer: false, config: ['search_path=""'], volatile: "s", auth: true, anon: false }]);
  });
});

describe("askQuestion(): F12 server side", () => {
  it("rule 7: zero retrieved decisions answers the no-record message without calling the model", async () => {
    const { model, doGenerate } = spyModel();
    const r = await askQuestion(asEval(), "Why did I sell the piano?", { model, logger: () => {} });
    expect(r).toEqual({ ok: true, view: { found: false, message: NO_RECORD_MESSAGE, decisions: [], interpretations: [] }, counts: {} });
    expect(doGenerate).not.toHaveBeenCalled();
  });

  it("D33: shows the whole stored reason and stored facts of the cited decision, labelled by voice", async () => {
    const r = await askQuestion(asEval(), "Why did I choose this car insurance?", { model: createRecordedModel(), logger: () => {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = set.decisions[0]!;
    expect(r.view.decisions).toEqual([
      {
        id: src.id,
        thread_id: src.thread_id,
        thread_title: src.thread_title,
        choice: src.choice,
        decided_at: expect.any(String),
        reason_user: src.reason_user,
        facts: [src.context_facts[0]!.text],
        interpretations: [],
      },
    ]);
    expect(r.counts).toEqual({ user_reason: 1, source_fact: 1, inference: 0 });
  });

  it("a decision with no recorded reason is answered with reason_user null (the no-reason state), never an invented one", async () => {
    const r = await askQuestion(asEval(), "Why did I switch dental plans?", { model: createRecordedModel(), logger: () => {} });
    expect(r.ok && r.view.decisions.map((d) => [d.id, d.reason_user])).toEqual([["d0000000-0000-4000-8000-000000000005", null]]);
  });

  it("cited IDs outside the retrieved set are rejected; with nothing left the answer is the no-record message", async () => {
    const logger = vi.fn();
    const outside = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answer_found: true,
              // d…012 exists for this user but is not retrieved for this question.
              decision_ids: ["d0000000-0000-4000-8000-000000000012"],
              answer_parts: [{ kind: "user_reason", text: "That is the most the employer matches.", ref: "d0000000-0000-4000-8000-000000000012" }],
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: undefined, reasoning: undefined } },
        warnings: [],
      }),
    });
    const r = await askQuestion(asEval(), "Why did I cancel the gym?", { model: outside, logger });
    expect(r).toMatchObject({ ok: true, view: { found: false, message: NO_RECORD_MESSAGE, decisions: [] } });
    expect(logger).toHaveBeenCalledWith("ask_why_ref_rejected", { reason: "decision_id_not_retrieved" });
  });

  it("D54: a failed model call is ask_failed (retryable) with no answer", async () => {
    const failing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw quota429();
      },
    });
    const r = await askQuestion(asEval(), "Why did I cancel the gym?", { model: failing, logger: () => {} });
    expect(r).toEqual({
      ok: false,
      error: { error: { code: "ask_failed", message: "I couldn't answer that just now. Try asking again.", retryable: true } },
    });
  });

  it("D54: a failed retrieval is ask_failed and the model is not called", async () => {
    const { model, doGenerate } = spyModel();
    const broken = { rpc: async (fn: string, args: Record<string, unknown>) => (fn === "consume_usage" ? { data: true, error: null } : { data: null, error: { code: "XX000", message: String(args) } }) };
    const r = await askQuestion(broken, "Why did I cancel the gym?", { model, logger: () => {} });
    expect(r.ok === false && r.error.error.code).toBe("ask_failed");
    expect(doGenerate).not.toHaveBeenCalled();
  });

  it("counts every ask; the 51st of the UTC day is rate_limited and retrieves nothing", async () => {
    const fresh = await migratedDb();
    try {
      await seedAskWhySet(fresh, set);
      const rpc = rpcAs(fresh, EVAL_USER);
      const { model, doGenerate } = spyModel();
      for (let i = 0; i < 50; i++) expect((await askQuestion(rpc, "Why did I sell the piano?", { model, logger: () => {} })).ok).toBe(true);
      const spy = vi.fn(rpc.rpc);
      const r = await askQuestion({ rpc: spy }, "Why did I sell the piano?", { model, logger: () => {} });
      expect(r).toEqual({
        ok: false,
        error: { error: { code: "rate_limited", message: "You've reached today's limit of 50 questions. It resets at midnight (UTC).", retryable: false } },
      });
      expect(spy.mock.calls.map((c) => c[0])).toEqual(["consume_usage"]);
      expect(doGenerate).not.toHaveBeenCalled();
      const { rows } = await fresh.query<{ asks: number }>(`select asks from usage_counters where user_id = $1`, [EVAL_USER]);
      expect(rows[0]!.asks).toBe(50);
    } finally {
      await fresh.close();
    }
  });
});

describe("Ask-why eval runner (recorded answers)", () => {
  it("20 questions: 0 fabrications, 10/10 answerable hits, no model call for the 10 unanswerable", async () => {
    const report = await runAskWhyEval({
      set,
      retrieve: async (q) => (await retrieveDecisions(asEval(), q))!,
      model: createRecordedModel(),
      modelLabel: "fake:recorded",
    });
    expect(report).toMatchObject({
      questions: 20,
      answerable: 10,
      fabrications: 0,
      fabrications_by_kind: {},
      misses_by_kind: {},
      answerable_hit_rate: 1,
      llm_calls: 10,
      failures: 0,
      result: "pass",
      pass: true,
      prompt_version: "ask-why.v2",
      schema_version: "ask-why.v1",
    });
    for (const r of report.perQuestion.filter((x) => !x.answerable)) expect(r).toMatchObject({ retrieved: 0, llm_called: false, answer_found: false });

    // The scorecard row reports the count instead of "not run"; content-free (IDs, counts, enums).
    const card = renderScorecard({ ...EMPTY_REPORT }, report);
    expect(card).toContain("| Ask-why fabrications | 0 | 0 |");
    expect(card).toContain("prompt ask-why.v2");
    for (const d of set.decisions) {
      expect(card).not.toContain(d.choice);
      if (d.reason_user) expect(card).not.toContain(d.reason_user);
    }
    expect(JSON.stringify(report)).not.toContain(set.decisions[0]!.reason_user!);
  });

  it("an answer quoting part of a reason or citing an unretrieved decision is counted as a fabrication", async () => {
    const report = await runAskWhyEval({
      set: { ...set, questions: set.questions.filter((q) => q.id === "a06") },
      retrieve: async (q) => (await retrieveDecisions(asEval(), q))!,
      model: createRecordedModel({
        recordings: [
          {
            name: "bad",
            task: "ask_why",
            input: "Why did I cancel the gym?",
            responses: [{ answer_found: true, decision_ids: ["d0000000-0000-4000-8000-000000000006"], answer_parts: [{ kind: "inference", text: "You stopped going.", ref: null }] }],
          },
        ],
      }),
      modelLabel: "fake:recorded",
    });
    // askWhy() never shows model text as "You wrote", so a missing reason is a miss, not a fabrication.
    expect(report).toMatchObject({ fabrications: 0, misses_by_kind: { reason_missing: 1 }, result: "pass" });
  });

  it("a failed call is counted and fails the run; quota-only failures make it incomplete", async () => {
    const quota = new MockLanguageModelV4({
      doGenerate: async () => {
        throw quota429();
      },
    });
    const report = await runAskWhyEval({ set, retrieve: async (q) => (await retrieveDecisions(asEval(), q))!, model: quota, modelLabel: "x" });
    expect(report).toMatchObject({ failures: 10, failures_by_kind: { quota: 10 }, fabrications: 0, result: "incomplete_quota", pass: false });
  });
});

const EMPTY_REPORT: EvalReport = {
  model: "fake:recorded",
  prompt_version: "extract.v1",
  schema_version: "x",
  run_at: "2026-10-22T00:00:00.000Z",
  rpm: null,
  fixtures: 0,
  ambiguous_fixtures: 0,
  scores: {
    recall: null,
    precision: null,
    false_positive_rate: null,
    date: null,
    owner: null,
    band: null,
    band_all: null,
    due_certainty: null,
    type: null,
    page: null,
    verified_quotes: null,
    unverified_quotes_shown: 0,
    speculative_scored_high: 0,
    explicit_dated_scored_low: 0,
    extraction_failures: 0,
  },
  failures_by_kind: {},
  complete: true,
  thresholds: { recall: 0.8, precision: 0.75, date: 0.95, owner: 0.9, band: 0.85 },
  result: "fail",
  pass: false,
  perFixture: [],
};
