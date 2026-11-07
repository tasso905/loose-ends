import { generateObject } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PGlite } from "@electric-sql/pglite";
import { AiBudgetError, withBudget, type BudgetDb } from "@/lib/ai/budget";
import { asUser, migratedDb } from "./pglite";

/**
 * DAILY_AI_BUDGET_USD on the real migrations (20261104120000_ai_budget.sql) in PGlite: the global
 * daily spend, that only the service role can reach it, and that deleting an account does not give
 * the day's spend back.
 */
const A = "00000000-0000-0000-0000-00000000000a";

let db: PGlite;

beforeEach(async () => {
  db = await migratedDb();
  await db.exec(`insert into auth.users values ('${A}', 'a@example.com', '{}');`);
});

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}
const sel = async (sql: string) => (await asService(() => db.query<{ r: unknown }>(`select ${sql} as r`))).rows[0]!.r;
const record = (micros: number) => sel(`public.record_ai_cost(${micros})`);
const open = (budget: number) => sel(`public.ai_budget_open(${budget})`);
const spend = async () =>
  (await db.query<{ cost_micros: string; calls: number }>("select cost_micros::text, calls from private.ai_spend_daily")).rows;

const budgetDb: BudgetDb = {
  async rpc(fn, args) {
    const value = fn === "ai_budget_open" ? args.p_budget_micros : args.p_cost_micros;
    return { data: await sel(`public.${fn}(${value as number})`), error: null };
  },
};

describe("record_ai_cost()", () => {
  it("adds every call to the day's total", async () => {
    expect(await record(1000)).toBe(true);
    expect(await record(234)).toBe(true);
    expect(await spend()).toEqual([{ cost_micros: "1234", calls: 2 }]);
  });

  it("records a large call in full and refuses a negative or null cost (nothing can lower the total)", async () => {
    expect(await record(540_000)).toBe(true);
    expect(await spend()).toEqual([{ cost_micros: "540000", calls: 1 }]);
    await expect(record(-5)).rejects.toThrow(/invalid cost/);
    await expect(sel("public.record_ai_cost(null)")).rejects.toThrow(/invalid cost/);
    expect(await spend()).toEqual([{ cost_micros: "540000", calls: 1 }]);
  });
});

describe("ai_budget_open()", () => {
  it("is open below the cap and closed at it", async () => {
    expect(await open(1)).toBe(true);
    await record(1000);
    expect(await open(1001)).toBe(true);
    expect(await open(1000)).toBe(false);
    expect(await open(0)).toBe(false);
  });

  it("refuses an invalid cap", async () => {
    await expect(open(-1)).rejects.toThrow(/invalid budget/);
  });
});

describe("who can reach the budget", () => {
  it.each(["authenticated", "anon"])("%s can call neither function nor read the table", async (role) => {
    await db.exec(`set role ${role}`);
    await expect(db.query("select public.ai_budget_open(1)")).rejects.toThrow(/permission denied/);
    await expect(db.query("select public.record_ai_cost(1)")).rejects.toThrow(/permission denied/);
    await expect(db.query("select * from private.ai_spend_daily")).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
    expect(await spend()).toEqual([]);
  });

  it("the signed-in user's own usage gives them no way in", async () => {
    await asUser(db, A, () => db.query("select public.consume_usage('extraction')"));
    await expect(asUser(db, A, () => db.query("select public.record_ai_cost(1)"))).rejects.toThrow(/permission denied/);
  });

  it("deleting an account (rule 8) does not give the day's global spend back", async () => {
    await asUser(db, A, () => db.query("select public.consume_usage('extraction')"));
    await record(900);
    await db.exec(`delete from auth.users where id = '${A}'`);
    expect((await db.query("select * from public.usage_counters")).rows).toEqual([]);
    expect(await spend()).toEqual([{ cost_micros: "900", calls: 1 }]);
    expect(await open(900)).toBe(false);
  });
});

describe("withBudget() over the real functions", () => {
  it("calls go through until the recorded spend reaches the cap, then are refused without a model call", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        return {
          content: [{ type: "text", text: '{"ok":true}' }],
          finishReason: { unified: "stop", raw: "stop" },
          // 10,000 input tokens at the configured price: $0.015 a call.
          usage: { inputTokens: { total: 10_000, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: undefined, reasoning: undefined } },
          warnings: [],
        };
      },
    });
    const budgeted = withBudget(model, budgetDb, { feature: "extract", env: { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "0.03" }, logger: () => {} });
    const ask = () => generateObject({ model: budgeted, schema: z.object({ ok: z.boolean() }), prompt: "Synthetic", maxRetries: 0 });
    await ask();
    await ask();
    expect(calls).toBe(2);
    await expect(ask()).rejects.toBeInstanceOf(AiBudgetError);
    expect(calls).toBe(2);
    expect(await spend()).toEqual([{ cost_micros: "30000", calls: 2 }]);
  });
});
