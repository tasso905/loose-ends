/**
 * Lead-tester: DAILY_AI_BUDGET_USD against a REAL local Supabase and the REAL Google provider code,
 * with `fetch` stubbed, so nothing reaches a model and "no request was made" is counted at the HTTP
 * layer. Needs an ISOLATED stack: this file clears private.ai_spend_daily, so it only runs when
 * LE_S11_DB_CONTAINER names a container that is not the shared stack's. Open defects use it.fails.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateObject, type LanguageModel } from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { budgetConfig, costMicros, withBudget } from "@/lib/ai/budget";
import { askQuestion } from "@/lib/decisions/ask";
import { retryExtraction, runExtraction, startExtraction, type RpcDb } from "@/lib/extraction/service";

const container = process.env.LE_S11_DB_CONTAINER ?? "";
const live = process.env.LE_SUPABASE_LIVE === "1" && container !== "" && container !== "supabase_db_loose-ends";
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const url = process.env.LE_SUPABASE_URL ?? "";
const anon = process.env.LE_SUPABASE_ANON_KEY ?? "";
const service = process.env.LE_SUPABASE_SERVICE_ROLE_KEY ?? "";
const now = () => new Date();
const quiet = () => undefined;
const EMPTY_EXTRACTION = { source_summary: "Synthetic note.", participants: [], items: [], brief: null };
const EMPTY_ANSWER = { answer_found: false, decision_ids: [], answer_parts: [] };
// 1,000 input, 2,000 output and 500 thinking tokens at $1.50 / $7.50 per million.
const USAGE = { promptTokenCount: 1000, candidatesTokenCount: 2000, thoughtsTokenCount: 500, totalTokenCount: 3500 };
const REAL_COST = 20_250;
const CAP = { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "2.50" };

function sql(query: string): string {
  return execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", query]).toString().trim();
}
const spend = () => {
  const row = sql("select cost_micros, calls from private.ai_spend_daily where day = (now() at time zone 'UTC')::date");
  if (!row) return { cost: 0, calls: 0 };
  const [cost, calls] = row.split("|");
  return { cost: Number(cost), calls: Number(calls) };
};

interface Reply {
  body?: unknown;
  status?: number;
  usage?: unknown;
}
/** The real provider with a counted, stubbed fetch. */
function google(reply: (n: number) => Reply | Promise<Reply>): { model: LanguageModel; requests: () => number } {
  let n = 0;
  const provider = createGoogleGenerativeAI({
    apiKey: "synthetic-key",
    fetch: (async () => {
      n++;
      const r = await reply(n);
      if (r.status && r.status !== 200) {
        return new Response(JSON.stringify({ error: { code: r.status, message: "synthetic", status: "UNAVAILABLE" } }), { status: r.status, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: typeof r.body === "string" ? r.body : JSON.stringify(r.body) }] }, finishReason: "STOP" }],
          ...(r.usage === null ? {} : { usageMetadata: r.usage ?? USAGE }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  return { model: provider("gemini-3.6-flash"), requests: () => n };
}

describe.skipIf(!live)("DAILY_AI_BUDGET_USD, attacked live", () => {
  let admin: SupabaseClient;
  const created: string[] = [];

  async function user(): Promise<{ id: string; db: SupabaseClient }> {
    const email = `le-test-budgett-${randomUUID().slice(0, 8)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    created.push(data.user.id);
    const db = createClient(url, anon, opts);
    const signIn = await db.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
    return { id: data.user.id, db };
  }
  async function paste(db: SupabaseClient, text = `Synthetic note ${randomUUID()}.`): Promise<string> {
    const s = await startExtraction(db as unknown as RpcDb, { text, title: null, writtenOn: "2026-11-04" }, { now: now(), logger: quiet });
    if (!s.ok) throw new Error(`start failed: ${s.error.error.code}`);
    return s.extractionId;
  }
  /** One thread and decision, so an ask retrieves something and reaches the model. */
  async function withDecision(id: string, word: string) {
    const t = await admin.from("threads").insert({ user_id: id, title: `${word} choice`, kind: "decision", status: "resolved", resolution: "decided", resolved_at: "2026-10-18T14:05:00Z" }).select("id").single();
    if (t.error) throw t.error;
    const d = await admin.from("decisions").insert({ user_id: id, thread_id: t.data.id, choice: `Chose ${word}`, reason_user: "Synthetic reason.", context_facts: [], decided_at: "2026-10-18T14:05:00Z" });
    if (d.error) throw d.error;
  }
  const extractionError = async (id: string) => (await admin.from("extractions").select("status, error").eq("id", id).single()).data as { status: string; error: string | null };
  const counters = async (id: string) =>
    (await admin.from("usage_counters").select("day, extractions, asks, ai_calls, ai_cost_micros").eq("user_id", id).order("day")).data ?? [];

  beforeAll(() => {
    admin = createClient(url, service, opts);
  });
  beforeEach(() => {
    sql("delete from private.ai_spend_daily");
  });
  afterAll(async () => {
    for (const id of created) await admin.auth.admin.deleteUser(id).catch(quiet);
    sql("delete from private.ai_spend_daily");
  });

  describe("one user and the global budget", () => {
    it("MEASURE: direct calls alone reach the bound of 340 calls and $68, and no model is involved", async () => {
      const a = await user();
      for (let i = 0; i < 30; i++) expect((await a.db.rpc("consume_usage", { p_kind: "extraction" })).data).toBe(true);
      for (let i = 0; i < 50; i++) expect((await a.db.rpc("consume_usage", { p_kind: "ask" })).data).toBe(true);
      expect((await a.db.rpc("consume_usage", { p_kind: "ask" })).data).toBe(false);
      for (let i = 0; i < 340; i++) expect((await a.db.rpc("record_ai_cost", { p_cost_micros: 999_999_999 })).data).toBe(true);
      expect((await a.db.rpc("record_ai_cost", { p_cost_micros: 1 })).data).toBe(false);
      expect(spend()).toEqual({ cost: 68_000_000, calls: 340 });
    }, 120_000);

    it.fails("OPEN DEFECT: a free account cannot close the $2.50 budget for everyone else with direct calls", async () => {
      const attacker = await user();
      const victim = await user();
      // Two counted extractions allow 16 records; 13 at the $0.20 clamp pass $2.50.
      await attacker.db.rpc("consume_usage", { p_kind: "extraction" });
      await attacker.db.rpc("consume_usage", { p_kind: "extraction" });
      for (let i = 0; i < 13; i++) await attacker.db.rpc("record_ai_cost", { p_cost_micros: 200_000 });
      const g = google(() => ({ body: EMPTY_EXTRACTION }));
      const id = await paste(victim.db);
      const outcome = await runExtraction(victim.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: quiet, env: CAP });
      expect(outcome).toBe("succeeded");
      expect(g.requests()).toBeGreaterThan(0);
    });

    it("MEASURE: that attack: the victim's paste fails, no request reaches the model, the attacker spent nothing", async () => {
      const attacker = await user();
      const victim = await user();
      await attacker.db.rpc("consume_usage", { p_kind: "extraction" });
      await attacker.db.rpc("consume_usage", { p_kind: "extraction" });
      for (let i = 0; i < 13; i++) await attacker.db.rpc("record_ai_cost", { p_cost_micros: 200_000 });
      expect(spend().cost).toBe(2_600_000);
      const g = google(() => ({ body: EMPTY_EXTRACTION }));
      const id = await paste(victim.db);
      expect(await runExtraction(victim.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: quiet, env: CAP })).toBe("failed");
      expect(g.requests()).toBe(0);
      expect((await extractionError(id)).error).toBe("ai_budget");
    });

    it.fails("OPEN DEFECT: a user cannot make their own real calls go unrecorded by using up their allowance at zero cost", async () => {
      const a = await user();
      const g = google(async () => {
        // While the model is working (seconds in production), the same signed-in user uses up the
        // 8 records this paste allowed, at zero cost.
        for (let i = 0; i < 8; i++) await a.db.rpc("record_ai_cost", { p_cost_micros: 0 });
        return { body: EMPTY_EXTRACTION };
      });
      const id = await paste(a.db);
      expect(await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: quiet, env: CAP })).toBe("succeeded");
      expect(g.requests()).toBe(1);
      expect(spend().cost).toBeGreaterThanOrEqual(REAL_COST);
    });

    it("MEASURE: the same bypass with a cap far below one call's cost: repeated real calls never close it", async () => {
      const a = await user();
      const low = { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "0.01" };
      const g = google(async () => {
        for (let i = 0; i < 8; i++) await a.db.rpc("record_ai_cost", { p_cost_micros: 0 });
        return { body: EMPTY_EXTRACTION };
      });
      for (let i = 0; i < 5; i++) {
        const id = await paste(a.db);
        expect(await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: quiet, env: low })).toBe("succeeded");
      }
      expect(g.requests()).toBe(5);
      expect(spend().cost).toBe(0);
    });
  });

  describe("usage_counters is not writable by users", () => {
    it("insert, update, upsert and delete through the API change nothing, on own and other rows", async () => {
      const a = await user();
      const b = await user();
      await a.db.rpc("consume_usage", { p_kind: "ask" });
      await b.db.rpc("consume_usage", { p_kind: "ask" });
      const before = { a: await counters(a.id), b: await counters(b.id) };
      const day = before.a[0]!.day as string;
      const ins = await a.db.from("usage_counters").insert({ user_id: a.id, day: "2026-01-01", extractions: 0, asks: 0 });
      const upd = await a.db.from("usage_counters").update({ extractions: 30, asks: 50, ai_calls: 0, ai_cost_micros: 0 }).eq("user_id", a.id).select();
      const ups = await a.db.from("usage_counters").upsert({ user_id: a.id, day, extractions: 9999, asks: 9999 }).select();
      const del = await a.db.from("usage_counters").delete().eq("user_id", a.id).select();
      const other = await a.db.from("usage_counters").update({ ai_calls: 999 }).eq("user_id", b.id).select();
      // The API roles keep Supabase's default table grants; RLS is what refuses: one SELECT policy and
      // no write policy. Refused writes either raise 42501 or match no rows.
      expect(ins.error?.code).toBe("42501");
      for (const r of [upd, ups, del, other]) expect(r.error?.code === "42501" || (r.data ?? []).length === 0, JSON.stringify(r)).toBe(true);
      expect(await counters(a.id)).toEqual(before.a);
      expect(await counters(b.id)).toEqual(before.b);
      expect((await a.db.from("usage_counters").select("user_id").eq("user_id", b.id)).data).toEqual([]);
      expect(sql("select policyname, cmd from pg_policies where tablename = 'usage_counters'")).toBe("usage_counters_select_own|SELECT");
      expect(sql("select relrowsecurity from pg_class where oid = 'public.usage_counters'::regclass")).toBe("t");
    });
  });

  describe("probing global spend through ai_budget_open's argument", () => {
    it.fails("OPEN DEFECT: any user cannot read the exact global spend", async () => {
      const spender = await user();
      await spender.db.rpc("consume_usage", { p_kind: "ask" });
      await spender.db.rpc("record_ai_cost", { p_cost_micros: 123_457 });
      const probe = await user();
      let lo = 0;
      let hi = 2 ** 40;
      let calls = 0;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        calls++;
        // open(x) = spend < x
        if ((await probe.db.rpc("ai_budget_open", { p_budget_micros: mid })).data === true) hi = mid;
        else lo = mid;
      }
      expect(calls).toBe(40);
      expect(lo).not.toBe(123_457);
    });

    it("the argument cannot change the budget the server applies, and is refused when negative or null", async () => {
      const a = await user();
      await a.db.rpc("consume_usage", { p_kind: "ask" });
      await a.db.rpc("record_ai_cost", { p_cost_micros: 100 });
      expect((await a.db.rpc("ai_budget_open", { p_budget_micros: 2 ** 40 })).data).toBe(true);
      const g = google(() => ({ body: EMPTY_EXTRACTION }));
      const id = await paste(a.db);
      expect(await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: quiet, env: { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "0.0001" } })).toBe("failed");
      expect(g.requests()).toBe(0);
      expect((await a.db.rpc("ai_budget_open", { p_budget_micros: -1 })).error?.code).toBe("22023");
      expect((await a.db.rpc("ai_budget_open", { p_budget_micros: null })).error?.code).toBe("22023");
    });
  });

  describe("what a refused call uses up", () => {
    const ZERO = { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "0" };

    it("MEASURE: a refused paste counts one of 30, and each Try again uses one of 3, with no request", async () => {
      const a = await user();
      const g = google(() => ({ body: EMPTY_EXTRACTION }));
      let id = await paste(a.db);
      const logs: Array<[string, unknown]> = [];
      const logger = (e: string, p?: unknown) => void logs.push([e, p]);
      expect(await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger, env: ZERO })).toBe("failed");
      for (let i = 0; i < 3; i++) {
        const r = await retryExtraction(a.db as unknown as RpcDb, id, { logger: quiet });
        expect(r.ok).toBe(true);
        id = (r as { extractionId: string }).extractionId;
        expect(await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger, env: ZERO })).toBe("failed");
      }
      const last = await retryExtraction(a.db as unknown as RpcDb, id, { logger: quiet });
      expect(last.ok).toBe(false);
      expect((last as { error: { error: { code: string } } }).error.error.code).toBe("retry_limit");
      expect(g.requests()).toBe(0);
      const [row] = await counters(a.id);
      expect(row).toMatchObject({ extractions: 1, ai_calls: 0, ai_cost_micros: 0 });
      expect(logs.filter(([e]) => e === "ai_budget_refused")).toHaveLength(4);
      expect(logs.filter(([e]) => e === "extraction_retry")).toHaveLength(0);
      expect(spend()).toEqual({ cost: 0, calls: 0 });
    });

    it("MEASURE: 30 refused pastes use the whole day, and the next paste says rate_limited", async () => {
      const a = await user();
      const g = google(() => ({ body: EMPTY_EXTRACTION }));
      for (let i = 0; i < 30; i++) {
        const id = await paste(a.db);
        await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: quiet, env: ZERO });
      }
      const s = await startExtraction(a.db as unknown as RpcDb, { text: "Synthetic.", title: null, writtenOn: "2026-11-04" }, { now: now(), logger: quiet });
      expect(s.ok).toBe(false);
      expect((s as { error: { error: { code: string } } }).error.error.code).toBe("rate_limited");
      expect(g.requests()).toBe(0);
    }, 120_000);

    it("MEASURE: a refused ask counts one of 50 and returns ask_failed with no request", async () => {
      const a = await user();
      await withDecision(a.id, "Quillfeather");
      const g = google(() => ({ body: EMPTY_ANSWER }));
      const r = await askQuestion(a.db as unknown as RpcDb, "Why did I choose Quillfeather?", { model: g.model, modelLabel: "t", logger: quiet, env: ZERO });
      expect(r.ok).toBe(false);
      expect((r as { error: { error: { code: string } } }).error.error.code).toBe("ask_failed");
      expect(g.requests()).toBe(0);
      expect((await counters(a.id))[0]).toMatchObject({ asks: 1, ai_calls: 0 });
    });

    it("a zero-match ask answers with no check, no request and no record, even at cap 0", async () => {
      const a = await user();
      const g = google(() => ({ body: EMPTY_ANSWER }));
      const r = await askQuestion(a.db as unknown as RpcDb, "Why did I choose Zzyzx?", { model: g.model, modelLabel: "t", logger: quiet, env: ZERO });
      expect(r.ok && r.view.message).toBe("I don't have a recorded decision about that.");
      expect(g.requests()).toBe(0);
      expect(spend()).toEqual({ cost: 0, calls: 0 });
    });
  });

  describe("a call spanning midnight UTC", () => {
    // The counters row moved to yesterday is what the database sees once the clock has passed
    // midnight: yesterday's usage, and no row for today.
    const pastMidnight = (id: string) => sql(`update public.usage_counters set day = day - 1 where user_id = '${id}'`);

    it.fails("OPEN DEFECT: a call that was checked before midnight and returns after it is still recorded", async () => {
      const a = await user();
      const g = google(() => {
        pastMidnight(a.id);
        return { body: EMPTY_EXTRACTION };
      });
      const id = await paste(a.db);
      expect(await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: quiet, env: CAP })).toBe("succeeded");
      expect(spend().cost).toBe(REAL_COST);
    });

    it.fails("OPEN DEFECT: Try again the next day, on a source counted the day before, is still recorded", async () => {
      const a = await user();
      const failing = google(() => ({ status: 400 }));
      const first = await paste(a.db);
      expect(await runExtraction(a.db as unknown as RpcDb, first, { model: failing.model, modelLabel: "t", logger: quiet, env: CAP })).toBe("failed");
      pastMidnight(a.id);
      const r = await retryExtraction(a.db as unknown as RpcDb, first, { logger: quiet });
      expect(r.ok).toBe(true);
      const g = google(() => ({ body: EMPTY_EXTRACTION }));
      expect(await runExtraction(a.db as unknown as RpcDb, (r as { extractionId: string }).extractionId, { model: g.model, modelLabel: "t", logger: quiet, env: CAP })).toBe("succeeded");
      expect(g.requests()).toBe(1);
      expect(spend().cost).toBe(REAL_COST);
    });

    it("the unrecorded call is at least logged, content-free", async () => {
      const a = await user();
      const logs: Array<[string, unknown]> = [];
      const g = google(() => {
        pastMidnight(a.id);
        return { body: EMPTY_EXTRACTION };
      });
      const id = await paste(a.db);
      await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: (e, p) => void logs.push([e, p]), env: CAP });
      expect(logs).toContainEqual(["ai_budget_record_failed", { feature: "extract", reason: "refused" }]);
    });

    it("yesterday's spend does not hold today's budget closed", async () => {
      const a = await user();
      await a.db.rpc("consume_usage", { p_kind: "ask" });
      await a.db.rpc("record_ai_cost", { p_cost_micros: 200_000 });
      expect((await a.db.rpc("ai_budget_open", { p_budget_micros: 200_000 })).data).toBe(false);
      sql("update private.ai_spend_daily set day = day - 1");
      expect((await a.db.rpc("ai_budget_open", { p_budget_micros: 200_000 })).data).toBe(true);
    });
  });

  describe("every attempt checks first, and cost is recorded after each call", () => {
    function traced(db: SupabaseClient, trace: string[]): RpcDb {
      return {
        rpc: (fn, args) => {
          if (fn === "ai_budget_open" || fn === "record_ai_cost") trace.push(fn);
          return db.rpc(fn, args) as unknown as PromiseLike<{ data: unknown; error: unknown }>;
        },
      };
    }

    it("extract, retry after a 503: check, request, check, request, record; the failed call records nothing", async () => {
      const a = await user();
      const trace: string[] = [];
      const g = google((n) => {
        trace.push("request");
        return n === 1 ? { status: 503 } : { body: EMPTY_EXTRACTION };
      });
      const id = await paste(a.db);
      expect(await runExtraction(traced(a.db, trace), id, { model: g.model, modelLabel: "t", logger: quiet, env: CAP })).toBe("succeeded");
      expect(trace).toEqual(["ai_budget_open", "request", "ai_budget_open", "request", "record_ai_cost"]);
      expect(spend()).toEqual({ cost: REAL_COST, calls: 1 });
    });

    it("extract, retry after malformed output: both calls are recorded, because both were paid for", async () => {
      const a = await user();
      const trace: string[] = [];
      const g = google((n) => {
        trace.push("request");
        return n === 1 ? { body: "not json" } : { body: EMPTY_EXTRACTION };
      });
      const id = await paste(a.db);
      expect(await runExtraction(traced(a.db, trace), id, { model: g.model, modelLabel: "t", logger: quiet, env: CAP })).toBe("succeeded");
      expect(trace).toEqual(["ai_budget_open", "request", "record_ai_cost", "ai_budget_open", "request", "record_ai_cost"]);
      expect(spend()).toEqual({ cost: 2 * REAL_COST, calls: 2 });
    });

    it("the cap reached by the first attempt refuses the retry, with no second request", async () => {
      const a = await user();
      const g = google(() => ({ body: "not json" }));
      const id = await paste(a.db);
      const env = { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "0.02" }; // below one call's $0.02025
      expect(await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: quiet, env })).toBe("failed");
      expect(g.requests()).toBe(1);
      expect((await extractionError(id)).error).toBe("ai_budget");
      expect(spend()).toEqual({ cost: REAL_COST, calls: 1 });
    });

    it("Ask why, retry after a 503: the same order", async () => {
      const a = await user();
      await withDecision(a.id, "Quillfeather");
      const trace: string[] = [];
      const g = google((n) => {
        trace.push("request");
        return n === 1 ? { status: 503 } : { body: EMPTY_ANSWER };
      });
      const r = await askQuestion(traced(a.db, trace), "Why did I choose Quillfeather?", { model: g.model, modelLabel: "t", logger: quiet, env: CAP });
      expect(r.ok).toBe(true);
      expect(trace).toEqual(["ai_budget_open", "request", "ai_budget_open", "request", "record_ai_cost"]);
      expect(spend()).toEqual({ cost: REAL_COST, calls: 1 });
    });

    it("real provider usage: thinking tokens are charged as output; no usage report is charged $0.20", async () => {
      const a = await user();
      const missing = google(() => ({ body: EMPTY_EXTRACTION, usage: null }));
      const id = await paste(a.db);
      expect(await runExtraction(a.db as unknown as RpcDb, id, { model: missing.model, modelLabel: "t", logger: quiet, env: CAP })).toBe("succeeded");
      expect(spend()).toEqual({ cost: 200_000, calls: 1 });
    });

    it("MEASURE: a call that throws after the request (5xx, timeout) is not recorded, on any attempt", async () => {
      const a = await user();
      const g = google(() => ({ status: 503 }));
      const id = await paste(a.db);
      expect(await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: quiet, env: CAP })).toBe("failed");
      expect(g.requests()).toBe(2);
      expect(spend()).toEqual({ cost: 0, calls: 0 });
    });
  });

  describe("fail-closed table, through the real extraction and Ask why paths", () => {
    const run = async (env: Record<string, string | undefined>) => {
      const a = await user();
      await withDecision(a.id, "Quillfeather");
      const ex = google(() => ({ body: EMPTY_EXTRACTION }));
      const id = await paste(a.db);
      const extractOutcome = await runExtraction(a.db as unknown as RpcDb, id, { model: ex.model, modelLabel: "t", logger: quiet, env });
      const ask = google(() => ({ body: EMPTY_ANSWER }));
      const asked = await askQuestion(a.db as unknown as RpcDb, "Why did I choose Quillfeather?", { model: ask.model, modelLabel: "t", logger: quiet, env });
      return { extractOutcome, askOk: asked.ok, askCode: asked.ok ? null : asked.error.error.code, requests: ex.requests() + ask.requests(), err: (await extractionError(id)).error, spend: spend() };
    };

    it.each([
      ["google + unset", { AI_PROVIDER: "google" }],
      ["google + empty", { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "" }],
      ["google + spaces", { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "   " }],
      ["other provider + unset", { AI_PROVIDER: "openai" }],
      ["google + 0", { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "0" }],
      ["google + 0.00", { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "0.00" }],
      ["fake + 0", { AI_PROVIDER: "fake", DAILY_AI_BUDGET_USD: "0" }],
      ...["abc", "-1", "1e3", "$5", "5,00", ".5", "5.", "12345678", "NaN", "Infinity", "0x10", "1.1234567"].flatMap((v) => [
        [`google + ${v}`, { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: v }] as const,
        [`fake + ${v}`, { AI_PROVIDER: "fake", DAILY_AI_BUDGET_USD: v }] as const,
      ]),
    ] as Array<[string, Record<string, string>]>)("%s: refused, no request", async (_n, env) => {
      const r = await run(env);
      expect(r).toEqual({ extractOutcome: "failed", askOk: false, askCode: "ask_failed", requests: 0, err: "ai_budget", spend: { cost: 0, calls: 0 } });
    }, 30_000);

    it("fake + unset: runs without a cap and records nothing", async () => {
      const r = await run({ AI_PROVIDER: "fake" });
      expect(r).toMatchObject({ extractOutcome: "succeeded", askOk: true, requests: 2, spend: { cost: 0, calls: 0 } });
    });

    it("a valid cap: runs, and records both calls", async () => {
      const r = await run(CAP);
      expect(r).toMatchObject({ extractOutcome: "succeeded", askOk: true, requests: 2, spend: { cost: 2 * REAL_COST, calls: 2 } });
    });

    it.each([
      ["database unreachable", () => createClient("http://127.0.0.1:9", anon, opts)],
      ["signed out (the anon key is refused)", () => createClient(url, anon, opts)],
    ] as Array<[string, () => SupabaseClient]>)("%s: the check fails, so no request", async (_n, mk) => {
      const g = google(() => ({ body: { ok: true } }));
      const logs: Array<[string, unknown]> = [];
      const model = withBudget(g.model, mk() as unknown as RpcDb, { feature: "extract", env: CAP, logger: (e, p) => void logs.push([e, p]) });
      await expect(generateObject({ model, schema: z.object({ ok: z.boolean() }), prompt: "Synthetic", maxRetries: 0 })).rejects.toMatchObject({ name: "AiBudgetError", reason: "check_failed" });
      expect(g.requests()).toBe(0);
      expect(logs).toEqual([["ai_budget_refused", { feature: "extract", reason: "check_failed" }]]);
    });

    it("the record step failing does not lose the user's answer, and is logged", async () => {
      const a = await user();
      const g = google(() => ({ body: { ok: true } }));
      const logs: Array<[string, unknown]> = [];
      const db: RpcDb = {
        rpc: (fn, args) => (fn === "record_ai_cost" ? Promise.resolve({ data: null, error: { code: "XX000" } }) : (a.db.rpc(fn, args) as unknown as PromiseLike<{ data: unknown; error: unknown }>)),
      };
      const model = withBudget(g.model, db, { feature: "ask", env: CAP, logger: (e, p) => void logs.push([e, p]) });
      const r = await generateObject({ model, schema: z.object({ ok: z.boolean() }), prompt: "Synthetic", maxRetries: 0 });
      expect(r.object).toEqual({ ok: true });
      expect(logs).toEqual([["ai_budget_record_failed", { feature: "ask", reason: "error" }]]);
    });

    it("budgetConfig: exact parsing at the edges", () => {
      expect(budgetConfig({ AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: " 2.50 " })).toEqual({ mode: "cap", budgetMicros: 2_500_000 });
      expect(budgetConfig({ AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "9999999.999999" })).toEqual({ mode: "cap", budgetMicros: 9_999_999_999_999 });
      expect(budgetConfig({ AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "0.000001" })).toEqual({ mode: "cap", budgetMicros: 1 });
      expect(budgetConfig({ DAILY_AI_BUDGET_USD: "x" })).toEqual({ mode: "refuse", reason: "invalid" });
      expect(budgetConfig({})).toEqual({ mode: "off" });
    });

    it("MEASURE: the $0.20 limit is below the worst-case call if output is not bounded", () => {
      // extract() sets no maxOutputTokens. 30,000 input tokens and 65,536 output tokens would cost $0.54.
      expect(costMicros(30_000, 65_536)).toBe(200_000);
    });
  });

  describe("record_ai_cost limits, RLS and definer", () => {
    it("forged records: over the limit is clamped; negative, null, fractional, text and overflow are refused", async () => {
      const a = await user();
      await a.db.rpc("consume_usage", { p_kind: "ask" });
      expect((await a.db.rpc("record_ai_cost", { p_cost_micros: 200_001 })).data).toBe(true);
      expect(spend()).toEqual({ cost: 200_000, calls: 1 });
      for (const v of [-1, null, 1.5, "abc", "9".repeat(40)]) {
        const r = await a.db.rpc("record_ai_cost", { p_cost_micros: v });
        expect(r.error, String(v)).not.toBeNull();
      }
      expect(spend()).toEqual({ cost: 200_000, calls: 1 });
      expect((await counters(a.id))[0]).toMatchObject({ ai_calls: 1, ai_cost_micros: 200_000 });
    });

    it("no counted usage, no record; another user's usage does not help", async () => {
      const a = await user();
      const b = await user();
      await b.db.rpc("consume_usage", { p_kind: "extraction" });
      expect((await a.db.rpc("record_ai_cost", { p_cost_micros: 1 })).data).toBe(false);
      expect(spend()).toEqual({ cost: 0, calls: 0 });
    });

    it("40 concurrent records against an allowance of 16: exactly 16 land, and the total is exact", async () => {
      const a = await user();
      await a.db.rpc("consume_usage", { p_kind: "extraction" });
      await a.db.rpc("consume_usage", { p_kind: "extraction" });
      const out = await Promise.all(Array.from({ length: 40 }, () => a.db.rpc("record_ai_cost", { p_cost_micros: 1000 })));
      expect(out.filter((r) => r.data === true)).toHaveLength(16);
      expect(spend()).toEqual({ cost: 16_000, calls: 16 });
    });

    it("the private table and clamp function are out of reach; anon can call neither function", async () => {
      const a = await user();
      const client = createClient(url, anon, opts);
      expect((await client.rpc("ai_budget_open", { p_budget_micros: 1 })).error).not.toBeNull();
      expect((await client.rpc("record_ai_cost", { p_cost_micros: 1 })).error).not.toBeNull();
      expect((await a.db.rpc("ai_max_call_cost_micros", {})).error).not.toBeNull();
      expect((await (a.db.schema("private" as never) as unknown as SupabaseClient).from("ai_spend_daily").select("*")).error).not.toBeNull();
      expect((await a.db.from("ai_spend_daily").select("*")).error).not.toBeNull();
      expect(sql("select has_table_privilege('authenticated','private.ai_spend_daily','SELECT'), has_table_privilege('anon','private.ai_spend_daily','SELECT'), has_table_privilege('service_role','private.ai_spend_daily','SELECT')")).toBe("f|f|f");
      expect(sql("select has_function_privilege('anon','public.record_ai_cost(bigint)','EXECUTE'), has_function_privilege('anon','public.ai_budget_open(bigint)','EXECUTE'), has_function_privilege('public','public.record_ai_cost(bigint)','EXECUTE'), has_function_privilege('public','public.ai_budget_open(bigint)','EXECUTE'), has_function_privilege('authenticated','private.ai_max_call_cost_micros()','EXECUTE')")).toBe("f|f|f|f|f");
    });

    it("both functions are security definer with an empty search_path", () => {
      const rows = sql("select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('ai_budget_open','record_ai_cost') order by 1");
      expect(rows.split("\n")).toEqual(['ai_budget_open|t|{"search_path=\\"\\""}', 'record_ai_cost|t|{"search_path=\\"\\""}']);
    });
  });

  describe("spend and account deletion; what the table holds", () => {
    it("spend survives deleting the account; the user's own counters go; deleting and re-registering cannot reopen the budget", async () => {
      const a = await user();
      await a.db.rpc("consume_usage", { p_kind: "ask" });
      await a.db.rpc("record_ai_cost", { p_cost_micros: 150_000 });
      const { error } = await admin.auth.admin.deleteUser(a.id);
      expect(error).toBeNull();
      expect(await counters(a.id)).toEqual([]);
      expect(spend()).toEqual({ cost: 150_000, calls: 1 });
      const b = await user();
      expect((await b.db.rpc("ai_budget_open", { p_budget_micros: 150_000 })).data).toBe(false);
    });

    it("the table holds a day, a number and a count, with no user id or content", () => {
      const cols = sql("select column_name || ':' || data_type from information_schema.columns where table_schema = 'private' and table_name = 'ai_spend_daily' order by ordinal_position");
      expect(cols.split("\n")).toEqual(["day:date", "cost_micros:bigint", "calls:integer"]);
    });
  });
});
