import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError, NoObjectGeneratedError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThrottle, DEFAULT_EVAL_RPM, evalRpm, renderScorecard, runEval } from "@/evals/harness";
import { askWhy, type RetrievedDecision } from "@/lib/ai/askWhy";
import { AskWhyFailedError } from "@/lib/ai/errors";
import { createRecordedModel } from "@/lib/ai/fake";
import { extract, ExtractionFailedError, type ExtractInput } from "@/lib/ai/extract";
import { EXTRACT_PROMPT_VERSION, readBlock } from "@/lib/ai/prompts";
import { AiConfigError, getModel } from "@/lib/ai/provider";
import { safeErrorFields } from "@/lib/ai/safeError";
import { EXTRACTION_SCHEMA_VERSION } from "@/lib/ai/schema";

/** Slice S0 (AI hardening): askWhy retry parity (D43), -latest refusal, safeErrorFields (rule 9), eval harness. No network. */

const SOURCE = "Synthetic-marker-ZK4: Priya said she'd send the signed lease by the 14th.";
const DECISIONS: RetrievedDecision[] = [
  { id: "dec-1", thread_id: "t", thread_title: "Synthetic", counterparty: null, choice: "Renewed", reason_user: "Synthetic reason RR8", decided_at: "2026-10-10T00:00:00.000Z", context_facts: [] },
];
const usage = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};
const apiError = (statusCode: number) =>
  new APICallError({ message: `provider echo: ${SOURCE}`, url: "https://example.invalid", requestBodyValues: { prompt: SOURCE }, statusCode, isRetryable: statusCode === 429 || statusCode >= 500 });

function counting(fail: () => unknown, then?: string) {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls++;
      if (calls === 1 || then === undefined) throw fail();
      return { content: [{ type: "text", text: then }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
  });
  return { model, calls: () => calls };
}

describe("askWhy() retry parity with extract() (D43)", () => {
  it("429 quota → exactly 1 call, no retry", async () => {
    const m = counting(() => apiError(429));
    const logger = vi.fn();
    const err = await askWhy("Why?", DECISIONS, { model: m.model, logger }).catch((e) => e);
    expect(err).toBeInstanceOf(AskWhyFailedError);
    expect(err).toMatchObject({ kind: "quota", status: 429 });
    expect(m.calls()).toBe(1);
    expect(logger).not.toHaveBeenCalledWith("ask_why_retry", expect.anything());
    expect(logger).toHaveBeenCalledWith("ask_why_failed", expect.objectContaining({ kind: "quota", attempts: 1 }));
  });

  it.each([400, 401])("%i → exactly 1 call", async (status) => {
    const m = counting(() => apiError(status));
    await askWhy("Why?", DECISIONS, { model: m.model, logger: () => {} }).catch(() => {});
    expect(m.calls()).toBe(1);
  });

  it("5xx → 2 calls, then AskWhyFailedError", async () => {
    const m = counting(() => apiError(503));
    const logger = vi.fn();
    const err = await askWhy("Why?", DECISIONS, { model: m.model, logger }).catch((e) => e);
    expect(err).toMatchObject({ kind: "unavailable", status: 503 });
    expect(m.calls()).toBe(2);
    expect(logger).toHaveBeenCalledWith("ask_why_retry", { kind: "unavailable", status: 503, error: "AI_APICallError" });
    expect(logger).toHaveBeenCalledWith("ask_why_failed", expect.objectContaining({ attempts: 2 }));
  });

  it("malformed output → 2 calls; a valid second response is used", async () => {
    const valid = JSON.stringify({ answer_found: true, decision_ids: ["dec-1"], answer_parts: [{ kind: "user_reason", text: "x", ref: "dec-1" }] });
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        const text = calls === 1 ? "{not json" : valid;
        return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
      },
    });
    const a = await askWhy("Why?", DECISIONS, { model, logger: () => {} });
    expect(calls).toBe(2);
    expect(a.answer_found).toBe(true);
  });

  it("malformed twice → 2 calls, then kind malformed", async () => {
    const m = counting(() => new NoObjectGeneratedError({ message: "bad", text: SOURCE, response: { id: "r", timestamp: new Date(0), modelId: "m" }, usage: { inputTokens: 1, outputTokens: 1 } as never, finishReason: "stop" }));
    const err = await askWhy("Why?", DECISIONS, { model: m.model, logger: () => {} }).catch((e) => e);
    expect(err).toMatchObject({ kind: "malformed" });
    expect(m.calls()).toBe(2);
  });
});

