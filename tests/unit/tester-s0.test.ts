import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError, RetryError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThrottle, EvalRpmError, evalRpm, failedGates, NO_THROTTLE, renderScorecard, runEval, throttledModel } from "@/evals/harness";
import { askWhy, NO_RECORD_MESSAGE, type RetrievedDecision } from "@/lib/ai/askWhy";
import { AskWhyFailedError } from "@/lib/ai/errors";
import { ExtractionFailedError } from "@/lib/ai/extract";
import { createRecordedModel } from "@/lib/ai/fake";
import { safeErrorFields } from "@/lib/ai/safeError";
import { Extraction, type Item } from "@/lib/ai/schema";

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

  it("N1 fixed: a name getter that throws does not make safeErrorFields throw, and its message never escapes", () => {
    const e = new Error("x");
    Object.defineProperty(e, "name", {
      get() {
        throw new Error(`getter ${MK}`);
      },
    });
    const f = safeErrorFields(e);
    expect(f).toMatchObject({ error: "Error", kind: "unknown" });
    assertClean(f);
    // Same hostile getter on an ExtractionFailedError (the subclass path reads more fields).
    const efe = new ExtractionFailedError(1, "fake:recorded", "X", 1, null, "malformed", null);
    Object.defineProperty(efe, "kind", {
      get() {
        throw new Error(`kind ${MK}`);
      },
    });
    expect(() => safeErrorFields(efe)).not.toThrow();
    assertClean(safeErrorFields(efe));
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

  it("N3 fixed: askWhy logs a content-like err.name as \"Error\" on retry and on failure", async () => {
    const e = new Error("x");
    e.name = `name ${MK}`;
    const m = seq([throwing(e)]);
    const logs: Array<[string, unknown]> = [];
    await askWhy("q", DEC, { model: m.model, logger: (ev, f) => logs.push([ev, f]) }).catch(() => {});
    expect(logs.map((l) => l[0])).toContain("ask_why_retry");
    expect(JSON.stringify(logs)).not.toContain("MK-7Q");
    for (const [, f] of logs) if (f && typeof f === "object" && "error" in f) expect((f as { error: unknown }).error).toBe("Error");
  });
});

