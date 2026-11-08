/**
 * Lead-tester: DAILY_AI_BUDGET_USD through the REAL lib/ai/budgetDb.ts (tester-budget-live stands in
 * the admin client), and what happens when the provider's usage report or the record step goes wrong.
 * Real local Supabase; the real Google provider with `fetch` stubbed, or a mock model; never a live
 * model. Clears private.ai_spend_daily, so it only runs on an isolated stack.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateObject } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BudgetDb } from "@/lib/ai/budget";
import { withBudget } from "@/lib/ai/budget";
import { askQuestion } from "@/lib/decisions/ask";
import { retryExtraction, runExtraction, startExtraction, startUploadExtraction, type RpcDb } from "@/lib/extraction/service";

vi.mock("server-only", () => ({}));

const container = process.env.LE_S11_DB_CONTAINER ?? "";
const live = process.env.LE_SUPABASE_LIVE === "1" && container !== "" && container !== "supabase_db_loose-ends";
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const url = process.env.LE_SUPABASE_URL ?? "";
const anon = process.env.LE_SUPABASE_ANON_KEY ?? "";
const service = process.env.LE_SUPABASE_SERVICE_ROLE_KEY ?? "";
const quiet = () => undefined;
const CAP = { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "2.50" };
const EMPTY_EXTRACTION = { source_summary: "Synthetic note.", participants: [], items: [], brief: null };
const SYNTHETIC = { text: "Synthetic.", title: null, writtenOn: "2026-11-04" };
const SCHEMA = z.object({ ok: z.boolean() });

const sql = (q: string) => execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", q]).toString().trim();
const spend = () => {
  const row = sql("select cost_micros, calls from private.ai_spend_daily where day = (now() at time zone 'UTC')::date");
  if (!row) return { cost: 0, calls: 0 };
  const [cost, calls] = row.split("|");
  return { cost: Number(cost), calls: Number(calls) };
};
function google() {
  let n = 0;
  const provider = createGoogleGenerativeAI({
    apiKey: "synthetic-key",
    fetch: (async () => {
      n++;
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(EMPTY_EXTRACTION) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 2000, totalTokenCount: 3000 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  return { model: provider("gemini-3.6-flash"), requests: () => n };
}
/** A provider that breaks the usage part of its contract. */
function mock(usage: unknown, text = JSON.stringify(EMPTY_EXTRACTION)) {
  let n = 0;
  const model = new MockLanguageModelV4({
    doGenerate: (async () => {
      n++;
      return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, warnings: [], ...(usage === "omit" ? {} : { usage }) };
    }) as never,
  });
  return { model, calls: () => n };
}
const FULL = { inputTokens: { total: 1000 }, outputTokens: { total: 2000 } };
const USAGE_CASES: Array<[string, unknown]> = [
  ["usage omitted", "omit"],
  ["usage null", null],
  ["usage {}", {}],
  ["inputTokens missing", { outputTokens: { total: 2000 } }],
  ["outputTokens missing", { inputTokens: { total: 1000 } }],
];

