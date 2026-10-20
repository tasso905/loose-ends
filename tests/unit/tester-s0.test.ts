import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError, RetryError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThrottle, evalRpm, NO_THROTTLE, renderScorecard, runEval, throttledModel } from "@/evals/harness";
import { askWhy, NO_RECORD_MESSAGE, type RetrievedDecision } from "@/lib/ai/askWhy";
import { AskWhyFailedError } from "@/lib/ai/errors";
import { ExtractionFailedError } from "@/lib/ai/extract";
import { safeErrorFields } from "@/lib/ai/safeError";

/**
 * Lead-tester, slice S0 (independent of tests/unit/ai-hardening.test.ts). Synthetic data only.
 * Markers (MK-*) stand in for source/question content; none may reach logs, errors or reports.
 */

const MK = "MK-7Q priya lease 14th";
const usage = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};
const apiErr = (statusCode: number) =>
  new APICallError({ message: `echo ${MK}`, url: "https://x.invalid", requestBodyValues: { prompt: MK }, statusCode, responseBody: `resp ${MK}`, isRetryable: statusCode >= 500 || statusCode === 429 });
const DEC: RetrievedDecision[] = [
  { id: "dec-a", thread_id: "t", thread_title: `title ${MK}`, counterparty: null, choice: "c", reason_user: "Stored reason S1", decided_at: "2026-10-10T00:00:00.000Z", context_facts: [] },
];
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });

function seq(steps: Array<() => unknown>) {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[Math.min(calls, steps.length - 1)]!;
      calls++;
      const r = step();
      return r as ReturnType<typeof textResult>;
    },
  });
  return { model, calls: () => calls };
}
const throwing = (e: unknown) => () => {
  throw e;
};

describe("S0 safeErrorFields adversarial (rule 9)", () => {
  const assertClean = (f: unknown) => {
    const s = JSON.stringify(f);
    expect(s).not.toMatch(/MK-7Q|priya|lease|x\.invalid|echo|resp /i);
    for (const v of Object.values(f as Record<string, unknown>)) expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
  };

  it("nested cause chain carrying content is not followed", () => {
    const inner = apiErr(500);
    const mid = new Error(`mid ${MK}`, { cause: inner });
    const outer = new Error(`outer ${MK}`, { cause: mid });
    assertClean(safeErrorFields(outer));
    const efe = new ExtractionFailedError(2, "google:gemini-3.5-flash", "AI_APICallError", 1, `raw ${MK}`, "unavailable", 503);
    Object.assign(efe, { cause: outer });
    assertClean(safeErrorFields(efe));
  });

  it("RetryError wrapping provider errors with request bodies", () => {
    const re = new RetryError({ message: `retry ${MK}`, reason: "maxRetriesExceeded", errors: [apiErr(503), apiErr(429)] });
    const f = safeErrorFields(re);
    expect(f.kind).toBe("quota");
    assertClean(f);
  });

  it("hostile name: content-like, non-string, or toString/valueOf throwing", () => {
    const e1 = new Error("x");
    e1.name = `${MK} sentence`;
    assertClean(safeErrorFields(e1));
    const e2 = new Error("x");
    (e2 as unknown as { name: unknown }).name = { toString: () => MK, valueOf: () => MK };
    assertClean(safeErrorFields(e2));
    expect(safeErrorFields(e2).error).toBe("Error");
  });

  it("non-Error throwables: string, object with toString, symbol, null, number", () => {
    for (const t of [MK, { message: MK, toString: () => MK }, Symbol(MK), null, undefined, 42, [MK]]) {
      const f = safeErrorFields(t);
      expect(f.error).toBe("non_error_thrown");
      assertClean(f);
    }
  });

  it("FINDING probe: a name getter that throws (does safeErrorFields itself throw?)", () => {
    const e = new Error("x");
    Object.defineProperty(e, "name", {
      get() {
        throw new Error(`getter ${MK}`);
      },
    });
    let threw: unknown = null;
    let out: unknown = null;
    try {
      out = safeErrorFields(e);
    } catch (x) {
      threw = x;
    }
    // Observed in S0: it throws (the getter's own error escapes). Recorded, not desired behaviour.
    expect(out).toBeNull();
    expect(threw).toBeInstanceOf(Error);
  });

  it("FINDING probe: an Error subclass whose name is a valid identifier passes through verbatim (shape allow-list, not value allow-list)", () => {
    const e = new Error("x");
    e.name = "Priya";
    expect(safeErrorFields(e).error).toBe("Priya");
    const efe = new ExtractionFailedError(1, "fake:recorded", "Priya", 1, null, "unknown", null);
    expect(safeErrorFields(efe).cause_error).toBe("Priya");
  });

  it("ExtractionFailedError with tampered numeric fields and a content-like model label", () => {
    const efe = new ExtractionFailedError(Number.NaN, `model ${MK}`, `cause ${MK}`, Infinity, `raw ${MK}`, "malformed", Number.NaN);
    const f = safeErrorFields(efe);
    expect(f).toMatchObject({ attempts: null, latency_ms: null, status: null, model: null, cause_error: "Error", code: "extraction_failed" });
    assertClean(f);
  });

  it("only the documented keys come back, for every input type", () => {
    const keys = ["attempts", "cause_error", "code", "error", "kind", "latency_ms", "model", "retryable", "status"];
    for (const t of [apiErr(429), new ExtractionFailedError(1, "a:b", "X", 1, MK), new AskWhyFailedError({ kind: "safety", status: null, retryable: false }, 3), MK, new TypeError(`fetch failed ${MK}`)]) {
      expect(Object.keys(safeErrorFields(t)).sort()).toEqual(keys);
    }
  });
});

