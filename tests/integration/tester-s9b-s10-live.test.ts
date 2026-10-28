/**
 * Lead-tester S9b ("Add a reason now", D58) and S10 (F10 Today, F8 Why) against REAL local Supabase
 * (PostgREST, Auth, RLS, real grants and row locks). Server actions run with their user-scoped client
 * replaced by a signed-in supabase-js client. Skipped unless LE_SUPABASE_LIVE=1 (`pnpm test:supabase`).
 * Throwaway users, synthetic text only, no model at all. Never resets the database.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
const tracked = vi.hoisted(() => ({ events: [] as Array<{ name: string; props: unknown }> }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("@/lib/analytics/track", () => ({
  track: (_u: string, name: string, props: unknown) => void tracked.events.push({ name, props }),
  createTracker: () => ({ track: () => {}, trackAwaited: async () => "disabled" }),
}));

import { addReasonAction } from "@/app/decisions/actions";
import { undoAction, whyAction } from "@/app/threads/[id]/actions";
import { getToday } from "@/lib/threads/today";

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

type User = { id: string; client: SupabaseClient };
const nowIso = () => new Date().toISOString();

describe.skipIf(!live)("tester S9b + S10 on real local Supabase", () => {
  let e: ReturnType<typeof env>;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  const users: User[] = [];
  let A: User;
  let B: User;

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

  async function thread(u: User, over: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await admin
      .from("threads")
      .insert({ user_id: u.id, title: `Thread ${randomUUID().slice(0, 4)}`, kind: "decision", status: "open", ...over })
      .select("id")
      .single();
    if (error) throw error;
    return data.id as string;
  }

  /** Resolve as Decided with no reason (Skip) through the real RPC; returns the decision and event ids. */
  async function decidedNoReason(u: User): Promise<{ threadId: string; decisionId: string; eventId: number }> {
    const threadId = await thread(u);
    const r = await u.client.rpc("thread_resolve", { p_thread_id: threadId, p_from_status: "open", p_resolution: "decided", p_choice: "Picked the cedar fence", p_reason: null, p_now: nowIso() });
    if (r.error || !r.data?.ok) throw new Error(`resolve failed: ${JSON.stringify(r.error ?? r.data)}`);
    const d = await admin.from("decisions").select("id").eq("thread_id", threadId).single();
    return { threadId, decisionId: d.data!.id as string, eventId: r.data.event_id as number };
  }

  const add = (u: User, id: string, reason: unknown, now = nowIso()) => u.client.rpc("decision_add_reason", { p_decision_id: id, p_reason: reason, p_now: now });
  const reasonOf = async (id: string) => (await admin.from("decisions").select("reason_user").eq("id", id).single()).data!.reason_user as string | null;
  const eventsOf = async (threadId: string) =>
    ((await admin.from("thread_events").select("id, type, actor, before, after").eq("thread_id", threadId).order("id")).data ?? []) as Array<{
      id: number; type: string; actor: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null;
    }>;

  beforeAll(async () => {
    e = env();
    process.env.NEXT_PUBLIC_SUPABASE_URL = e.url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = e.anon;
    admin = createClient(e.url, e.service, opts);
    anon = createClient(e.url, e.anon, opts);
    A = await makeUser("s9ba");
    B = await makeUser("s9bb");
  }, 60_000);

  afterAll(async () => {
    for (const u of users) await admin.auth.admin.deleteUser(u.id);
  });

  describe("decision_add_reason (D58)", () => {
    it("adds the reason byte for byte (whitespace, newlines, emoji kept), appends reason_added with before/after, leaves the thread row alone", async () => {
      const { threadId, decisionId } = await decidedNoReason(A);
      const before = (await admin.from("threads").select("*").eq("id", threadId).single()).data;
      const reason = "  Cedar lasts longer,\n\tand the 🌲 smell.  ";
      const r = await add(A, decisionId, reason);
      expect(r.error).toBeNull();
      expect(r.data).toMatchObject({ ok: true, decision_id: decisionId, thread_id: threadId, reason_user: reason });
      expect(await reasonOf(decisionId)).toBe(reason);
      const ev = (await eventsOf(threadId)).at(-1)!;
      expect(ev).toMatchObject({ type: "reason_added", actor: "user", before: { decision_id: decisionId, reason_user: null }, after: { decision_id: decisionId, reason_user: reason } });
      expect((await admin.from("threads").select("*").eq("id", threadId).single()).data).toEqual(before);
    });

    it("a second add is refused (invalid_transition), the first reason and the event count are unchanged", async () => {
      const { threadId, decisionId } = await decidedNoReason(A);
      expect((await add(A, decisionId, "First reason.")).data).toMatchObject({ ok: true });
      const n = (await eventsOf(threadId)).length;
      expect((await add(A, decisionId, "Second reason, overwriting.")).data).toEqual({ ok: false, error: "invalid_transition" });
      expect(await reasonOf(decisionId)).toBe("First reason.");
      expect((await eventsOf(threadId)).length).toBe(n);
    });

    it("two concurrent adds (two tabs): exactly one wins, the stored reason is the winner's", async () => {
      const { decisionId } = await decidedNoReason(A);
      const [r1, r2] = await Promise.all([add(A, decisionId, "Tab one."), add(A, decisionId, "Tab two.")]);
      const oks = [r1, r2].filter((r) => r.data?.ok === true);
      expect(oks).toHaveLength(1);
      expect([r1, r2].filter((r) => r.data?.error === "invalid_transition")).toHaveLength(1);
      expect(await reasonOf(decisionId)).toBe(oks[0]!.data.reason_user);
    });

    it("a decision saved WITH a reason can never be overwritten", async () => {
      const threadId = await thread(A);
      await A.client.rpc("thread_resolve", { p_thread_id: threadId, p_from_status: "open", p_resolution: "decided", p_choice: "X", p_reason: "Original words.", p_now: nowIso() });
      const id = (await admin.from("decisions").select("id").eq("thread_id", threadId).single()).data!.id as string;
      expect((await add(A, id, "Replacement.")).data).toEqual({ ok: false, error: "invalid_transition" });
      expect(await reasonOf(id)).toBe("Original words.");
    });

    it("cross-user: B adding to A's decision reads as not_found and writes nothing; B's action gets the not-found copy", async () => {
      const { threadId, decisionId } = await decidedNoReason(A);
      const n = (await eventsOf(threadId)).length;
      expect((await add(B, decisionId, "B's words in A's decision.")).data).toEqual({ ok: false, error: "not_found" });
      current.client = B.client;
      const act = await addReasonAction(decisionId, "B's words via the action.");
      expect(act).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(await reasonOf(decisionId)).toBeNull();
      expect((await eventsOf(threadId)).length).toBe(n);
    });

    it("anon cannot execute it; nobody can update decisions directly", async () => {
      const { decisionId } = await decidedNoReason(A);
      expect((await anon.rpc("decision_add_reason", { p_decision_id: decisionId, p_reason: "anon", p_now: nowIso() })).error).not.toBeNull();
      const direct = await A.client.from("decisions").update({ reason_user: "direct" }).eq("id", decisionId).select();
      expect(direct.data ?? []).toEqual([]);
      expect(await reasonOf(decisionId)).toBeNull();
    });

    it.each([
      ["empty", ""],
      ["spaces", "    "],
      ["newlines and tabs", "\n\t\r\n"],
      ["zero-width and NBSP", "​ ​"],
      ["ideographic space", "　"],
      ["2,001 characters", "r".repeat(2001)],
      ["null", null],
    ])("refuses a %s reason, writes nothing", async (_l, reason) => {
      const { decisionId } = await decidedNoReason(A);
      const r = await add(A, decisionId, reason);
      expect(r.data?.ok === true).toBe(false);
      expect(await reasonOf(decisionId)).toBeNull();
    });

    it("2,000 characters (including 1,000 emoji) is accepted verbatim", async () => {
      const { decisionId } = await decidedNoReason(A);
      const reason = "🌲".repeat(1000) + "x".repeat(1000);
      expect((await add(A, decisionId, reason)).data).toMatchObject({ ok: true });
      expect(await reasonOf(decisionId)).toBe(reason);
    });

    it("a client clock far from the server's is refused (clock guard)", async () => {
      const { decisionId } = await decidedNoReason(A);
      const r = await add(A, decisionId, "Skewed.", "2020-01-01T00:00:00Z");
      expect(r.data?.ok === true).toBe(false);
      expect(await reasonOf(decisionId)).toBeNull();
    });

    it("addReasonAction: a forged 2,001-character or blank reason gets the field copy; a valid one returns the stored text and tracks no content", async () => {
      const { decisionId } = await decidedNoReason(A);
      current.client = A.client;
      expect(await addReasonAction(decisionId, "r".repeat(2001))).toMatchObject({ ok: false, field: "reason", error: { code: "invalid_input", message: "Reasons can be up to 2,000 characters." } });
      expect(await addReasonAction(decisionId, " ​ ")).toMatchObject({ ok: false, field: "reason", error: { code: "invalid_input", message: "Write a reason first." } });
      expect(await addReasonAction("not-a-uuid", "x")).toMatchObject({ ok: false });
      tracked.events.length = 0;
      const ok = await addReasonAction(decisionId, " Verbatim, with spaces. ");
      expect(ok).toEqual({ ok: true, decisionId, reason: " Verbatim, with spaces. " });
      expect(JSON.stringify(tracked.events)).not.toContain("Verbatim");
    });
  });

  describe("Undo of a resolution after a reason was added", () => {
    it("within the 12 s window, Undo is refused once the reason was added: the thread stays resolved and the decision and reason survive", async () => {
      const { threadId, decisionId, eventId } = await decidedNoReason(A);
      expect((await add(A, decisionId, "Added within the undo window.")).data).toMatchObject({ ok: true });
      current.client = A.client;
      const undo = await undoAction(threadId, eventId);
      expect(undo).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
      const t = (await admin.from("threads").select("status, resolution").eq("id", threadId).single()).data!;
      expect(t).toEqual({ status: "resolved", resolution: "decided" });
      expect(await reasonOf(decisionId)).toBe("Added within the undo window.");
      expect((await eventsOf(threadId)).map((x) => x.type)).not.toContain("undone");
    });

    it("control: without an added reason the same Undo succeeds and deletes the decision", async () => {
      const { threadId, decisionId, eventId } = await decidedNoReason(A);
      current.client = A.client;
      expect(await undoAction(threadId, eventId)).toEqual({ ok: true });
      expect((await admin.from("decisions").select("id").eq("id", decisionId)).data).toEqual([]);
    });
  });

  describe("F10 getToday and F8 whyAction", () => {
    it("Today: own rows only, a passed snooze ranks, a future snooze is hidden, an unaccepted Low never surfaces and the chip counts only Likely/Maybe", async () => {
      const C = await makeUser("s10c");
      const D = await makeUser("s10d");
      const past = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
      const future = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
      const woke = await thread(C, { kind: "commitment", title: "Woke from snooze", status: "snoozed", snoozed_until: past(1), due_at: past(2) });
      const sleeping = await thread(C, { kind: "commitment", title: "Still snoozed", status: "snoozed", snoozed_until: future(3), due_at: past(2) });
      const lowAccepted = await thread(C, { kind: "commitment", title: "Accepted low", due_at: past(1), confidence: 0.4 });
      await thread(D, { kind: "commitment", title: "D's overdue thread", due_at: past(1) });

      const src = await admin.from("sources").insert({ user_id: C.id, kind: "paste", title: "Synthetic", text_content: "x", reference_date: "2026-10-20", reference_date_source: "user" }).select("id").single();
      const ex = await admin
        .from("extractions")
        .insert({ user_id: C.id, source_id: src.data!.id, status: "succeeded", model: "fake:recorded", prompt_version: "extract.v1", schema_version: "extraction.v1" })
        .select("id")
        .single();
      expect(ex.error).toBeNull();
      let idx = 0;
      const item = (band: string, conf: number, title: string) => ({
        item_index: idx++,
        user_id: C.id,
        extraction_id: ex.data!.id,
        band,
        confidence: conf,
        review_status: "pending",
        payload: { item: { type: "commitment", title }, label: { word: band === "high" ? "Likely" : band === "medium" ? "Maybe" : "Also noticed", reason: "synthetic" } },
      });
      const ins = await admin.from("extraction_items").insert([item("high", 0.9, "Pending high"), item("medium", 0.6, "Pending medium"), item("low", 0.3, "PENDING LOW NEVER SHOWN"), item("low", 0.2, "PENDING LOW 2")]);
      expect(ins.error).toBeNull();

      const data = (await getToday(C.client, "America/New_York", new Date()))!;
      expect(data).not.toBeNull();
      const att = data.sections.attention.map((t) => t.id);
      expect(att).toContain(woke);
      expect(att).toContain(lowAccepted);
      const everywhere = [...data.sections.attention, ...data.sections.waiting, ...data.sections.comingUp, ...data.sections.resolved];
      expect(everywhere.map((t) => t.id)).not.toContain(sleeping);
      expect(everywhere.map((t) => t.title)).not.toContain("D's overdue thread");
      expect(JSON.stringify(data)).not.toContain("PENDING LOW");
      expect(data.review).toEqual({ count: 2, extractionId: ex.data!.id });
      expect(data.reasons[woke]).toBeTruthy();
    });

    it("Today with only Low proposals pending: no chip at all", async () => {
      const E = await makeUser("s10e");
      const src = await admin.from("sources").insert({ user_id: E.id, kind: "paste", text_content: "x", reference_date: "2026-10-20", reference_date_source: "user" }).select("id").single();
      const ex = await admin.from("extractions").insert({ user_id: E.id, source_id: src.data!.id, status: "succeeded", model: "m", prompt_version: "p", schema_version: "s" }).select("id").single();
      await admin.from("extraction_items").insert({ item_index: 0, user_id: E.id, extraction_id: ex.data!.id, band: "low", confidence: 0.3, review_status: "pending", payload: { item: { type: "commitment" }, label: { word: "Also noticed", reason: "r" } } });
      expect((await getToday(E.client, "UTC", new Date()))!.review).toBeNull();
    });

    it("whyAction: another user's thread reads as not found; anonymous is unauthenticated", async () => {
      const t = await thread(A, { kind: "commitment", title: "A's private thread" });
      current.client = B.client;
      expect(await whyAction(t, "today")).toMatchObject({ ok: false, error: { code: "not_found" } });
      current.client = anon;
      expect(await whyAction(t, "today")).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
      current.client = A.client;
      const own = await whyAction(t, "today");
      expect(own).toMatchObject({ ok: true, view: { threadId: t, title: "A's private thread", quote: null } });
    });

    it("whyAction tracks only IDs and enums (rule 9)", async () => {
      const t = await thread(A, { kind: "commitment", title: "Secret title words" });
      current.client = A.client;
      tracked.events.length = 0;
      await whyAction(t, "today");
      expect(JSON.stringify(tracked.events)).not.toContain("Secret");
    });
  });
});
