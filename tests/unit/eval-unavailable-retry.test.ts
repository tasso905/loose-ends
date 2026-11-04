import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAskWhyEval } from "@/evals/ask-why/harness";
import { loadAskWhySet } from "@/evals/ask-why/set";
import { DEFAULT_UNAVAILABLE_RETRY, renderScorecard, runEval, type UnavailableRetry } from "@/evals/harness";
import { createRecordedModel } from "@/lib/ai/fake";
import { readBlock } from "@/lib/ai/prompts";
import { AskWhyOutput, Extraction } from "@/lib/ai/schema";

/**
 * `pnpm eval` retries a case whose final failure is `unavailable` (503, 5xx, network, timeout) in
 * later rounds, and says so in the report. Every other failure is a real result. Fake provider only.
 */

const MARK = "SYNTHETIC-SECRET-MARK";
const QUOTE = "I'll send Dana the invoice on Friday.";
const TEXT = (n: string) => `Synthetic ${MARK} ${n}. ${QUOTE}`;
const usage = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};
const apiErr = (statusCode: number) =>
  new APICallError({ message: `echo ${MARK}`, url: "https://x.invalid", requestBodyValues: { prompt: MARK }, statusCode, isRetryable: statusCode >= 500 || statusCode === 429 });
const response = Extraction.parse({
  source_summary: "Synthetic",
  participants: [],
  brief: null,
  items: [{ type: "commitment", title: "Send Dana the invoice", owner: "user", counterparty: "Dana", action: null, date_text: "on Friday", date_iso: "2026-10-09", amount_text: null, certainty: "explicit", uncertainty_notes: [], matches_thread_id: null, evidence: [{ quote: QUOTE, speaker: null }] }],
});

type Step = number | "broken" | "ok";

/** Plays `steps` per source text, one per provider call; the last step repeats. */
function scripted(byName: Record<string, Step[]>, block: "source" | "question" = "source", ok?: unknown) {
  const calls: Record<string, number> = {};
  const inputs = Object.keys(byName);
  const recorded = ok
    ? null
    : createRecordedModel({ recordings: inputs.map((n, i) => ({ name: `r${i}`, task: "extract" as const, input: TEXT(n), responses: [response] })) });
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const text = (options.prompt as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content.map((p) => p.text ?? ""))
        .join("\n");
      const input = readBlock(block, text) ?? "";
      const name = inputs.find((n) => (block === "source" ? input === TEXT(n) : input === n))!;
      const seen = calls[name] ?? 0;
      calls[name] = seen + 1;
      const steps = byName[name]!;
      const step = steps[Math.min(seen, steps.length - 1)]!;
      if (typeof step === "number") throw apiErr(step);
      if (step === "broken") return { content: [{ type: "text" as const, text: "{broken" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
      if (ok) return { content: [{ type: "text" as const, text: JSON.stringify(ok) }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
      return recorded!.doGenerate(options);
    },
  });
  return { model, calls };
}

let dir: string;
let slept: number[];
let policy: UnavailableRetry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "le-evalretry-"));
  slept = [];
  policy = { ...DEFAULT_UNAVAILABLE_RETRY, sleep: async (ms) => void slept.push(ms) };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string) {
  mkdirSync(join(dir, name));
  writeFileSync(join(dir, name, "input.txt"), TEXT(name));
  writeFileSync(join(dir, name, "meta.json"), JSON.stringify({ reference_date: "2026-10-05", timezone: "America/New_York", user: { display_name: "Sam", aliases: [] } }));
  writeFileSync(join(dir, name, "expected.json"), JSON.stringify({ items: [{ type: "commitment", owner: "user", quote: QUOTE, due_date: "2026-10-09", band: "high" }] }));
}
const run = (model: MockLanguageModelV4) => runEval({ fixturesDir: dir, model, modelLabel: "fake:t", runAt: "2026-10-20T00:00:00.000Z", unavailableRetry: policy });

