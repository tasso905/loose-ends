import { generateObject } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiBudgetError, budgetConfig, costMicros, MAX_CALL_COST_MICROS, PRICE_USD_PER_MTOK, withBudget } from "@/lib/ai/budget";
import { classifyAiError } from "@/lib/ai/errors";
import { extract, ExtractionFailedError } from "@/lib/ai/extract";
import { askQuestion } from "@/lib/decisions/ask";

/** DAILY_AI_BUDGET_USD (lib/ai/budget.ts): config, cost estimate, and the check/record around every call. No network. */

const CAP = { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "2.50" };
const usage = (input: number | undefined, output: number | undefined) => ({
  inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: undefined, reasoning: undefined },
});

function model(texts: string[], u = usage(1000, 500)) {
  let calls = 0;
  const m = new MockLanguageModelV4({
    doGenerate: async () => {
      const text = texts[Math.min(calls, texts.length - 1)]!;
      calls++;
      return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: u, warnings: [] };
    },
  });
  return { model: m, calls: () => calls };
}

/** An RpcDb stub: `open` answers ai_budget_open; every call is recorded. */
function db(open: unknown = true, opts: { openError?: boolean; record?: unknown; extra?: Record<string, unknown> } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "ai_budget_open") return opts.openError ? { data: null, error: { code: "XX000" } } : { data: open, error: null };
      if (fn === "record_ai_cost") return { data: opts.record ?? true, error: null };
      if (fn in (opts.extra ?? {})) return { data: opts.extra![fn], error: null };
      return { data: null, error: { code: "42883" } };
    }),
  };
}

const Schema = z.object({ ok: z.boolean() });
const call = (m: Parameters<typeof generateObject>[0]["model"]) =>
  generateObject({ model: m, schema: Schema, prompt: "Synthetic", maxRetries: 0 });

describe("budgetConfig()", () => {
  it.each([
    [{}, { mode: "off" }],
    [{ AI_PROVIDER: "fake" }, { mode: "off" }],
    [{ AI_PROVIDER: "fake", DAILY_AI_BUDGET_USD: " " }, { mode: "off" }],
    [{ AI_PROVIDER: "google" }, { mode: "refuse", reason: "unset" }],
    [{ AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "" }, { mode: "refuse", reason: "unset" }],
    [{ AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "-1" }, { mode: "refuse", reason: "invalid" }],
    [{ AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "five" }, { mode: "refuse", reason: "invalid" }],
    [{ AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "1e3" }, { mode: "refuse", reason: "invalid" }],
    [{ AI_PROVIDER: "fake", DAILY_AI_BUDGET_USD: "abc" }, { mode: "refuse", reason: "invalid" }],
    [{ AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "0" }, { mode: "cap", budgetMicros: 0 }],
    [{ AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "2.50" }, { mode: "cap", budgetMicros: 2_500_000 }],
    [{ AI_PROVIDER: "fake", DAILY_AI_BUDGET_USD: "0.000001" }, { mode: "cap", budgetMicros: 1 }],
  ])("%j → %j", (env, expected) => {
    expect(budgetConfig(env)).toEqual(expected);
  });
});

describe("costMicros()", () => {
  it("prices input and output tokens per million, rounded up", () => {
    expect(costMicros(10_000, 0)).toBe(PRICE_USD_PER_MTOK.input * 10_000);
    expect(costMicros(0, 10_000)).toBe(PRICE_USD_PER_MTOK.output * 10_000);
    expect(costMicros(10_000, 10_000)).toBe((PRICE_USD_PER_MTOK.input + PRICE_USD_PER_MTOK.output) * 10_000);
    expect(costMicros(1, 0)).toBe(1);
    expect(costMicros(0, 0)).toBe(0);
  });
  it("a missing usage report is charged the per-call maximum; nothing is charged above it", () => {
    expect(costMicros(undefined, 10)).toBe(MAX_CALL_COST_MICROS);
    expect(costMicros(10, undefined)).toBe(MAX_CALL_COST_MICROS);
    expect(costMicros(Number.NaN, 10)).toBe(MAX_CALL_COST_MICROS);
    expect(costMicros(50_000_000, 50_000_000)).toBe(MAX_CALL_COST_MICROS);
  });
  it("a real worst-case extraction stays far below the per-call maximum", () => {
    // 30,000 characters of source plus the prompt (about 12k tokens) and a long answer (8k tokens).
    expect(costMicros(12_000, 8_000)).toBeLessThan(MAX_CALL_COST_MICROS / 2);
  });
});