describe("provider: moving aliases (D42)", () => {
  it.each(["gemini-Flash-LATEST", "gemini-flash-Latest", "LATEST"])("rejects %s case-insensitively", (id) => {
    expect(() => getModel({ AI_PROVIDER: "google", AI_MODEL: id, AI_API_KEY: "k" })).toThrow(AiConfigError);
  });
  it("still accepts an exact ID that merely contains 'latest' mid-string", () => {
    expect(getModel({ AI_PROVIDER: "google", AI_MODEL: "gemini-latestish-flash", AI_API_KEY: "k" }).modelId).toBe("gemini-latestish-flash");
  });
});

describe("safeErrorFields() (rule 9)", () => {
  const KEYS = ["error", "kind", "status", "retryable", "code", "attempts", "model", "latency_ms", "cause_error"].sort();

  it("ExtractionFailedError: keeps the classification, drops rawText, message and cause", () => {
    const err = new ExtractionFailedError(2, "google:gemini-3.5-flash", "AI_NoObjectGeneratedError", 120, `{"quote":"${SOURCE}"}`, "malformed", null);
    Object.assign(err, { cause: apiError(500) });
    const f = safeErrorFields(err);
    expect(Object.keys(f).sort()).toEqual(KEYS);
    expect(f).toEqual({
      error: "ExtractionFailedError", kind: "malformed", status: null, retryable: true, code: "extraction_failed",
      attempts: 2, model: "google:gemini-3.5-flash", latency_ms: 120, cause_error: "AI_NoObjectGeneratedError",
    });
    expect(JSON.stringify(f)).not.toContain("ZK4");
    expect(JSON.stringify(f)).not.toContain("Priya");
  });

  it("a real extract() failure that captured raw model text yields no source text", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: `{"echo":"${SOURCE}"` }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
    });
    const input: ExtractInput = { sourceText: SOURCE, sourceKind: "paste", referenceDate: "2026-10-05", referenceDateSource: "user", timezone: "America/New_York", user: { displayName: "Sam", aliases: [] } };
    const err = (await extract(input, { model, logger: () => {} }).catch((e) => e)) as ExtractionFailedError;
    expect(err.rawText).toContain("ZK4"); // precondition: the error does carry the source
    expect(JSON.stringify(safeErrorFields(err))).not.toMatch(/ZK4|Priya|lease/);
  });

  it("raw provider error: no message, request body or response", () => {
    const f = safeErrorFields(apiError(429));
    expect(f).toMatchObject({ error: "AI_APICallError", kind: "quota", status: 429, retryable: false });
    expect(JSON.stringify(f)).not.toMatch(/ZK4|provider echo|example\.invalid/);
  });

  it("AskWhyFailedError and arbitrary values", () => {
    expect(safeErrorFields(new AskWhyFailedError({ kind: "unavailable", status: 503, retryable: true }, 5))).toMatchObject({ kind: "unavailable", status: 503, retryable: true, latency_ms: 5 });
    expect(safeErrorFields(SOURCE)).toMatchObject({ error: "non_error_thrown", kind: "unknown" });
    const odd = new Error(SOURCE);
    odd.name = SOURCE; // a name that is not a class name is replaced
    expect(JSON.stringify(safeErrorFields(odd))).not.toContain("ZK4");
  });
});