describe("runEval(): unavailable is retried in later rounds", () => {
  it("503 then success counts as matched, and the extra attempt is reported", async () => {
    fixture("a");
    // extract() makes 2 calls on a 503 (D43), so the first attempt is two 503s.
    const { model, calls } = scripted({ a: [503, 503, "ok"] });
    const r = await run(model);

    expect(slept).toEqual([15_000]);
    expect(calls.a).toBe(3);
    expect(r.perFixture[0]).toMatchObject({ ok: true, attempts: 1, extra_attempts: 1, failure: null, counts: { matched: 1, missed: 0 } });
    expect(r.unavailable_retries).toEqual({ rounds: 1, extra_attempts: 1, retried: 1, still_unavailable: 0 });
    expect(r.complete).toBe(true);
    expect(r.scores.extraction_failures).toBe(0);
    expect(r.failures_by_kind).toEqual({});
    expect(r.scores.recall).toBe(1);

    const card = renderScorecard(r);
    expect(card).toContain("- Extra attempts after provider unavailable: 1 (1 fixtures, 1 rounds, 0 still unavailable)");
    expect(card).toContain("| a | ok | 1 | 1 | 0 |");
  });

  it("a clean run states zero extra attempts rather than leaving them out", async () => {
    fixture("a");
    const r = await run(scripted({ a: ["ok"] }).model);
    expect(slept).toEqual([]);
    expect(r.unavailable_retries).toEqual({ rounds: 0, extra_attempts: 0, retried: 0, still_unavailable: 0 });
    expect(renderScorecard(r)).toContain("- Extra attempts after provider unavailable: 0 (0 fixtures, 0 rounds, 0 still unavailable)");
  });

  it("only what is still unavailable runs again; results stay in fixture order and are scored once", async () => {
    fixture("a");
    fixture("b");
    fixture("c");
    const { model, calls } = scripted({ a: ["ok"], b: [503, 503, 503, 503, "ok"], c: [500, 500, "ok"] });
    const r = await run(model);
    expect(slept).toEqual([15_000, 30_000]);
    expect(calls).toEqual({ a: 1, b: 5, c: 3 });
    expect(r.perFixture.map((f) => [f.name, f.extra_attempts, f.ok])).toEqual([["a", 0, true], ["b", 2, true], ["c", 1, true]]);
    expect(r.unavailable_retries).toEqual({ rounds: 2, extra_attempts: 3, retried: 2, still_unavailable: 0 });
    expect(r.scores.recall).toBe(1);
    expect(r.scores.precision).toBe(1);
  });

  it("exhausted retries still fail the run: bounded, complete false, counted as failed", async () => {
    fixture("a");
    const { model, calls } = scripted({ a: [503] });
    const r = await run(model);
    expect(slept).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(calls.a).toBe(10);
    expect(r.perFixture[0]).toMatchObject({ ok: false, extra_attempts: 4, failure: { kind: "unavailable", status: 503 }, counts: { missed: 1 } });
    expect(r.unavailable_retries).toEqual({ rounds: 4, extra_attempts: 4, retried: 1, still_unavailable: 1 });
    expect(r).toMatchObject({ complete: false, result: "fail", pass: false, failures_by_kind: { unavailable: 1 } });
    expect(r.scores.extraction_failures).toBe(1);
    const card = renderScorecard(r);
    expect(card).toContain("Incomplete run");
    expect(card).toContain("| a | failed (unavailable) | 4 |");
  });

  it.each([
    ["malformed", "broken" as Step, 2, "malformed"],
    ["quota", 429 as Step, 1, "quota"],
    ["rejected", 400 as Step, 1, "rejected"],
    ["config", 401 as Step, 1, "config"],
  ])("%s is a real result: never retried by the harness", async (_n, step, providerCalls, kind) => {
    fixture("a");
    const { model, calls } = scripted({ a: [step] });
    const r = await run(model);
    expect(slept).toEqual([]);
    expect(calls.a).toBe(providerCalls);
    expect(r.perFixture[0]).toMatchObject({ ok: false, extra_attempts: 0, failure: { kind } });
    expect(r.unavailable_retries.extra_attempts).toBe(0);
    expect(r.complete).toBe(false);
  });

  it("a retry that ends in a real failure stops there and reports that failure", async () => {
    fixture("a");
    const { model, calls } = scripted({ a: [503, 503, "broken"] });
    const r = await run(model);
    expect(slept).toEqual([15_000]);
    expect(calls.a).toBe(4);
    expect(r.perFixture[0]).toMatchObject({ ok: false, extra_attempts: 1, failure: { kind: "malformed" } });
    expect(r.unavailable_retries).toMatchObject({ retried: 1, still_unavailable: 0 });
    expect(r.failures_by_kind).toEqual({ malformed: 1 });
  });

  it("rule 9: the report and the scorecard hold counts and kinds, never content", async () => {
    fixture("a");
    fixture("b");
    const r = await run(scripted({ a: [503, 503, "ok"], b: [503] }).model);
    const out = JSON.stringify(r) + renderScorecard(r);
    expect(out).not.toContain(MARK);
    expect(out).not.toMatch(/invoice|Dana|echo/);
  });

  it("off unless asked: a run without a policy does not retry, so callers keep their timing", async () => {
    fixture("a");
    const { model, calls } = scripted({ a: [503] });
    const r = await runEval({ fixturesDir: dir, model, modelLabel: "fake:t", runAt: "2026-10-20T00:00:00.000Z" });
    expect(calls.a).toBe(2);
    expect(r.unavailable_retries).toEqual({ rounds: 0, extra_attempts: 0, retried: 0, still_unavailable: 1 });
  });
});

