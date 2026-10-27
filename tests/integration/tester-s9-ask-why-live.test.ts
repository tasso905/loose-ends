/**
 * Lead-tester S9 (F12 Ask why) attacks against REAL local Supabase (PostgREST, Auth, RLS, grants):
 * public.search_decisions across users and through the thread/counterparty join, tsquery and
 * length attacks, and askAction / askQuestion with the usage counter (zero matches count; the
 * 51st ask is refused before retrieval). Skipped unless LE_SUPABASE_LIVE=1 (`pnpm test:supabase`).
 * Throwaway users, synthetic text only, no live LLM (a spy model that fails if it is called).
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("@/lib/analytics/track", () => ({ track: () => {}, createTracker: () => ({ track: () => {}, trackAwaited: async () => "disabled" }) }));

import { askAction } from "@/app/decisions/actions";
import { NO_RECORD_MESSAGE } from "@/lib/ai/askWhy";
import { askQuestion, retrieveDecisions } from "@/lib/decisions/ask";
import type { RpcDb } from "@/lib/extraction/service";

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

const rpc = (c: SupabaseClient): RpcDb => ({ rpc: (fn, args) => c.rpc(fn, args) });
const quiet = () => {};

function spyModel() {
  const doGenerate = vi.fn(async () => {
    throw new Error("the model must not be called");
  });
  return { model: new MockLanguageModelV4({ doGenerate }), doGenerate };
}

type User = { id: string; client: SupabaseClient };

describe.skipIf(!live)("tester S9: Ask why on real local Supabase", () => {
  let e: ReturnType<typeof env>;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  const users: User[] = [];
  let A: User;
  let B: User;
  let aThread = "";
  let aDecision = "";
  let bThread = "";

  async function makeUser(tag: string): Promise<User> {
    const email = `le-test-${tag}-${randomUUID().slice(0, 6)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    const client = createClient(e.url, e.anon, opts);
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    const u = { id: data.user.id, client };
    users.push(u);
    return u;
  }

  async function seedThread(u: User, title: string, counterparty: string | null): Promise<string> {
    const { data, error } = await admin
      .from("threads")
      .insert({ user_id: u.id, title, kind: "decision", counterparty, status: "resolved", resolution: "decided", resolved_at: "2026-10-18T14:05:00Z" })
      .select("id")
      .single();
    if (error) throw error;
    return data.id as string;
  }

  async function seedDecision(u: User, threadId: string, choice: string, reason: string | null): Promise<string> {
    const { data, error } = await admin
      .from("decisions")
      .insert({ user_id: u.id, thread_id: threadId, choice, reason_user: reason, context_facts: [{ text: "Quote 4,200 dollars", evidence_id: null }], decided_at: "2026-10-18T14:05:00Z" })
      .select("id")
      .single();
    if (error) throw error;
    return data.id as string;
  }

  const search = async (u: User, q: unknown) => u.client.rpc("search_decisions", { p_question: q });
  const asksToday = async (u: User) => {
    const day = new Date().toISOString().slice(0, 10);
    const { data } = await admin.from("usage_counters").select("asks").eq("user_id", u.id).eq("day", day).maybeSingle();
    return (data?.asks as number | undefined) ?? 0;
  };

  beforeAll(async () => {
    e = env();
    process.env.NEXT_PUBLIC_SUPABASE_URL = e.url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = e.anon;
    admin = createClient(e.url, e.service, opts);
    anon = createClient(e.url, e.anon, opts);
    A = await makeUser("s9a");
    B = await makeUser("s9b");
    aThread = await seedThread(A, "Kitchen remodel contractor", "Quillfeather Builders");
    aDecision = await seedDecision(A, aThread, "Hired Quillfeather for the kitchen", "Their quote included permits and cleanup.");
    bThread = await seedThread(B, "Garden fence", null);
    await seedDecision(B, bThread, "Built a cedar fence", "Cedar lasts longer than pine.");
  }, 60_000);

  afterAll(async () => {
    for (const u of users) await admin.auth.admin.deleteUser(u.id);
  });

  describe("RLS and the thread/counterparty join (D31)", () => {
    it("A finds its decision by choice, reason, thread title and counterparty", async () => {
      for (const q of ["Why Quillfeather?", "Why did I pick that kitchen contractor?", "permits", "Why the remodel?", "Builders"]) {
        const { data, error } = await search(A, q);
        expect(error, q).toBeNull();
        expect((data as Array<{ id: string }>).map((d) => d.id), q).toContain(aDecision);
      }
    });

    it("B never sees A's decision by any of A's words (choice, reason, title, counterparty)", async () => {
      for (const q of ["Why Quillfeather?", "kitchen remodel contractor", "permits cleanup quote", "Builders", "Hired Quillfeather for the kitchen"]) {
        const { data, error } = await search(B, q);
        expect(error, q).toBeNull();
        expect(data, q).toEqual([]);
      }
    });

    it("the thread title and counterparty cannot be reached through a cross-user decision row (composite FK refuses it)", async () => {
      const ins = await admin.from("decisions").insert({ user_id: B.id, thread_id: aThread, choice: "Cedar again", reason_user: null });
      expect(ins.error).not.toBeNull();
      const { data } = await search(B, "Quillfeather kitchen remodel");
      expect(data).toEqual([]);
    });

    it("anon cannot execute it; a user cannot read decisions directly beyond their own", async () => {
      const denied = await search({ id: "", client: anon }, "Quillfeather");
      expect(denied.error).not.toBeNull();
      const direct = await B.client.from("decisions").select("id").eq("id", aDecision);
      expect(direct.data).toEqual([]);
    });

    it("the result carries only RetrievedDecision fields (no user_id, no search vector)", async () => {
      const { data } = await search(A, "Quillfeather");
      const keys = Object.keys((data as Array<Record<string, unknown>>)[0]!).sort();
      expect(keys).toEqual(["choice", "context_facts", "counterparty", "decided_at", "id", "reason_user", "thread_id", "thread_title"]);
    });
  });

  describe("tsquery and input attacks", () => {
    const hostile = [
      "!", "&", "|", ":*", "(", ")", "()", "'", "''", '"', "\\", "\\'", "!!!&&&|||", "a:* & !b", "quill:*",
      "Quillfeather & !permits", "(Quillfeather | x) & !(y)", "Quillfeather<->kitchen", "Quillfeather' | 'kitchen",
      "'; drop table public.decisions; --", "Quillfeather') or true --", "\u0000", "​​", "日本語の質問", "\u{1F600}",
      "O'Brien's quote", "it's Quillfeather's", "back\\slash Quillfeather",
    ];
    it.each(hostile.map((q) => [JSON.stringify(q), q] as const))("%s: no error, an array, at most 5 rows, only A's", async (_l, q) => {
      const { data, error } = await search(A, q);
      if (q === "\u0000") {
        // PostgREST refuses a NUL byte in text; that must be an error, never someone else's rows.
        expect(data ?? []).toEqual([]);
        return;
      }
      expect(error, q).toBeNull();
      expect(Array.isArray(data)).toBe(true);
      expect((data as unknown[]).length).toBeLessThanOrEqual(5);
      for (const d of data as Array<{ id: string }>) expect(d.id).toBe(aDecision);
    });

    it("tsquery operators are not interpreted: 'Quillfeather & !permits' still finds the decision (lexemes OR'd)", async () => {
      const { data } = await search(A, "Quillfeather & !permits");
      expect((data as Array<{ id: string }>).map((d) => d.id)).toEqual([aDecision]);
    });

    it("non-string and null input: no error, no rows", async () => {
      for (const q of [null, ""]) {
        const { data, error } = await search(A, q);
        expect(error).toBeNull();
        expect(data).toEqual([]);
      }
    });

    it("stop-words only → zero rows", async () => {
      for (const q of ["why did I do that", "the a an of to and or but", "what was it"]) {
        const { data, error } = await search(A, q);
        expect(error, q).toBeNull();
        expect(data, q).toEqual([]);
      }
    });

    it("the SQL caps the question at 300 characters: a match at characters 295–300 counts, one starting at 301 does not", async () => {
      const inside = `${"x ".repeat(144)}permits`; // 288 + 7 = 295
      expect((await search(A, inside)).data).toHaveLength(1);
      const outside = `${"x ".repeat(150)}permits`; // "permits" starts at character 301
      expect(outside.indexOf("permits")).toBe(300);
      expect((await search(A, outside)).data).toEqual([]);
    });

    it("a 100,000-character question over PostgREST: no error, only the first 300 characters searched", async () => {
      const { data, error } = await search(A, `${"y ".repeat(50_000)}Quillfeather`);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  describe("askAction / askQuestion with the real counter", () => {
    it("askAction: 301 characters refused as invalid_input before anything is counted; 300 accepted", async () => {
      current.client = A.client;
      const before = await asksToday(A);
      const r301 = await askAction("q".repeat(301));
      expect(r301).toMatchObject({ ok: false, field: "question", error: { code: "invalid_input" } });
      expect(await asksToday(A)).toBe(before);
      const r300 = await askAction("q".repeat(300)); // zero matches → no model call (fake would throw on no recording)
      expect(r300).toMatchObject({ ok: true, view: { found: false, message: NO_RECORD_MESSAGE } });
      expect(await asksToday(A)).toBe(before + 1);
    });

    it("unauthenticated askAction is refused and counts nothing", async () => {
      current.client = anon;
      const r = await askAction("Why Quillfeather?");
      expect(r).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    });

    it("zero-match asks: no model call, each counts toward the 50; the 51st is rate_limited before retrieval and the model", async () => {
      const C = await makeUser("s9c");
      await seedDecision(C, await seedThread(C, "Bike repair shop", null), "Went to Spokewise", "Closest shop.");
      const { model, doGenerate } = spyModel();
      for (let i = 1; i <= 50; i++) {
        const r = await askQuestion(rpc(C.client), "Why did I sell the piano?", { model, logger: quiet });
        expect(r, `ask ${i}`).toMatchObject({ ok: true, view: { found: false, message: NO_RECORD_MESSAGE } });
      }
      expect(doGenerate).not.toHaveBeenCalled();
      expect(await asksToday(C)).toBe(50);

      const calls: string[] = [];
      const spyDb: RpcDb = { rpc: (fn, args) => (calls.push(fn), C.client.rpc(fn, args)) };
      const r51 = await askQuestion(spyDb, "Why Spokewise?", { model, logger: quiet });
      expect(r51.ok).toBe(false);
      if (!r51.ok) expect(r51.error.error).toMatchObject({ code: "rate_limited", retryable: false });
      expect(calls).toEqual(["consume_usage"]);
      expect(doGenerate).not.toHaveBeenCalled();
      expect(await asksToday(C)).toBe(50);
    }, 120_000);

    it("a failed model call is ask_failed, still counted, and returns no view", async () => {
      const before = await asksToday(B);
      const { model, doGenerate } = spyModel();
      const r = await askQuestion(rpc(B.client), "Why the cedar fence?", { model, logger: quiet });
      expect(doGenerate).toHaveBeenCalled();
      expect(r).toEqual({ ok: false, error: { error: { code: "ask_failed", message: "I couldn't answer that just now. Try asking again.", retryable: true } } });
      expect(await asksToday(B)).toBe(before + 1);
    });

    it("retrieveDecisions as B for A's words returns [] (not null), so the answer is no-record, not ask_failed", async () => {
      expect(await retrieveDecisions(rpc(B.client), "Quillfeather kitchen")).toEqual([]);
    });
  });
});