describe("S0 askWhy: rule 7 and D43 retry parity", () => {
  it("zero retrieved decisions: no model call, fixed copy, even with no env configured", async () => {
    const m = seq([() => textResult("{}")]);
    const a = await askWhy(`why ${MK}?`, [], { model: m.model, logger: () => {} });
    expect(m.calls()).toBe(0);
    expect(JSON.stringify(a)).toContain(NO_RECORD_MESSAGE);
    const saved = { p: process.env.AI_PROVIDER, m: process.env.AI_MODEL };
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;
    try {
      const b = await askWhy("why?", [], { logger: () => {} }); // would throw AiConfigError if it resolved a model
      expect(JSON.stringify(b)).toContain(NO_RECORD_MESSAGE);
    } finally {
      if (saved.p !== undefined) process.env.AI_PROVIDER = saved.p;
      if (saved.m !== undefined) process.env.AI_MODEL = saved.m;
    }
  });

  it.each([
    [429, 1, "quota"],
    [400, 1, "rejected"],
    [401, 1, "config"],
    [403, 1, "config"],
    [404, 1, "config"],
    [422, 1, "rejected"],
    [500, 2, "unavailable"],
    [503, 2, "unavailable"],
  ])("status %i → %i call(s), kind %s; logs carry no content", async (status, calls, kind) => {
    const m = seq([throwing(apiErr(status))]);
    const logs: unknown[] = [];
    const err = await askWhy(`why ${MK}?`, DEC, { model: m.model, logger: (e, f) => logs.push([e, f]) }).catch((e) => e);
    expect(err).toBeInstanceOf(AskWhyFailedError);
    expect(err.kind).toBe(kind);
    expect(m.calls()).toBe(calls);
    expect(JSON.stringify(logs)).not.toMatch(/MK-7Q|echo|resp /);
    expect(JSON.stringify(err)).not.toMatch(/MK-7Q/);
    expect(String(err.message)).not.toMatch(/MK-7Q/);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it("malformed then valid: second response used; IDs outside the retrieved set still rejected after a retry", async () => {
    const valid = JSON.stringify({
      answer_found: true,
      decision_ids: ["dec-a", "dec-foreign"],
      answer_parts: [
        { kind: "user_reason", text: "model text ignored", ref: "dec-a" },
        { kind: "user_reason", text: `invented ${MK}`, ref: "dec-foreign" },
      ],
    });
    const m = seq([() => textResult("{broken"), () => textResult(valid)]);
    const logs: Array<[string, unknown]> = [];
    const a = await askWhy("why?", DEC, { model: m.model, logger: (e, f) => logs.push([e, f]) });
    expect(m.calls()).toBe(2);
    const s = JSON.stringify(a);
    expect(s).not.toContain("dec-foreign");
    expect(s).not.toContain("invented");
    expect(s).toContain("Stored reason S1");
    expect(logs.map((l) => l[0])).toEqual(expect.arrayContaining(["ask_why_retry", "ask_why_ref_rejected"]));
  });

  it("non-APICallError plain Error (kind unknown, retryable) → 2 calls; safety → 1 call", async () => {
    const m1 = seq([throwing(new Error(`boom ${MK}`))]);
    const e1 = await askWhy("q", DEC, { model: m1.model, logger: () => {} }).catch((e) => e);
    expect(m1.calls()).toBe(2);
    expect(e1.kind).toBe("unknown");
    const m2 = seq([() => ({ content: [{ type: "text" as const, text: "" }], finishReason: { unified: "content-filter" as const, raw: "SAFETY" }, usage, warnings: [] })]);
    const e2 = await askWhy("q", DEC, { model: m2.model, logger: () => {} }).catch((e) => e);
    expect(e2.kind).toBe("safety");
    expect(m2.calls()).toBe(1);
  });

  it("FINDING probe: askWhy logs err.name raw (not via safeName) on retry/failure", async () => {
    const e = new Error("x");
    e.name = `name ${MK}`;
    const m = seq([throwing(e)]);
    const logs: unknown[] = [];
    await askWhy("q", DEC, { model: m.model, logger: (ev, f) => logs.push([ev, f]) }).catch(() => {});
    // Recorded: current behaviour copies the raw name into the log fields.
    expect(JSON.stringify(logs)).toContain("MK-7Q");
  });
});

describe("S0 throttle and EVAL_RPM", () => {
  afterEach(() => vi.useRealTimers());

  it("EVAL_RPM bad and edge values", () => {
    const g = (v: string | undefined) => () => evalRpm({ AI_PROVIDER: "google", EVAL_RPM: v });
    for (const bad of ["abc", "-1", "-0", "NaN", "Infinity", "-Infinity", "5rpm", "1,5"]) expect(g(bad)).toThrow(RangeError);
    expect(g("  off ")()).toBeNull();
    expect(g("OFF")()).toBeNull();
    expect(g(" 0 ")()).toBeNull();
    expect(g("")()).toBe(5);
    expect(g("   ")()).toBe(5);
    expect(g("0.5")()).toBe(0.5);
    expect(g("1e1")()).toBe(10);
    // Quirks recorded (not asserted as desired): Number() accepts hex and "00" is not treated as off.
    expect(g("0x10")()).toBe(16);
    expect(g("00")).toThrow(RangeError);
    // Unset EVAL_RPM and a provider with whitespace
    expect(evalRpm({ AI_PROVIDER: " fake " })).toBeNull();
    expect(evalRpm({})).toBe(5);
  });

  it("createThrottle rejects 0, negative, NaN, Infinity", () => {
    for (const v of [0, -1, Number.NaN, Infinity]) expect(() => createThrottle(v)).toThrow(RangeError);
  });

  it("concurrent waiters queue at fixed spacing", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const t = createThrottle(30, { now: () => now, sleep: async (ms) => void sleeps.push(ms) });
    await Promise.all([t.wait(), t.wait(), t.wait()]);
    expect(sleeps).toEqual([2000, 4000]);
    now = 10_000; // idle gap: next call goes at once
    await t.wait();
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("throttle gates extract()'s retry inside runEval (each doGenerate waits)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "le-s0-"));
    try {
      mkdirSync(join(dir, "f"));
      writeFileSync(join(dir, "f", "input.txt"), `Synthetic ${MK}.`);
      writeFileSync(join(dir, "f", "meta.json"), JSON.stringify({ reference_date: "2026-10-05" }));
      writeFileSync(join(dir, "f", "expected.json"), JSON.stringify({ items: [] }));
      const waits: number[] = [];
      let generateCalls = 0;
      const throttle = { rpm: 1, wait: async () => void waits.push(generateCalls) };
      const m = seq([
        () => {
          generateCalls++;
          return textResult("{broken");
        },
      ]);
      const r = await runEval({ fixturesDir: dir, model: m.model, modelLabel: "fake:t", throttle, runAt: "2026-10-20T00:00:00.000Z" });
      expect(m.calls()).toBe(2);
      expect(waits).toEqual([0, 1]); // a wait before each of the two attempts
      expect(r.perFixture[0]).toMatchObject({ ok: false, attempts: 2, failure: { kind: "malformed" } });
      const s = JSON.stringify(r) + renderScorecard(r);
      expect(s).not.toMatch(/MK-7Q|broken/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NO_THROTTLE leaves the model untouched", () => {
    const m = seq([() => textResult("{}")]).model;
    expect(throttledModel(m, NO_THROTTLE)).toBe(m);
  });
});

describe("S0 eval scoring integrity (defect pinned with it.fails; flip to it() once fixed)", () => {
  const mkFixture = (dir: string, name: string, items: unknown[]) => {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "input.txt"), `Synthetic ${name}: Dana will send the invoice Monday.`);
    writeFileSync(join(dir, name, "meta.json"), JSON.stringify({ reference_date: "2026-10-05" }));
    writeFileSync(join(dir, name, "expected.json"), JSON.stringify({ items }));
  };
  const item = { type: "commitment", owner: "other", quote: "Dana will send the invoice Monday", due_date: "2026-10-12", band: "high" };

  it("observed: every fixture fails (malformed) → pass true, complete true, all scores null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "le-s0-"));
    try {
      for (const n of ["a", "b", "c"]) mkFixture(dir, n, [item]);
      const m = seq([() => textResult("{broken")]);
      const r = await runEval({ fixturesDir: dir, model: m.model, modelLabel: "fake:t", runAt: "2026-10-20T00:00:00.000Z" });
      expect(r.scores.extraction_failures).toBe(3);
      expect(r.scores.recall).toBeNull();
      expect(r.pass).toBe(true);
      expect(r.complete).toBe(true);
      expect(renderScorecard(r)).toContain("Result: PASS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("desired: a failed fixture's expected items count as missed (recall), so an all-failure run cannot PASS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "le-s0-"));
    try {
      for (const n of ["a", "b", "c"]) mkFixture(dir, n, [item]);
      const m = seq([() => textResult("{broken")]);
      const r = await runEval({ fixturesDir: dir, model: m.model, modelLabel: "fake:t", runAt: "2026-10-20T00:00:00.000Z" });
      expect(r.pass).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
