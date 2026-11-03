/**
 * DAILY_AI_BUDGET_USD against REAL local Supabase (PostgREST, Auth, grants): a signed-in user can
 * check the budget and record a call's cost through RPC; the anon key can do neither; the global
 * spend table is not reachable through the API. Records 1 micro-dollar per call so a developer's
 * local spend is barely touched. Skipped unless LE_SUPABASE_LIVE=1 (`pnpm test:supabase`).
 * Throwaway users, no model. Never resets the database.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const live = process.env.LE_SUPABASE_LIVE === "1";
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

function env() {
  if (process.env.LE_SUPABASE_URL && process.env.LE_SUPABASE_ANON_KEY && process.env.LE_SUPABASE_SERVICE_ROLE_KEY) {
    return { url: process.env.LE_SUPABASE_URL, anon: process.env.LE_SUPABASE_ANON_KEY, service: process.env.LE_SUPABASE_SERVICE_ROLE_KEY };
  }
  const out = execSync("pnpm exec supabase status -o json", { stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).toString();
  const j = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string>;
  if (!j.API_URL || !j.ANON_KEY || !j.SERVICE_ROLE_KEY) throw new Error("Local Supabase is not running");
  return { url: j.API_URL, anon: j.ANON_KEY, service: j.SERVICE_ROLE_KEY };
}

describe.skipIf(!live)("AI budget functions on real local Supabase", () => {
  let e: ReturnType<typeof env>;
  let admin: SupabaseClient;
  let user: SupabaseClient;
  let userId = "";

  beforeAll(async () => {
    e = env();
    admin = createClient(e.url, e.service, opts);
    const email = `le-test-budget-${randomUUID().slice(0, 6)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    userId = data.user.id;
    user = createClient(e.url, e.anon, opts);
    const signIn = await user.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
  });

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  });

  it("a signed-in user records a call only after counted usage, and the budget check reads the global spend", async () => {
    expect((await user.rpc("record_ai_cost", { p_cost_micros: 1 })).data).toBe(false);
    expect((await user.rpc("consume_usage", { p_kind: "ask" })).data).toBe(true);
    expect((await user.rpc("record_ai_cost", { p_cost_micros: 1 })).data).toBe(true);
    expect((await user.rpc("ai_budget_open", { p_budget_micros: 0 })).data).toBe(false);
    expect((await user.rpc("ai_budget_open", { p_budget_micros: 1_000_000_000_000 })).data).toBe(true);
    const own = await user.from("usage_counters").select("ai_calls, ai_cost_micros");
    expect(own.data).toEqual([{ ai_calls: 1, ai_cost_micros: 1 }]);
  });

  it("refuses a negative cost", async () => {
    const { error } = await user.rpc("record_ai_cost", { p_cost_micros: -1 });
    expect(error?.code).toBe("22023");
  });

  it("the anon key can neither check nor record", async () => {
    const anon = createClient(e.url, e.anon, opts);
    expect((await anon.rpc("ai_budget_open", { p_budget_micros: 1 })).error).not.toBeNull();
    expect((await anon.rpc("record_ai_cost", { p_cost_micros: 1 })).error).not.toBeNull();
  });
});