describe.skipIf(!live)("DAILY_AI_BUDGET_USD: the real budget client, usage reports and record failures", () => {
  let admin: SupabaseClient;
  const created: string[] = [];
  const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };

  async function user(): Promise<{ id: string; db: SupabaseClient }> {
    const email = `le-test-budgets-${randomUUID().slice(0, 8)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    created.push(data.user.id);
    const db = createClient(url, anon, opts);
    const signIn = await db.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
    return { id: data.user.id, db };
  }
  async function realBudgetDb(key: string | undefined): Promise<BudgetDb> {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    return (await import("@/lib/ai/budgetDb")).serviceBudgetDb;
  }
  const paste = async (db: SupabaseClient) => {
    const s = await startExtraction(db as unknown as RpcDb, { ...SYNTHETIC, text: `Synthetic ${randomUUID()}.` }, { now: new Date(), logger: quiet });
    if (!s.ok) throw new Error("start failed");
    return s.extractionId;
  };

  beforeAll(() => {
    admin = createClient(url, service, opts);
  });
  beforeEach(() => {
    sql("delete from private.ai_spend_daily");
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  });
  afterAll(async () => {
    for (const id of created) await admin.auth.admin.deleteUser(id).catch(quiet);
    sql("delete from private.ai_spend_daily");
  });

  describe("lib/ai/budgetDb.ts", () => {
    it.each(["consume_usage", "delete_source", "auth_audit_purge", "__proto__", "constructor", "AI_BUDGET_OPEN", ""])("refuses %j, with nothing else exposed", async (fn) => {
      const db = await realBudgetDb(service);
      expect(() => db.rpc(fn as never, {})).toThrow("not a budget function");
      expect(Object.keys(db)).toEqual(["rpc"]);
    });

    it("the two budget functions work through it, and a real extraction is checked and recorded with it", async () => {
      const db = await realBudgetDb(service);
      expect((await db.rpc("ai_budget_open", { p_budget_micros: 1 })).data).toBe(true);
      const a = await user();
      const g = google();
      const id = await paste(a.db);
      expect(await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: quiet, budgetDb: db, env: CAP })).toBe("succeeded");
      expect(g.requests()).toBe(1);
      expect(spend()).toEqual({ cost: 16_500, calls: 1 });
    });

    it("no service key: paste, upload and Try again say save_failed, Ask why says ask_failed; no request, nothing used up, and the logs carry only a reason", async () => {
      const db = await realBudgetDb(undefined);
      const a = await user();
      const logs: unknown[] = [];
      const logger = (e: string, p?: unknown) => void logs.push([e, p]);
      const code = (r: { ok: boolean }) => (r as unknown as { error: { error: { code: string; message: string } } }).error.error;

      const failed = await paste(a.db);
      sql(`update public.extractions set status = 'failed', error = 'ai_budget' where id = '${failed}'`);
      const before = (await admin.from("usage_counters").select("extractions, asks").eq("user_id", a.id).single()).data;

      const p = await startExtraction(a.db as unknown as RpcDb, SYNTHETIC, { now: new Date(), logger, budgetDb: db, env: CAP });
      expect(code(p)).toEqual({ code: "save_failed", message: "That didn't save. Try again.", retryable: true });
      const u = await startUploadExtraction(a.db as unknown as RpcDb, { sourceId: randomUUID(), text: "Synthetic.", title: null, writtenOn: null, mimeType: "text/plain", pageOffsets: null }, { now: new Date(), logger, budgetDb: db, env: CAP });
      expect(code(u).code).toBe("save_failed");
      const r = await retryExtraction(a.db as unknown as RpcDb, failed, { logger, budgetDb: db, env: CAP });
      expect(code(r).code).toBe("save_failed");

      const t = await admin.from("threads").insert({ user_id: a.id, title: "Quillfeather choice", kind: "decision", status: "resolved", resolution: "decided", resolved_at: "2026-10-18T14:05:00Z" }).select("id").single();
      await admin.from("decisions").insert({ user_id: a.id, thread_id: t.data!.id, choice: "Chose Quillfeather", reason_user: "Synthetic reason.", context_facts: [], decided_at: "2026-10-18T14:05:00Z" });
      const g = google();
      const ask = await askQuestion(a.db as unknown as RpcDb, "Why did I choose Quillfeather?", { model: g.model, modelLabel: "t", logger, budgetDb: db, env: CAP });
      expect(code(ask)).toEqual({ code: "ask_failed", message: "I couldn't answer that just now. Try asking again.", retryable: true });
      const zero = await askQuestion(a.db as unknown as RpcDb, "Why did I choose Zzyzx?", { model: g.model, modelLabel: "t", logger, budgetDb: db, env: CAP });
      expect(zero.ok && zero.view.message).toBe("I don't have a recorded decision about that.");

      // A run that started with the key present, then lost it, still makes no request.
      const running = await paste(a.db);
      expect(await runExtraction(a.db as unknown as RpcDb, running, { model: g.model, modelLabel: "t", logger, budgetDb: db, env: CAP })).toBe("failed");
      expect(g.requests()).toBe(0);

      expect((await admin.from("usage_counters").select("extractions, asks").eq("user_id", a.id).single()).data).toEqual({ extractions: (before!.extractions as number) + 1, asks: (before!.asks as number) + 1 });
      expect(spend()).toEqual({ cost: 0, calls: 0 });
      const text = JSON.stringify(logs);
      expect(logs.filter((l) => (l as [string])[0] === "ai_budget_refused").length).toBeGreaterThanOrEqual(5);
      for (const bad of ["SUPABASE_SERVICE_ROLE_KEY", "eyJ", "service_role", "    at "]) expect(text, bad).not.toContain(bad);
      expect(text).toContain('"reason":"check_failed"');
    });
  });

  describe("(a) a provider that omits usage", () => {
    it.each(USAGE_CASES)("MEASURE, %s: without the budget wrapper", async (name, usage) => {
      const m = mock(usage, '{"ok":true}');
      const out = await generateObject({ model: m.model, schema: SCHEMA, prompt: "Synthetic", maxRetries: 0 }).then(
        (r) => `returned ${JSON.stringify(r.object)}`,
        (e: Error) => `threw ${e.name}: ${e.message.slice(0, 90)}`,
      );
      process.stderr.write(`USAGE baseline, ${name}: ${out}\n`);
    });

    it.each(USAGE_CASES)("MEASURE, %s: with the budget wrapper", async (name, usage) => {
      const m = mock(usage, '{"ok":true}');
      const logs: unknown[] = [];
      const model = withBudget(m.model, admin as unknown as BudgetDb, { feature: "ask", env: CAP, logger: (e, p) => void logs.push([e, p]) });
      const out = await generateObject({ model, schema: SCHEMA, prompt: "Synthetic", maxRetries: 0 }).then(
        (r) => `returned ${JSON.stringify(r.object)}`,
        (e: Error) => `threw ${e.name}: ${e.message.slice(0, 90)}`,
      );
      process.stderr.write(`USAGE budgeted, ${name}: ${out}; provider calls ${m.calls()}; spend ${JSON.stringify(spend())}; logs ${JSON.stringify(logs)}\n`);
    });

    // The SDK itself throws on such a response, so the answer is lost either way; the call is still charged.
    it("a provider that omits usage is still charged $0.20", async () => {
      const m = mock("omit", '{"ok":true}');
      const model = withBudget(m.model, admin as unknown as BudgetDb, { feature: "ask", env: CAP, logger: quiet });
      await generateObject({ model, schema: SCHEMA, prompt: "Synthetic", maxRetries: 0 }).catch(quiet);
      expect(m.calls()).toBe(1);
      expect(spend()).toEqual({ cost: 200_000, calls: 1 });
    });

    it("MEASURE: a real extraction whose provider omits usage", async () => {
      const a = await user();
      const m = mock("omit");
      const id = await paste(a.db);
      const logs: unknown[] = [];
      const outcome = await runExtraction(a.db as unknown as RpcDb, id, { model: m.model, modelLabel: "t", logger: (e, p) => void logs.push([e, p]), budgetDb: admin as unknown as BudgetDb, env: CAP });
      const row = (await admin.from("extractions").select("status, error").eq("id", id).single()).data;
      process.stderr.write(`USAGE extraction: outcome ${outcome}; provider calls ${m.calls()}; spend ${JSON.stringify(spend())}; row ${JSON.stringify(row)}; logs ${JSON.stringify(logs)}\n`);
    });

    it.each([
      ["total undefined on both", { inputTokens: { total: undefined }, outputTokens: { total: undefined } }],
      ["total undefined on input", { inputTokens: { total: undefined }, outputTokens: { total: 2000 } }],
    ] as Array<[string, unknown]>)("%s (within the provider's contract): the answer stands and $0.20 is charged", async (_n, usage) => {
      const m = mock(usage, '{"ok":true}');
      const model = withBudget(m.model, admin as unknown as BudgetDb, { feature: "ask", env: CAP, logger: quiet });
      const r = await generateObject({ model, schema: SCHEMA, prompt: "Synthetic", maxRetries: 0 });
      expect(r.object).toEqual({ ok: true });
      expect(spend()).toEqual({ cost: 200_000, calls: 1 });
    });

    it("a full usage report still charges by tokens", async () => {
      const m = mock(FULL, '{"ok":true}');
      const model = withBudget(m.model, admin as unknown as BudgetDb, { feature: "ask", env: CAP, logger: quiet });
      await generateObject({ model, schema: SCHEMA, prompt: "Synthetic", maxRetries: 0 });
      expect(spend()).toEqual({ cost: 16_500, calls: 1 });
    });
  });

  describe("(b) the record write fails while the check keeps working", () => {
    it("MEASURE: the answer stands, each failure is logged content-free, spend undercounts, and a cap below one call never closes", async () => {
      const a = await user();
      const g = google();
      const logs: unknown[] = [];
      const db: BudgetDb = {
        rpc: (fn, args) => (fn === "record_ai_cost" ? Promise.resolve({ data: null, error: { code: "XX000" } }) : admin.rpc(fn, args)) as never,
      };
      for (let i = 0; i < 5; i++) {
        const id = await paste(a.db);
        expect(await runExtraction(a.db as unknown as RpcDb, id, { model: g.model, modelLabel: "t", logger: (e, p) => void logs.push([e, p]), budgetDb: db, env: { AI_PROVIDER: "google", DAILY_AI_BUDGET_USD: "0.01" } })).toBe("succeeded");
      }
      expect(g.requests()).toBe(5);
      expect(spend()).toEqual({ cost: 0, calls: 0 });
      expect(logs.filter((l) => (l as [string])[0] === "ai_budget_record_failed")).toEqual(Array.from({ length: 5 }, () => ["ai_budget_record_failed", { feature: "extract", reason: "error" }]));
    });

    it("a record that throws is treated the same way", async () => {
      const g = google();
      const logs: unknown[] = [];
      const db: BudgetDb = {
        rpc: (fn, args) => {
          if (fn === "record_ai_cost") throw new Error("Synthetic failure");
          return admin.rpc(fn, args) as never;
        },
      };
      const model = withBudget(g.model, db, { feature: "ask", env: CAP, logger: (e, p) => void logs.push([e, p]) });
      await generateObject({ model, schema: z.object({ source_summary: z.string() }), prompt: "Synthetic", maxRetries: 0 });
      expect(logs).toEqual([["ai_budget_record_failed", { feature: "ask", reason: "error" }]]);
    });
  });

  describe("midnight and grants", () => {
    it("a call spanning midnight is charged to the day it returned on, and yesterday's row is kept", async () => {
      const a = await user();
      await admin.rpc("record_ai_cost", { p_cost_micros: 1000 });
      const g = google();
      const provider = {
        ...g,
        model: withBudget(g.model, { rpc: (fn, args) => {
          // The clock crosses midnight between the check and the record.
          if (fn === "record_ai_cost") sql("update private.ai_spend_daily set day = day - 1");
          return admin.rpc(fn, args) as never;
        } }, { feature: "ask", env: CAP, logger: quiet }),
      };
      await generateObject({ model: provider.model, schema: z.object({ source_summary: z.string() }), prompt: "Synthetic", maxRetries: 0 });
      expect(a.id).toBeTruthy();
      expect(spend()).toEqual({ cost: 16_500, calls: 1 });
      expect(sql("select cost_micros, calls from private.ai_spend_daily where day = (now() at time zone 'UTC')::date - 1")).toBe("1000|1");
    });

    it("as the API roles, the private table cannot be read, written or truncated", () => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const stmt of ["select * from private.ai_spend_daily", "insert into private.ai_spend_daily (day) values ('2020-01-01')", "update private.ai_spend_daily set cost_micros = 0", "delete from private.ai_spend_daily", "truncate private.ai_spend_daily"]) {
          let out = "";
          try {
            execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `set role ${role}; ${stmt}`], { stdio: "pipe" });
            out = "allowed";
          } catch (e) {
            out = String((e as { stderr?: Buffer }).stderr ?? "");
          }
          expect(out, `${role}: ${stmt}`).toMatch(/permission denied/);
        }
      }
    });

    it("execute on both functions: service_role only; no usage_counters columns were added", () => {
      const acl = sql("select p.proname, r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid = a.grantee where p.proname in ('ai_budget_open','record_ai_cost') and p.pronamespace = 'public'::regnamespace and a.privilege_type = 'EXECUTE' order by 1, 2");
      expect(acl.split("\n").filter((l) => !l.endsWith("|postgres"))).toEqual(["ai_budget_open|service_role", "record_ai_cost|service_role"]);
      expect(sql("select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'usage_counters' and column_name like 'ai\\_%'")).toBe("0");
    });
  });
});