describe("the policy `pnpm eval` uses", () => {
  it("is bounded: 4 extra rounds, backoff, no delay above 2 minutes", () => {
    expect(DEFAULT_UNAVAILABLE_RETRY.delaysMs).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(Math.max(...DEFAULT_UNAVAILABLE_RETRY.delaysMs)).toBeLessThanOrEqual(120_000);
  });

  it("evals/run.ts passes it to both evals", () => {
    const src = readFileSync(join(process.cwd(), "evals", "run.ts"), "utf8");
    expect(src.match(/unavailableRetry: DEFAULT_UNAVAILABLE_RETRY/g)).toHaveLength(2);
  });
});

describe("runAskWhyEval(): the same rule for questions", () => {
  const full = loadAskWhySet();
  const q = full.questions.find((x) => x.answerable && x.expect.user_reason === "required" && x.expect.decision_ids.length === 1);
  if (!q || !q.answerable) throw new Error("the Ask-why set needs an answerable question with one decision and a reason");
  const none = full.questions.find((x) => !x.answerable)!;
  const decision = full.decisions.find((d) => d.id === q.expect.decision_ids[0])!;
  const set = { ...full, questions: [q, none] };
  const retrieve = async (question: string) => (question === q.question ? [decision] : []);
  const perfect = AskWhyOutput.parse({
    answer_found: true,
    decision_ids: [decision.id],
    answer_parts: [
      { kind: "user_reason", text: decision.reason_user, ref: decision.id },
      ...decision.context_facts.map((f) => ({ kind: "source_fact", text: f.text, ref: f.evidence_id ?? decision.id })),
    ],
  });
  const ask = (steps: Step[]) => {
    const s = scripted({ [q.question]: steps }, "question", perfect);
    return runAskWhyEval({ set, retrieve, model: s.model, modelLabel: "fake:t", unavailableRetry: policy }).then((r) => ({ r, calls: s.calls[q.question] }));
  };

  it("503 then success passes and reports the extra attempt; a no-record question never calls the model", async () => {
    const { r, calls } = await ask([503, 503, "ok"]);
    expect(slept).toEqual([15_000]);
    expect(calls).toBe(3);
    expect(r).toMatchObject({ failures: 0, fabrications: 0, result: "pass", failures_by_kind: {} });
    expect(r.unavailable_retries).toEqual({ rounds: 1, extra_attempts: 1, retried: 1, still_unavailable: 0 });
    expect(r.perQuestion[0]).toMatchObject({ id: q.id, failure: null, extra_attempts: 1, misses: [] });
    expect(r.perQuestion[1]).toMatchObject({ id: none.id, llm_called: false, extra_attempts: 0 });
    expect(r.llm_calls).toBe(2);
  });

  it("malformed is not retried", async () => {
    const { r, calls } = await ask(["broken"]);
    expect(slept).toEqual([]);
    expect(calls).toBe(2);
    expect(r).toMatchObject({ failures: 1, result: "fail", failures_by_kind: { malformed: 1 } });
    expect(r.unavailable_retries.extra_attempts).toBe(0);
  });

  it("exhausted retries still fail", async () => {
    const { r, calls } = await ask([503]);
    expect(slept).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(calls).toBe(10);
    expect(r).toMatchObject({ failures: 1, result: "fail", pass: false, failures_by_kind: { unavailable: 1 } });
    expect(r.unavailable_retries).toEqual({ rounds: 4, extra_attempts: 4, retried: 1, still_unavailable: 1 });
    expect(r.perQuestion[0]).toMatchObject({ failure: "unavailable", extra_attempts: 4 });
  });

  it("the scorecard states the extra attempts for Ask why, with no content", async () => {
    fixture("a");
    const e = await run(scripted({ a: ["ok"] }).model);
    const { r } = await ask([503, 503, "ok"]);
    const card = renderScorecard(e, r);
    expect(card).toContain("extra attempts after provider unavailable 1 (1 questions, 1 rounds, 0 still unavailable)");
    expect(JSON.stringify(r)).not.toContain(q.question);
  });
});
