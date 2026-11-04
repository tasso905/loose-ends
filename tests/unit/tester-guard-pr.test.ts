import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAskWhyEval } from "@/evals/ask-why/harness";
import { loadAskWhySet } from "@/evals/ask-why/set";
import { renderScorecard, runEval, type UnavailableRetry } from "@/evals/harness";
import { AskWhyOutput, Extraction } from "@/lib/ai/schema";
import { findCondition } from "@/lib/pipeline/conditional";
import { processExtraction } from "@/lib/pipeline/proposals";

/**
 * Lead-tester verification of test/guard-pr (e36f455): T-G19 past the developer's own pins, the cases
 * the eval retry's tests leave out, the guard's authority over extract.v4's labels, and the examples in
 * evals/KNOWN_LIMITS-guard.md not pinned elsewhere. Synthetic text, fake provider, no live calls.
 */

const capped = (q: string) => expect(findCondition(q, true)).not.toBeNull();
const notCapped = (q: string) => expect(findCondition(q, true)).toBeNull();

describe("T-G19: 'if you have no' is an opt-out only before the five opt-out nouns", () => {
  it.each([
    "If you have no objections, I'll send it Friday.",
    "If you have no objection, I'll send it Friday.",
    "If you have no further objections, I'll send it Friday.",
    "If you have no more questions, I'll close it Friday.",
    "If you have no other issues, I'll close it Friday.",
    "If you have no further concerns, I'll send it Friday.",
    "If you have no problems with it, I'll send it Friday.",
    "I'll send it Friday if you have no objections.",
  ])("stays out: %s", notCapped);

  it.each([
    "If you have no time, I'll cover it Friday.",
    "If you have no more time, I'll cover it Friday.",
    "If you have no further time, I'll cover it Friday.",
    "If you have no other chance, I'll cover it Friday.",
    "If you have no trouble with the lift, I'll bring it Friday.",
    "If you have no minute to spare, I'll cover it Friday.",
    "If you have no more than an hour, I'll cover it Friday.",
    "I'll cover it Friday if you have no time.",
  ])("caps: %s", capped);

  // Unchanged courtesies, including the determiners that stayed in the second branch of the mask.
  it.each(["If you have time, I'll walk you through it Friday.", "If you have more time, I'll walk you through it Friday.", "If you have any other questions, I'll call you Friday.", "If you have a moment, I'll walk you through it Friday."])(
    "a courtesy stays out: %s",
    notCapped,
  );
});

describe("limits around the mask that evals/KNOWN_LIMITS-guard.md does not list yet", () => {
  // Unsafe direction, since 0e65c60 (c7c1f2c capped these); the same reading as the pinned "if you have any concerns".
  it.each(["If you have any objections, I'll rework it Friday.", "If you have objections, I'll rework it Friday."])("under-cap: %s", notCapped);
  // Safe direction, the same as c7c1f2c: an opt-out outside the five nouns caps.
  it.each(["If you have no comments, I'll send it Friday.", "If you have no feedback, I'll send it Friday.", "If you have no thoughts on it, I'll send it Friday."])("over-cap: %s", capped);
});

describe("the guard outranks extract.v4's label", () => {
  const SOURCE = "I'll pay you back on Friday if the refund comes through. I'll return the ladder on Monday, if that works for you.";
  const item = (quote: string, date_text: string, date_iso: string, certainty: "explicit" | "speculative") => ({
    type: "commitment" as const,
    title: "Synthetic",
    owner: "user" as const,
    counterparty: null,
    action: null,
    date_text,
    date_iso,
    amount_text: null,
    certainty,
    uncertainty_notes: [],
    matches_thread_id: null,
    evidence: [{ quote, speaker: null }],
  });
  const run = (it0: ReturnType<typeof item>) =>
    processExtraction(Extraction.parse({ source_summary: "Synthetic", participants: [], brief: null, items: [it0] }), {
      sourceText: SOURCE,
      referenceDate: "2026-10-05",
      referenceDateSource: "user",
      timezone: "America/New_York",
      pageOffsets: null,
      logger: () => {},
    }).proposals[0]!;

  it("a model calling a conditional dated promise explicit is still capped at Low", () => {
    const p = run(item("I'll pay you back on Friday if the refund comes through.", "on Friday", "2026-10-09", "explicit"));
    expect(p.band).toBe("low");
    expect(p.signals as readonly string[]).toContain("conditional");
  });

  it("the prompt's courtesy example, labelled explicit, keeps High", () => {
    const p = run(item("I'll return the ladder on Monday, if that works for you.", "on Monday", "2026-10-12", "explicit"));
    expect(p.band).toBe("high");
    expect(p.signals as readonly string[]).not.toContain("conditional");
  });

  it("the guard never raises: the same courtesy labelled speculative by the model is not lifted", () => {
    const p = run(item("I'll return the ladder on Monday, if that works for you.", "on Monday", "2026-10-12", "speculative"));
    expect(["low", "ignore"]).toContain(p.band);
  });
});