describe("S0 throttle and EVAL_RPM", () => {
  afterEach(() => vi.useRealTimers());

  it("EVAL_RPM bad and edge values (N5: strict decimal)", () => {
    const g = (v: string | undefined) => () => evalRpm({ AI_PROVIDER: "google", EVAL_RPM: v });
    for (const bad of ["abc", "-1", "-0", "NaN", "Infinity", "-Infinity", "5rpm", "1,5", "0x10", "1e1", "0.5e1", "1_000", "５", "5\n6"]) {
      expect(g(bad), JSON.stringify(bad)).toThrow(EvalRpmError);
    }
    expect(g("  off ")()).toBeNull();
    expect(g("OFF")()).toBeNull();
    expect(g(" 0 ")()).toBeNull();
    expect(g("00")()).toBeNull();
    expect(g("0.000")()).toBeNull();
    expect(g("")()).toBe(5);
    expect(g("   ")()).toBe(5);
    expect(g("0.5")()).toBe(0.5);
    expect(evalRpm({ AI_PROVIDER: " fake " })).toBeNull();
    expect(evalRpm({ AI_PROVIDER: "fake", EVAL_RPM: "3" })).toBe(3);
    expect(evalRpm({})).toBe(5);
    // A tiny positive rate is accepted and still produces a valid throttle (no 0-division).
    expect(() => createThrottle(g("0.001")() as number)).not.toThrow();
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

describe("S0 eval scoring integrity (B1 fixed; adversarial probes)", () => {
  const RUN_AT = "2026-10-20T00:00:00.000Z";
  // Reference Mon 2026-10-05, America/New_York. Friday = 2026-10-09.
  const TEXT = `Synthetic ${MK}. I'll send Dana the invoice on Friday. Ravi will fix the gate. We should grab lunch sometime. Let us repaint the shed.`;
  const Q = { invoice: "I'll send Dana the invoice on Friday.", gate: "Ravi will fix the gate.", lunch: "We should grab lunch sometime.", shed: "Let us repaint the shed." };
  const G = {
    invoice: { type: "commitment", owner: "user", quote: Q.invoice, due_date: "2026-10-09", band: "high", due_certainty: "explicit", certainty: "explicit" },
    gate: { type: "commitment", owner: "other", quote: Q.gate, due_date: null, band: "high", due_certainty: "none", certainty: "explicit" },
    lunch: { type: "intention", owner: "user", quote: Q.lunch, due_date: null, band: "low", due_certainty: "none", certainty: "speculative" },
    shed: { type: "intention", owner: "user", quote: Q.shed, due_date: null, band: "low", due_certainty: "none", certainty: "speculative" },
  };
  const it_ = (quote: string, o: Partial<Item> = {}): Item => ({
    type: "commitment", title: "Synthetic item", owner: "user", counterparty: null, action: null, date_text: null, date_iso: null,
    amount_text: null, certainty: "explicit", uncertainty_notes: [], matches_thread_id: null, evidence: [{ quote, speaker: null }], ...o,
  });
  const invoiceOk = () => it_(Q.invoice, { date_text: "on Friday", date_iso: "2026-10-09" });
  const perfect = () => [invoiceOk(), it_(Q.gate, { owner: "other" }), it_(Q.lunch, { type: "intention", certainty: "speculative" })];
  const recorded = (byText: Record<string, Item[]>) =>
    createRecordedModel({
      recordings: Object.entries(byText).map(([input, items], i) => ({
        name: `r${i}`, task: "extract" as const, input, responses: [Extraction.parse({ source_summary: "Synthetic", participants: [], items, brief: null })],
      })),
    });
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "le-s0t-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = (name: string, items: unknown[], o: { text?: string; ambiguous?: boolean } = {}) => {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "input.txt"), o.text ?? TEXT);
    writeFileSync(join(dir, name, "meta.json"), JSON.stringify({ reference_date: "2026-10-05", timezone: "America/New_York", user: { display_name: "Sam", aliases: [] }, ambiguous: o.ambiguous ?? true }));
    writeFileSync(join(dir, name, "expected.json"), JSON.stringify({ items }));
  };
  const run = (model: Parameters<typeof runEval>[0]["model"]) => runEval({ fixturesDir: dir, model, modelLabel: "fake:t", runAt: RUN_AT });
  const clean = (r: Awaited<ReturnType<typeof runEval>>) => {
    const out = JSON.stringify(r) + renderScorecard(r);
    expect(out).not.toMatch(/MK-7Q|invoice|Dana|Ravi|the gate|lunch|\{broken/);
    for (const q of Object.values(Q)) expect(out).not.toContain(q);
  };

  it("B1 fixed: every fixture fails (malformed) → fail, incomplete, recall 0, scorecard says FAIL", async () => {
    for (const n of ["a", "b", "c"]) fixture(n, [G.invoice]);
    const m = seq([() => textResult("{broken")]);
    const r = await run(m.model);
    expect(r.scores.extraction_failures).toBe(3);
    expect(r.scores.recall).toBe(0);
    expect(r).toMatchObject({ result: "fail", pass: false, complete: false });
    expect(renderScorecard(r)).toContain("Result: FAIL");
    expect(renderScorecard(r)).not.toContain("Result: PASS");
    clean(r);
  });

  it("sanity: the perfect model passes on this fixture", async () => {
    fixture("a", [G.invoice, G.gate, G.lunch]);
    const r = await run(recorded({ [TEXT]: perfect() }));
    expect(r.scores).toMatchObject({ recall: 1, precision: 1, date: 1, owner: 1, band: 1, speculative_scored_high: 0, explicit_dated_scored_low: 0 });
    expect(r.pass).toBe(true);
    clean(r);
  });

  it("partial failure cannot inflate: 1 perfect + 1 failed fixture → recall counts the failed goldens as missed", async () => {
    const T2 = `Synthetic second ${MK}. Ravi will fix the gate.`;
    fixture("a", [G.invoice, G.gate, G.lunch]);
    fixture("b", [G.gate], { text: T2 });
    const r = await run(recorded({ [TEXT]: perfect() })); // no recording for T2 → config failure
    expect(r.scores.recall).toBe(3 / 4);
    expect(r.scores.precision).toBe(1);
    expect(r.result).toBe("fail");
    expect(failedGates(r.fixtures, r.scores)).toEqual(expect.arrayContaining(["recall", "extraction_failures"]));
  });

  it("rule 3: a model that invents a date on a dateless golden fails the run", async () => {
    fixture("a", [G.invoice, G.gate, G.lunch]);
    const r = await run(recorded({ [TEXT]: [invoiceOk(), it_(Q.gate, { owner: "other", date_text: "Friday", date_iso: "2026-10-09" }), perfect()[2]!] }));
    // date_text "Friday" must be in the source for verifyFields to keep it; it is (in the invoice line).
    const gate = r.perFixture[0]!.items.find((i) => i.golden_index === 1)!;
    expect(gate.diffs).toContainEqual({ field: "due_date", error: "invented" });
    expect(r.scores.date).toBe(0.5);
    expect(r.pass).toBe(false);
    clean(r);
  });

  it("F19: a speculative golden (hedge-free) scored High fails the run", async () => {
    fixture("a", [G.invoice, G.gate, G.lunch, G.shed]);
    const r = await run(recorded({ [TEXT]: [...perfect(), it_(Q.shed, { certainty: "explicit" })] }));
    expect(r.perFixture[0]!.items[3]!.band).toBe("high");
    expect(r.scores.speculative_scored_high).toBe(1);
    expect(r.pass).toBe(false);
    expect(failedGates(r.fixtures, r.scores)).toContain("speculative_scored_high");
  });

  it("F19: an Ignore golden shown as High counts as speculative_scored_high", async () => {
    fixture("a", [G.invoice, G.gate, G.lunch, { ...G.shed, band: "ignore", certainty: undefined }]);
    const r = await run(recorded({ [TEXT]: [...perfect(), it_(Q.shed)] }));
    expect(r.perFixture[0]!.items[3]!.status).toBe("ignore_shown");
    expect(r.scores.speculative_scored_high).toBe(1);
    expect(r.pass).toBe(false);
  });

  it("F19: an explicit dated commitment the model drops into Ignore counts as explicit_dated_scored_low", async () => {
    fixture("a", [G.invoice, G.gate, G.lunch]);
    // speculative + exact quote + agreeing date: does it land Low? Either way (Low/Ignore) it must count.
    const r = await run(recorded({ [TEXT]: [invoiceOk(), it_(Q.gate, { owner: "other" }), perfect()[2]!].map((x, i) => (i === 0 ? { ...x, certainty: "speculative" as const, type: "intention" as const } : x)) }));
    expect(r.scores.explicit_dated_scored_low).toBe(1);
    expect(r.pass).toBe(false);
  });

  // REGRESSION GUARD (was DEFECT D-S0-1): matching was many-to-one. One shown item whose quote
  // spanned several golden sentences matched every one of them (recall 1, precision 1).
  it("one shown item spanning every golden quote must not match all of them (recall should be ≤ 1/2)", async () => {
    fixture("a", [G.invoice, G.gate], { ambiguous: false });
    const blob = `${Q.invoice} ${Q.gate}`;
    const r = await run(recorded({ [TEXT]: [it_(blob, { date_text: "on Friday", date_iso: "2026-10-09" })] }));
    expect(r.perFixture[0]!.shown).toBe(1);
    expect(r.scores.recall).toBeLessThanOrEqual(0.5);
  });

  it("fixed (D-S0-1): the blob item no longer yields recall 1 and precision 1", async () => {
    fixture("a", [G.invoice, G.gate], { ambiguous: false });
    const blob = `${Q.invoice} ${Q.gate}`;
    const r = await run(recorded({ [TEXT]: [it_(blob, { date_text: "on Friday", date_iso: "2026-10-09" })] }));
    expect(r.perFixture[0]!.shown).toBe(1);
    expect(r.scores.recall).toBeLessThanOrEqual(0.5);
    expect(r.scores.recall === 1 && r.scores.precision === 1).toBe(false);
  });

  // REGRESSION GUARD (was DEFECT D-S0-2): a short fragment contained in a golden quote matched it
  // ("contains" in either direction, no minimum overlap).
  it("a 4-character fragment quote must not count as matching a golden item", async () => {
    fixture("a", [G.gate], { ambiguous: false, text: `Synthetic ${MK}. Ravi will fix the gate.` });
    const r = await run(recorded({ [`Synthetic ${MK}. Ravi will fix the gate.`]: [it_("Ravi", { owner: "other" })] }));
    expect(r.scores.recall).toBe(0);
  });

  // REGRESSION GUARD (was DEFECT D-S0-3): duplicates of one golden all counted as true positives.
  it("the same golden item shown three times should count two extras (precision ≤ 1/3)", async () => {
    fixture("a", [G.gate], { ambiguous: false, text: `Synthetic ${MK}. Ravi will fix the gate.` });
    const g = it_(Q.gate, { owner: "other" });
    const r = await run(recorded({ [`Synthetic ${MK}. Ravi will fix the gate.`]: [g, g, g] }));
    expect(r.perFixture[0]!.shown).toBe(3);
    expect(r.scores.precision).toBeLessThanOrEqual(1 / 3);
  });

  // REGRESSION GUARD (was FINDING F-S0-4): one quota failure turned a run with a hard F19 violation
  // into "incomplete_quota" (exit 3) instead of "fail" (exit 1).
  it("quota failure + F19 violation elsewhere → fail, not incomplete_quota", async () => {
    const T2 = `Synthetic quota ${MK}.`;
    fixture("a", [G.invoice, G.gate, G.lunch]);
    fixture("b", [G.gate], { text: T2 });
    fixture("c", [G.invoice, G.gate, G.lunch, G.shed], { text: `${TEXT} C` });
    const rec = recorded({ [TEXT]: perfect(), [`${TEXT} C`]: [...perfect(), it_(Q.shed)] });
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        if (JSON.stringify(opts.prompt).includes("Synthetic quota")) throw apiErr(429);
        return (rec as unknown as { doGenerate: (o: unknown) => Promise<ReturnType<typeof textResult>> }).doGenerate(opts);
      },
    });
    const r = await run(model);
    expect(r.scores.speculative_scored_high).toBe(1);
    expect(r.pass).toBe(false);
    expect(r.result).toBe("fail");
  });
});