describe("eval harness", () => {
  let dir: string;
  const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
  const QUOTA = "Synthetic quota fixture: Dana will send the invoice Monday.";

  const fixture = (name: string, input: string, items: unknown[]) => {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "input.txt"), input);
    writeFileSync(join(dir, name, "meta.json"), JSON.stringify({ reference_date: "2026-10-05", timezone: "America/New_York", user: { display_name: "Sam", aliases: [] } }));
    writeFileSync(join(dir, name, "expected.json"), JSON.stringify({ items }));
  };

  /** Recorded fake for MIKE (any number of copies), a 429 for QUOTA; logs each call's (fake) time. */
  function model(times: number[]) {
    const recorded = createRecordedModel();
    return new MockLanguageModelV4({
      provider: "fake",
      modelId: "recorded",
      doGenerate: async (options) => {
        times.push(Date.now());
        const text = (options.prompt as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
          .filter((m) => m.role === "user")
          .flatMap((m) => m.content.map((p) => p.text ?? ""))
          .join("\n");
        if (readBlock("source", text) === QUOTA) throw apiError(429);
        return recorded.doGenerate(options);
      },
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "le-eval-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("EVAL_RPM: default for live providers, off for the fake, validated", () => {
    expect(DEFAULT_EVAL_RPM).toBe(5);
    expect(evalRpm({ AI_PROVIDER: "google" })).toBe(5);
    expect(evalRpm({ AI_PROVIDER: "fake" })).toBeNull();
    expect(evalRpm({ AI_PROVIDER: "google", EVAL_RPM: "12" })).toBe(12);
    expect(evalRpm({ AI_PROVIDER: "google", EVAL_RPM: "off" })).toBeNull();
    expect(evalRpm({ AI_PROVIDER: "google", EVAL_RPM: "0" })).toBeNull();
    expect(() => evalRpm({ AI_PROVIDER: "google", EVAL_RPM: "-3" })).toThrow(RangeError);
    expect(() => evalRpm({ AI_PROVIDER: "google", EVAL_RPM: "fast" })).toThrow(RangeError);
  });

  it("records per-fixture failure kind/status and the model, prompt and schema versions", async () => {
    fixture("a-mike", MIKE, [{ type: "commitment", owner: "user", quote: "I'll send you the revised proposal Friday", due_date: "2026-10-09", band: "high" }]);
    fixture("b-quota", QUOTA, [{ type: "commitment", owner: "other", quote: "Dana will send the invoice Monday", due_date: "2026-10-12", band: "high" }]);
    const times: number[] = [];
    const r = await runEval({ fixturesDir: dir, model: model(times), modelLabel: "fake:recorded", runAt: "2026-10-20T12:00:00.000Z" });

    expect(r).toMatchObject({ model: "fake:recorded", prompt_version: EXTRACT_PROMPT_VERSION, schema_version: EXTRACTION_SCHEMA_VERSION, run_at: "2026-10-20T12:00:00.000Z", fixtures: 2, rpm: null });
    expect(r.perFixture[0]).toMatchObject({ name: "a-mike", ok: true, attempts: 1, failure: null });
    expect(r.perFixture[1]).toMatchObject({ name: "b-quota", ok: false, attempts: 1, failure: { kind: "quota", status: 429, error: "ExtractionFailedError" } });
    expect(r.failures_by_kind).toEqual({ quota: 1 });
    expect(r.complete).toBe(false);
    expect(r.scores.extraction_failures).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(/Dana|invoice|provider echo|Mike/);

    const card = renderScorecard(r);
    const header = card.slice(0, card.indexOf("| Metric"));
    expect(header).toContain("Model: fake:recorded");
    expect(header).toContain(`Prompt version: ${EXTRACT_PROMPT_VERSION}`);
    expect(header).toContain(`Schema version: ${EXTRACTION_SCHEMA_VERSION}`);
    expect(header).toContain("Run date: 2026-10-20T12:00:00.000Z");
    expect(card).toContain("Failures by kind: quota 1");
  });

  it("throttle spaces provider calls by 60 000 / rpm ms (fake timers, no real waits)", async () => {
    vi.useFakeTimers({ now: 0 });
    for (const n of ["f1", "f2", "f3"]) fixture(n, MIKE, []);
    const times: number[] = [];
    const throttle = createThrottle(6, { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    const p = runEval({ fixturesDir: dir, model: model(times), modelLabel: "fake:recorded", throttle, runAt: "2026-10-20T12:00:00.000Z" });

    await vi.advanceTimersByTimeAsync(0);
    expect(times).toEqual([0]); // first call starts at once
    await vi.advanceTimersByTimeAsync(9_999);
    expect(times).toHaveLength(1); // 6 rpm → 10 s spacing
    await vi.advanceTimersByTimeAsync(20_001);
    const r = await p;
    expect(times).toEqual([0, 10_000, 20_000]);
    expect(r.rpm).toBe(6);
    expect(r.perFixture.every((f) => f.ok)).toBe(true);
  });

  it("throttle also gates extract()'s retry", async () => {
    vi.useFakeTimers({ now: 0 });
    fixture("retry", "Synthetic retry fixture.", []);
    const times: number[] = [];
    const m = new MockLanguageModelV4({
      doGenerate: async () => {
        times.push(Date.now());
        throw apiError(503);
      },
    });
    const throttle = createThrottle(60, { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    const p = runEval({ fixturesDir: dir, model: m, modelLabel: "fake:x", throttle, runAt: "2026-10-20T12:00:00.000Z" });
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await p;
    expect(times).toEqual([0, 1_000]);
    expect(r.perFixture[0]).toMatchObject({ attempts: 2, failure: { kind: "unavailable", status: 503 } });
  });
});