describe("evals/KNOWN_LIMITS-guard.md: examples not pinned in tester-guard-followups-3", () => {
  it.each(["I'll send it Monday. Just to be clear, if the venue confirms.", "I'll send it Friday, once I have confirmed funding."])("under-cap: %s", notCapped);
  it.each(["I'll send it Friday, once I have a quick word with Sam.", "I'll send it Friday, once I have the payment details.", "I'll send it Friday, once I have the reply drafted."])("over-cap: %s", capped);
});

describe("eval retry: cases its own tests leave out", () => {
  const MARK = "SYNTHETIC-RETRY-MARK";
  const QUOTE = "I'll send Dana the invoice on Friday.";
  const usage = {
    inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: undefined, reasoning: undefined },
  };
  const apiErr = (statusCode: number) =>
    new APICallError({ message: `echo ${MARK}`, url: "https://x.invalid", requestBodyValues: { prompt: MARK }, statusCode, isRetryable: statusCode >= 500 || statusCode === 429 });
  const extraction = (quote: string) =>
    Extraction.parse({
      source_summary: "Synthetic",
      participants: [],
      brief: null,
      items: [{ type: "commitment", title: "Send Dana the invoice", owner: "user", counterparty: "Dana", action: null, date_text: "on Friday", date_iso: "2026-10-09", amount_text: null, certainty: "explicit", uncertainty_notes: [], matches_thread_id: null, evidence: [{ quote, speaker: null }] }],
    });

  type Step = number | "filter" | "boom" | { json: unknown };
  /** One script per model; the last step repeats. */
  function scripted(steps: Step[]) {
    const state = { calls: 0 };
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        const step = steps[Math.min(state.calls, steps.length - 1)]!;
        state.calls++;
        if (typeof step === "number") throw apiErr(step);
        if (step === "boom") throw new Error(`echo ${MARK}`);
        if (step === "filter") return { content: [], finishReason: { unified: "content-filter" as const, raw: "SAFETY" }, usage, warnings: [] };
        return { content: [{ type: "text" as const, text: JSON.stringify(step.json) }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
      },
    });
    return { model, state };
  }

  let dir: string;
  let slept: number[];
  let policy: UnavailableRetry;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "le-tester-evalretry-"));
    slept = [];
    policy = { delaysMs: [15_000, 30_000, 60_000, 120_000], sleep: async (ms) => void slept.push(ms) };
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "input.txt"), `Synthetic ${MARK}. ${QUOTE}`);
    writeFileSync(join(dir, "a", "meta.json"), JSON.stringify({ reference_date: "2026-10-05", timezone: "America/New_York", user: { display_name: "Sam", aliases: [] } }));
    writeFileSync(join(dir, "a", "expected.json"), JSON.stringify({ items: [{ type: "commitment", owner: "user", quote: QUOTE, due_date: "2026-10-09", band: "high" }] }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (model: MockLanguageModelV4) => runEval({ fixturesDir: dir, model, modelLabel: "fake:t", runAt: "2026-10-20T00:00:00.000Z", unavailableRetry: policy });

  it("safety is a real result: one call, no retry, complete false", async () => {
    const { model, state } = scripted(["filter"]);
    const r = await run(model);
    expect(slept).toEqual([]);
    expect(state.calls).toBe(1);
    expect(r.perFixture[0]).toMatchObject({ ok: false, extra_attempts: 0, failure: { kind: "safety" } });
    expect(r).toMatchObject({ complete: false, result: "fail", pass: false });
  });

  it("unknown is not retried by the harness either", async () => {
    const { model } = scripted(["boom"]);
    const r = await run(model);
    expect(slept).toEqual([]);
    expect(r.perFixture[0]).toMatchObject({ ok: false, extra_attempts: 0, failure: { kind: "unknown" } });
    expect(JSON.stringify(r) + renderScorecard(r)).not.toContain(MARK);
  });

  it("a retry cannot launder a bad answer: an unverifiable quote after a 503 is dropped and the run fails", async () => {
    const { model } = scripted([503, 503, { json: extraction("I'll send Dana the invoice and a fruit basket on Friday next month for sure.") }]);
    const r = await run(model);
    expect(r.perFixture[0]).toMatchObject({ ok: true, extra_attempts: 1, failure: null, counts: { matched: 0, missed: 1 } });
    expect(r.scores.recall).toBe(0);
    expect(r.scores.unverified_quotes_shown).toBe(0);
    expect(r).toMatchObject({ complete: true, result: "fail", pass: false });
  });

  it("a successful but poor first answer is not re-rolled", async () => {
    const { model, state } = scripted([{ json: { ...extraction(QUOTE), items: [] } }, { json: extraction(QUOTE) }]);
    const r = await run(model);
    expect(state.calls).toBe(1);
    expect(slept).toEqual([]);
    expect(r.scores.recall).toBe(0);
    expect(r.pass).toBe(false);
  });

  it("503 then 429 ends as quota, not judged, and the extra attempt is stated", async () => {
    const { model, state } = scripted([503, 503, 429]);
    const r = await run(model);
    expect(state.calls).toBe(3);
    expect(slept).toEqual([15_000]);
    expect(r).toMatchObject({ complete: false, result: "incomplete_quota", pass: false, failures_by_kind: { quota: 1 } });
    expect(r.unavailable_retries).toEqual({ rounds: 1, extra_attempts: 1, retried: 1, still_unavailable: 0 });
  });

  it("exhausted unavailable alongside quota is a fail, not incomplete_quota", async () => {
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "b", "input.txt"), `Other ${MARK}. ${QUOTE}`);
    writeFileSync(join(dir, "b", "meta.json"), JSON.stringify({ reference_date: "2026-10-05", timezone: "America/New_York", user: { display_name: "Sam", aliases: [] } }));
    writeFileSync(join(dir, "b", "expected.json"), JSON.stringify({ items: [{ type: "commitment", owner: "user", quote: QUOTE, due_date: "2026-10-09", band: "high" }] }));
    // a: 429 once and final. b: 503 on every later call.
    const { model } = scripted([429, 503]);
    const r = await run(model);
    expect(r.failures_by_kind).toEqual({ quota: 1, unavailable: 1 });
    expect(r).toMatchObject({ complete: false, result: "fail", pass: false });
    expect(r.unavailable_retries).toMatchObject({ still_unavailable: 1, retried: 1 });
  });

  describe("Ask why", () => {
    const full = loadAskWhySet();
    const q = full.questions.find((x) => x.answerable && x.expect.user_reason === "required" && x.expect.decision_ids.length === 1);
    if (!q || !q.answerable) throw new Error("the Ask-why set needs an answerable question with one decision and a reason");
    const decision = full.decisions.find((d) => d.id === q.expect.decision_ids[0])!;
    const set = { ...full, questions: [q] };
    const ask = (steps: Step[]) => {
      const s = scripted(steps);
      return runAskWhyEval({ set, retrieve: async () => [decision], model: s.model, modelLabel: "fake:t", unavailableRetry: policy }).then((r) => ({ r, calls: s.state.calls }));
    };

    it.each([
      ["quota", 429 as Step, 1],
      ["rejected", 400 as Step, 1],
      ["config", 401 as Step, 1],
      ["safety", "filter" as Step, 1],
    ])("%s is never retried", async (kind, step, calls) => {
      const { r, calls: seen } = await ask([step]);
      expect(slept).toEqual([]);
      expect(seen).toBe(calls);
      expect(r.failures_by_kind).toEqual({ [kind]: 1 });
      expect(r.unavailable_retries.extra_attempts).toBe(0);
      expect(r.pass).toBe(false);
    });

    it("a retry cannot launder a fabrication: answering a question with no recorded decision after a 503 fails the run", async () => {
      const none = full.questions.find((x) => !x.answerable)!;
      const answered = AskWhyOutput.parse({
        answer_found: true,
        decision_ids: [decision.id],
        answer_parts: [{ kind: "user_reason", text: "Synthetic and ignored: the server shows the stored reason.", ref: decision.id }],
      });
      const s = scripted([503, 503, { json: answered }]);
      const r = await runAskWhyEval({ set: { ...full, questions: [none] }, retrieve: async () => [decision], model: s.model, modelLabel: "fake:t", unavailableRetry: policy });
      expect(r.unavailable_retries.extra_attempts).toBe(1);
      expect(r.perQuestion[0]!.fabrications).toContain("answered_unanswerable");
      expect(r).toMatchObject({ fabrications: 1, failures: 0, result: "fail", pass: false });
    });
  });
});