describe("withBudget()", () => {
  it("off (fake provider, unset): the same model, and the database is never asked", async () => {
    const m = model(['{"ok":true}']);
    const d = db();
    expect(withBudget(m.model, d, { feature: "extract", env: { AI_PROVIDER: "fake" } })).toBe(m.model);
    expect(d.rpc).not.toHaveBeenCalled();
  });

  it("open: checks with the cap in micro-dollars, calls the model, then records the estimated cost", async () => {
    const m = model(['{"ok":true}'], usage(1000, 500));
    const d = db(true);
    const res = await call(withBudget(m.model, d, { feature: "extract", env: CAP }));
    expect(res.object).toEqual({ ok: true });
    expect(m.calls()).toBe(1);
    expect(d.calls).toEqual([
      { fn: "ai_budget_open", args: { p_budget_micros: 2_500_000 } },
      { fn: "record_ai_cost", args: { p_cost_micros: costMicros(1000, 500) } },
    ]);
  });

  it("spent: no model call, nothing recorded, AiBudgetError classified as budget (not retryable), logged without content", async () => {
    const m = model(['{"ok":true}']);
    const d = db(false);
    const logger = vi.fn();
    const err = await call(withBudget(m.model, d, { feature: "ask", env: CAP, logger })).catch((e) => e);
    expect(err).toBeInstanceOf(AiBudgetError);
    expect(err.reason).toBe("exhausted");
    expect(classifyAiError(err)).toEqual({ kind: "budget", status: null, retryable: false });
    expect(m.calls()).toBe(0);
    expect(d.calls.map((c) => c.fn)).toEqual(["ai_budget_open"]);
    expect(logger).toHaveBeenCalledWith("ai_budget_refused", { feature: "ask", reason: "exhausted" });
  });

  it.each([
    ["the check errors", { openError: true }, true],
    ["the check returns a non-boolean", {}, "yes"],
  ])("fails closed when %s", async (_name, opts, open) => {
    const m = model(['{"ok":true}']);
    const err = await call(withBudget(m.model, db(open, opts), { feature: "extract", env: CAP, logger: () => {} })).catch((e) => e);
    expect(err).toBeInstanceOf(AiBudgetError);
    expect(err.reason).toBe("check_failed");
    expect(m.calls()).toBe(0);
  });

  it("fails closed when the database throws", async () => {
    const m = model(['{"ok":true}']);
    const d = { rpc: vi.fn(async () => Promise.reject(new Error("network"))) };
    const err = await call(withBudget(m.model, d, { feature: "extract", env: CAP, logger: () => {} })).catch((e) => e);
    expect(err).toMatchObject({ reason: "check_failed" });
    expect(m.calls()).toBe(0);
  });

  it.each([
    ["unset", { AI_PROVIDER: "google" }],
    ["invalid", { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "lots" }],
  ])("a live provider with the cap %s refuses every call without asking the database", async (reason, env) => {
    const m = model(['{"ok":true}']);
    const d = db(true);
    const err = await call(withBudget(m.model, d, { feature: "extract", env, logger: () => {} })).catch((e) => e);
    expect(err).toMatchObject({ name: "AiBudgetError", reason });
    expect(m.calls()).toBe(0);
    expect(d.rpc).not.toHaveBeenCalled();
  });

  it("a failed record is logged but does not take the answer away (the call already happened)", async () => {
    const m = model(['{"ok":true}']);
    const logger = vi.fn();
    const res = await call(withBudget(m.model, db(true, { record: false }), { feature: "ask", env: CAP, logger }));
    expect(res.object).toEqual({ ok: true });
    expect(logger).toHaveBeenCalledWith("ai_budget_record_failed", { feature: "ask", reason: "refused" });
  });
});

describe("extract() and askQuestion() under the budget", () => {
  const input = {
    sourceText: "Synthetic: I'll water the ferns on Friday.",
    sourceKind: "paste" as const,
    referenceDate: "2026-10-05",
    referenceDateSource: "user" as const,
    timezone: "UTC",
    user: { displayName: "Sam", aliases: [] },
  };

  it("each attempt is checked and recorded: a malformed first answer and its retry are two calls", async () => {
    const valid = JSON.stringify({ items: [], brief: null });
    const m = model(["not json", valid]);
    const d = db(true);
    await extract(input, { model: m.model, logger: () => {}, wrapModel: (x) => withBudget(x, d, { feature: "extract", env: CAP }) }).catch(() => {});
    expect(m.calls()).toBe(2);
    expect(d.calls.map((c) => c.fn)).toEqual(["ai_budget_open", "record_ai_cost", "ai_budget_open", "record_ai_cost"]);
  });

  it("spent: extract() makes no call and fails as ExtractionFailedError kind budget after one attempt (no retry)", async () => {
    const m = model(["{}"]);
    const err = await extract(input, {
      model: m.model,
      logger: () => {},
      wrapModel: (x) => withBudget(x, db(false), { feature: "extract", env: CAP, logger: () => {} }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionFailedError);
    expect(err).toMatchObject({ code: "extraction_failed", kind: "budget", attempts: 1 });
    expect(m.calls()).toBe(0);
  });

  it("spent: askQuestion() is ask_failed (D54), not rate_limited, and the model is never called", async () => {
    const m = model(["{}"]);
    const decision = {
      id: "dec-1",
      thread_id: "t-1",
      thread_title: "Synthetic",
      counterparty: null,
      choice: "Renewed",
      reason_user: "Synthetic reason",
      decided_at: "2026-10-10T00:00:00.000Z",
      context_facts: [],
    };
    const d = db(false, { extra: { consume_usage: true, search_decisions: [decision] } });
    const res = await askQuestion(d, "Why did I renew?", { model: m.model, logger: () => {}, env: CAP });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.error.code).toBe("ask_failed");
    expect(m.calls()).toBe(0);
  });
});
