import { generateObject } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PGlite } from "@electric-sql/pglite";
import { AiBudgetError, withBudget } from "@/lib/ai/budget";
import { asUser, migratedDb, rpcAs } from "./pglite";

/**
 * DAILY_AI_BUDGET_USD on the real migrations (20261103090000_ai_budget.sql) in PGlite: the global
 * daily spend, the bound on what one caller can record, and that deleting an account does not
 * give the day's spend back.
 */
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

let db: PGlite;

beforeEach(async () => {
  db = await migratedDb();
  await db.exec(`insert into auth.users values ('${A}', 'a@example.com', '{}'), ('${B}', 'b@example.com', '{}');`);
});

const sel = async (uid: string, sql: string) => (await asUser(db, uid, () => db.query<{ r: unknown }>(`select ${sql} as r`))).rows[0]!.r;
const record = (uid: string, micros: number) => sel(uid, `public.record_ai_cost(${micros})`);
const open = (uid: string, budget: number) => sel(uid, `public.ai_budget_open(${budget})`);
const consume = (uid: string, kind: "extraction" | "ask") => sel(uid, `public.consume_usage('${kind}')`);
const spend = async () =>
  (await db.query<{ cost_micros: string; calls: number }>("select cost_micros::text, calls from private.ai_spend_daily")).rows;

describe("record_ai_cost()", () => {
  it("records nothing for a caller with no counted usage today", async () => {
    expect(await record(A, 100)).toBe(false);
    expect(await spend()).toEqual([]);
  });

  it("one counted extraction allows 8 model calls (4 attempts x 2); the 9th is refused", async () => {
    await consume(A, "extraction");
    for (let i = 0; i < 8; i++) expect(await record(A, 1000)).toBe(true);
    expect(await record(A, 1000)).toBe(false);
    expect(await spend()).toEqual([{ cost_micros: "8000", calls: 8 }]);
  });

  it("one counted ask allows 2 model calls", async () => {
    await consume(A, "ask");
    expect(await record(A, 10)).toBe(true);
    expect(await record(A, 10)).toBe(true);
    expect(await record(A, 10)).toBe(false);
  });

  it("clamps one call to $0.20 and refuses a negative or null cost (nothing can lower the total)", async () => {
    await consume(A, "extraction");
    expect(await record(A, 50_000_000)).toBe(true);
    expect(await spend()).toEqual([{ cost_micros: "200000", calls: 1 }]);
    await expect(record(A, -5)).rejects.toThrow(/invalid cost/);
    await expect(sel(A, "public.record_ai_cost(null)")).rejects.toThrow(/invalid cost/);
    expect(await spend()).toEqual([{ cost_micros: "200000", calls: 1 }]);
  });

  it("the caller's own share is visible to them only; they cannot write it directly", async () => {
    await consume(A, "extraction");
    await record(A, 1234);
    const own = await asUser(db, A, () => db.query<{ ai_calls: number; ai_cost_micros: string }>("select ai_calls, ai_cost_micros::text from public.usage_counters"));
    expect(own.rows).toEqual([{ ai_calls: 1, ai_cost_micros: "1234" }]);
    const other = await asUser(db, B, () => db.query("select * from public.usage_counters"));
    expect(other.rows).toEqual([]);
    await asUser(db, A, () => db.query("update public.usage_counters set ai_cost_micros = 0"));
    expect((await db.query<{ n: string }>("select ai_cost_micros::text as n from public.usage_counters")).rows).toEqual([{ n: "1234" }]);
    await expect(asUser(db, A, () => db.query("select * from private.ai_spend_daily"))).rejects.toThrow(/permission denied/);
  });
});

describe("ai_budget_open()", () => {
  it("is open below the cap and closed at it, counting every user's spend", async () => {
    await consume(A, "extraction");
    await consume(B, "ask");
    expect(await open(A, 1)).toBe(true);
    expect(await record(A, 600)).toBe(true);
    expect(await record(B, 400)).toBe(true);
    expect(await open(A, 1001)).toBe(true);
    expect(await open(A, 1000)).toBe(false);
    expect(await open(B, 1000)).toBe(false);
    expect(await open(A, 0)).toBe(false);
  });

  it("refuses an invalid cap and anonymous callers", async () => {
    await expect(open(A, -1)).rejects.toThrow(/invalid budget/);
    await db.exec("set role anon");
    await expect(db.query("select public.ai_budget_open(1)")).rejects.toThrow(/permission denied/);
    await expect(db.query("select public.record_ai_cost(1)")).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
  });

  it("deleting an account (rule 8) removes the user's own share but not the day's global spend", async () => {
    await consume(A, "extraction");
    await record(A, 900);
    await db.exec(`delete from auth.users where id = '${A}'`);
    expect((await db.query("select * from public.usage_counters")).rows).toEqual([]);
    expect(await spend()).toEqual([{ cost_micros: "900", calls: 1 }]);
    expect(await open(B, 900)).toBe(false);
  });
});

describe("withBudget() over the real functions", () => {
  it("calls go through until the recorded spend reaches the cap, then are refused without a model call", async () => {
    await consume(A, "extraction");
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        return {
          content: [{ type: "text", text: '{"ok":true}' }],
          finishReason: { unified: "stop", raw: "stop" },
          // 10,000 input tokens at the configured price: $0.01 a call.
          usage: { inputTokens: { total: 10_000, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: undefined, reasoning: undefined } },
          warnings: [],
        };
      },
    });
    const budgeted = withBudget(model, rpcAs(db, A), { feature: "extract", env: { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "0.02" }, logger: () => {} });
    const ask = () => generateObject({ model: budgeted, schema: z.object({ ok: z.boolean() }), prompt: "Synthetic", maxRetries: 0 });
    await ask();
    await ask();
    expect(calls).toBe(2);
    await expect(ask()).rejects.toBeInstanceOf(AiBudgetError);
    expect(calls).toBe(2);
    expect(await spend()).toEqual([{ cost_micros: "20000", calls: 2 }]);
  });
});
