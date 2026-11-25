/**
 * Lead-tester S14 (F4 quick add) against REAL local Supabase (PostgREST, Auth, RLS, real grants, the
 * real clock guard), through the REAL server actions `submitQuickAdd` and `undoQuickAddAction` (the
 * user-scoped server client is replaced by a supabase-js client signed in as a throwaway user) and
 * direct RPC. The model is the fake recorded provider (AI_PROVIDER=fake, tests/fixtures/llm), so no
 * live LLM is ever called. Synthetic text only. Skipped unless LE_SUPABASE_LIVE=1. Never resets the
 * database.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone } from "date-fns-tz";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
const tracked = vi.hoisted(() => ({ events: [] as Array<{ userId: string; name: string; props: Record<string, unknown> }> }));
const logs = vi.hoisted(() => ({ events: [] as Array<[string, Record<string, unknown>]> }));
const pendingAfter = vi.hoisted(() => ({ list: [] as Array<Promise<unknown>> }));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => void pendingAfter.list.push(Promise.resolve().then(fn)),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("@/lib/analytics/track", () => ({
  track: (userId: string, name: string, props: Record<string, unknown>) => void tracked.events.push({ userId, name, props }),
  createTracker: () => ({
    track: () => {},
    trackAndWait: async (userId: string, name: string, props: Record<string, unknown>) => {
      tracked.events.push({ userId, name, props });
    },
  }),
}));
vi.mock("@/lib/log", () => ({ log: (event: string, props: Record<string, unknown>) => void logs.events.push([event, props]) }));

import { submitQuickAdd, undoQuickAddAction } from "@/app/add/actions";
import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { acceptProposals } from "@/lib/review/service";
import { readExtraction, type RpcDb } from "@/lib/extraction/service";
import { markDone, undoEvent } from "@/lib/threads/service";

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
const PLUMBER = "Call the plumber about the leaking tap";
const ACME = "Acme said they'd pay the invoice by the 15th";
const MAYBE = "Maybe ask Dana about the gutters";
const MIXED = "Call the bank about the card, and maybe book a dentist visit";
const LOW = "If the parcel comes back I'll return the blender";
const UNVERIFIED = "Renew the parking permit before it lapses";
const TWO = "Water the ferns and email the landlord about the boiler";
// A timezone far from UTC, so "today in the user's timezone" is visibly not the UTC date for much of the day.
const TZ = "Pacific/Kiritimati";
const SAVE_FAILED = "That didn't save. Try again.";
const INVALID = "That change isn't possible any more. Refresh to see the latest.";

type User = { id: string; client: SupabaseClient };

function form(text: string, userId = ""): FormData {
  const f = new FormData();
  f.set("text", text);
  f.set("user_id", userId);
  return f;
}

describe.skipIf(!live)("tester S14: quick add on real local Supabase", () => {
  let e: ReturnType<typeof env>;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  const users: User[] = [];
  let A: User;
  let B: User;
  const saved = { ...process.env };

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
    await admin.from("profiles").update({ timezone: TZ }).eq("id", u.id);
    return u;
  }

  async function as(u: User, text: string) {
    current.client = u.client;
    const r = await submitQuickAdd(form(text, u.id));
    await Promise.all(pendingAfter.list.splice(0));
    return r;
  }

  const count = async (table: string, uid: string) =>
    (await admin.from(table).select("*", { count: "exact", head: true }).eq("user_id", uid)).count ?? -1;
  async function snapshot(uid: string) {
    return {
      sources: await count("sources", uid),
      threads: await count("threads", uid),
      events: await count("thread_events", uid),
      evidence: await count("evidence", uid),
      items: (await admin.from("extraction_items").select("id, review_status, thread_id").eq("user_id", uid).order("id")).data,
      usage: (await admin.from("usage_counters").select("extractions").eq("user_id", uid)).data,
    };
  }

  beforeAll(async () => {
    e = env();
    admin = createClient(e.url, e.service, opts);
    anon = createClient(e.url, e.anon, opts);
    process.env.AI_PROVIDER = "fake";
    process.env.AI_MODEL = "recorded";
    delete process.env.DAILY_AI_BUDGET_USD;
    process.env.NEXT_PUBLIC_SUPABASE_URL = e.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = e.service;
    A = await makeUser("s14a");
    B = await makeUser("s14b");
  });

  beforeEach(() => {
    tracked.events.length = 0;
    logs.events.length = 0;
    delete process.env.DAILY_AI_BUDGET_USD;
  });

  afterAll(async () => {
    for (const u of users) await admin.auth.admin.deleteUser(u.id);
    process.env = saved;
  });

  it("High item: one thread, one created event (actor ai, via auto_create), review_status auto_created; source is quick_add, written today in the user's timezone, reference_date_source user", async () => {
    const before = new Date();
    const r = await as(A, PLUMBER);
    const afterT = new Date();
    expect(r).toMatchObject({ ok: true, route: "stay" });
    if (!r.ok) throw new Error("refused");
    expect(r.created).toHaveLength(1);
    const c = r.created[0]!;
    expect(c.title).toBe(PLUMBER);

    const { data: src } = await admin.from("sources").select("kind, text_content, reference_date, reference_date_source, title").eq("user_id", A.id);
    expect(src).toHaveLength(1);
    const todays = new Set([formatInTimeZone(before, TZ, "yyyy-MM-dd"), formatInTimeZone(afterT, TZ, "yyyy-MM-dd")]);
    expect(src![0]).toMatchObject({ kind: "quick_add", text_content: PLUMBER, reference_date_source: "user", title: null });
    expect(todays.has(src![0]!.reference_date as string)).toBe(true);

    const { data: ev } = await admin.from("thread_events").select("id, actor, type, before, after").eq("thread_id", c.threadId);
    expect(ev).toHaveLength(1);
    expect(ev![0]).toMatchObject({ id: c.eventId, actor: "ai", type: "created", before: null });
    expect((ev![0]!.after as Record<string, unknown>).via).toBe("auto_create");

    const { data: item } = await admin.from("extraction_items").select("band, review_status, thread_id").eq("user_id", A.id);
    expect(item).toEqual([{ band: "high", review_status: "auto_created", thread_id: c.threadId }]);
    const { data: evid } = await admin.from("evidence").select("quote, thread_id").eq("user_id", A.id);
    expect(evid).toEqual([{ quote: PLUMBER, thread_id: c.threadId }]);

    // Analytics: IDs, enums and counts only (rule 9).
    const sub = tracked.events.find((x) => x.name === "source_submitted")!;
    expect(sub.props).toMatchObject({ kind: "quick_add" });
    for (const x of tracked.events) for (const v of Object.values(x.props)) expect(typeof v === "string" ? v.includes("plumber") : false).toBe(false);
  });

  it("the plain thread_undo cannot undo the AI's created event (D44 user-only), and B cannot undo or auto-create A's", async () => {
    const r = await as(A, PLUMBER);
    if (!r.ok) throw new Error("refused");
    const c = r.created[0]!;
    const snap = await snapshot(A.id);
    expect(await undoEvent(rpc(A.client), c.threadId, c.eventId, { now: new Date(), logger: quiet })).toMatchObject({ ok: false, code: "invalid_transition" });

    current.client = B.client;
    expect(await undoQuickAddAction([{ threadId: c.threadId, eventId: c.eventId }])).toMatchObject({ ok: false, error: { code: "not_found" } });
    const direct = await B.client.rpc("quick_add_undo", { p_thread_ids: [c.threadId], p_event_ids: [c.eventId], p_now: new Date().toISOString() });
    expect(direct.data).toEqual({ ok: false, error: "not_found" });
    const { data: ex } = await admin.from("extractions").select("id").eq("user_id", A.id).order("created_at", { ascending: false }).limit(1);
    const auto = await B.client.rpc("quick_add_auto_create", { p_extraction_id: ex![0]!.id, p_now: new Date().toISOString() });
    expect(auto.data).toEqual({ ok: false, error: "not_found" });

    // anon has no EXECUTE on either function.
    const a1 = await anon.rpc("quick_add_undo", { p_thread_ids: [c.threadId], p_event_ids: [c.eventId], p_now: new Date().toISOString() });
    const a2 = await anon.rpc("quick_add_auto_create", { p_extraction_id: ex![0]!.id, p_now: new Date().toISOString() });
    expect(a1.error?.code).toBe("42501");
    expect(a2.error?.code).toBe("42501");
    expect(await snapshot(A.id)).toEqual(snap);

    // A's own Undo still works: thread and events gone, proposal rejected with its evidence, no suppression.
    current.client = A.client;
    expect(await undoQuickAddAction([{ threadId: c.threadId, eventId: c.eventId }])).toEqual({ ok: true });
    expect((await admin.from("threads").select("id").eq("id", c.threadId)).data).toEqual([]);
    expect((await admin.from("thread_events").select("id").eq("thread_id", c.threadId)).data).toEqual([]);
    const { data: items } = await admin.from("extraction_items").select("id, review_status, thread_id").eq("user_id", A.id).eq("review_status", "rejected");
    expect(items!.length).toBeGreaterThanOrEqual(1);
    expect(items!.every((i) => i.thread_id === null)).toBe(true);
    expect(await count("suppressions", A.id)).toBe(0);
    expect(tracked.events.filter((x) => x.name === "undo_used").map((x) => x.props)).toEqual([{ action: "create" }]);
  });

  it("Undo is refused after the user acted (Done), and nothing changes", async () => {
    const r = await as(A, PLUMBER);
    if (!r.ok) throw new Error("refused");
    const c = r.created[0]!;
    expect((await markDone(rpc(A.client), c.threadId, "open", { now: new Date(), logger: quiet })).ok).toBe(true);
    const snap = await snapshot(A.id);
    current.client = A.client;
    expect(await undoQuickAddAction([{ threadId: c.threadId, eventId: c.eventId }])).toEqual({
      ok: false,
      error: { code: "invalid_transition", message: INVALID, retryable: false },
    });
    expect(await snapshot(A.id)).toEqual(snap);
  });

  it("Undo is refused for a thread accepted in the review tray", async () => {
    const r = await as(A, MAYBE);
    if (!r.ok) throw new Error("refused");
    expect(r.route).toBe("review");
    const view = (await readExtraction(rpc(A.client), r.extractionId, { now: new Date(), logger: quiet }))!;
    const acc = await acceptProposals(rpc(A.client), r.extractionId, [view.proposals[0]!.id], { now: new Date(), logger: quiet });
    if (!acc.ok) throw new Error("accept failed");
    const tid = acc.created[0]!.thread_id!;
    const { data: ev } = await admin.from("thread_events").select("id").eq("thread_id", tid);
    const snap = await snapshot(A.id);
    current.client = A.client;
    expect(await undoQuickAddAction([{ threadId: tid, eventId: Number(ev![0]!.id) }])).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    expect(await snapshot(A.id)).toEqual(snap);
  });

  it("Undo is refused after 30 s (real clock), and nothing changes", async () => {
    const r = await as(A, PLUMBER);
    if (!r.ok) throw new Error("refused");
    const c = r.created[0]!;
    await new Promise((res) => setTimeout(res, 30_600));
    const snap = await snapshot(A.id);
    current.client = A.client;
    expect(await undoQuickAddAction([{ threadId: c.threadId, eventId: c.eventId }])).toMatchObject({ ok: false, error: { code: "invalid_transition", message: INVALID } });
    expect(await snapshot(A.id)).toEqual(snap);
  }, 60_000);

  it("rule 2: Medium and Low stay pending, nothing auto-creates, the user is sent to review", async () => {
    for (const text of [MAYBE, LOW]) {
      const before = await count("threads", A.id);
      const r = await as(A, text);
      expect(r).toMatchObject({ ok: true, route: "review", created: [] });
      if (!r.ok) throw new Error("refused");
      const { data: items } = await admin.from("extraction_items").select("band, review_status, thread_id").eq("extraction_id", r.extractionId);
      expect(items!.length).toBe(1);
      expect(items![0]!.band).toBe(text === LOW ? "low" : "medium");
      expect(items![0]).toMatchObject({ review_status: "pending", thread_id: null });
      expect(await count("threads", A.id)).toBe(before);
    }
  });

  it("mixed: only the High item is created; the Medium stays pending; route review with the created ids for the toast", async () => {
    const r = await as(A, MIXED);
    expect(r).toMatchObject({ ok: true, route: "review" });
    if (!r.ok) throw new Error("refused");
    expect(r.created.map((c) => c.title)).toEqual(["Call the bank about the card"]);
    const { data: items } = await admin.from("extraction_items").select("band, review_status").eq("extraction_id", r.extractionId).order("item_index");
    expect(items).toEqual([
      { band: "high", review_status: "auto_created" },
      { band: "medium", review_status: "pending" },
    ]);
  });

  it("two High items: both created, one toast count, Undo removes both at once", async () => {
    const r = await as(A, TWO);
    expect(r).toMatchObject({ ok: true, route: "stay" });
    if (!r.ok) throw new Error("refused");
    expect(r.created).toHaveLength(2);
    current.client = A.client;
    expect(await undoQuickAddAction(r.created.map((c) => ({ threadId: c.threadId, eventId: c.eventId })))).toEqual({ ok: true });
    for (const c of r.created) expect((await admin.from("threads").select("id").eq("id", c.threadId)).data).toEqual([]);
  });

  it("rule 3 / D63: Acme's promise is a Waiting thread on Acme, expected by the 15th re-resolved by chrono", async () => {
    const r = await as(A, ACME);
    if (!r.ok) throw new Error("refused");
    expect(r.created).toHaveLength(1);
    const { data: t } = await admin.from("threads").select("status, kind, waiting_on, expected_by, due_certainty").eq("id", r.created[0]!.threadId).single();
    expect(t).toMatchObject({ status: "waiting", kind: "waiting_on", waiting_on: "Acme" });
    expect(formatInTimeZone(new Date(t!.expected_by as string), TZ, "dd")).toBe("15");
  });

  it("rule 1: a High item whose quote is not in the text is dropped and logged quote_unverified; no thread", async () => {
    const before = await count("threads", A.id);
    const r = await as(A, UNVERIFIED);
    expect(r).toMatchObject({ ok: true, route: "review", created: [] });
    if (!r.ok) throw new Error("refused");
    expect((await admin.from("extraction_items").select("id").eq("extraction_id", r.extractionId)).data).toEqual([]);
    expect(logs.events.some(([ev]) => ev === "quote_unverified")).toBe(true);
    expect(await count("threads", A.id)).toBe(before);
  });

  it("input: blank and 2,001 are refused before anything is saved; wording is kept exactly; 2,000 is accepted", async () => {
    const snap = await snapshot(A.id);
    expect(await as(A, "   ")).toMatchObject({ ok: false, field: "text", error: { code: "invalid_input", retryable: false } });
    expect(await as(A, "x".repeat(2_001))).toMatchObject({ ok: false, field: "text", error: { code: "input_too_long" } });
    expect(await snapshot(A.id)).toEqual(snap);

    // No recording for these: the fake model fails, so the extraction fails and the user goes to review
    // (extraction_failed + Try again), with the text saved exactly as typed and no thread.
    const odd = "  café — Ünïcode  “quotes”  and   spaces ";
    const r1 = await as(A, odd);
    expect(r1).toMatchObject({ ok: true, route: "review", created: [] });
    if (!r1.ok) throw new Error("refused");
    const { data: s1 } = await admin.from("extractions").select("status, sources(text_content)").eq("id", r1.extractionId).single();
    expect(s1).toMatchObject({ status: "failed", sources: { text_content: odd } });

    const r2 = await as(A, "y".repeat(2_000));
    expect(r2.ok).toBe(true);
  });

  it("rate limit: at 30 extractions today the quick add is refused with the §2.13 copy and nothing is saved", async () => {
    const C = await makeUser("s14rl");
    const day = formatInTimeZone(new Date(), "UTC", "yyyy-MM-dd");
    const up = await admin.from("usage_counters").upsert({ user_id: C.id, day, extractions: 30, asks: 0 });
    expect(up.error).toBeNull();
    const snap = await snapshot(C.id);
    const r = await as(C, PLUMBER);
    expect(r).toMatchObject({ ok: false, error: { code: "rate_limited", retryable: false } });
    if (r.ok) throw new Error("accepted");
    expect(r.error.message).toMatch(/^You've reached today's limit of 30 sources\. It resets at midnight \(.+\)\.$/);
    expect(await snapshot(C.id)).toEqual(snap);
  });

  it("budget cap: DAILY_AI_BUDGET_USD=0 refuses the quick add with save_failed before anything is saved or counted", async () => {
    const D = await makeUser("s14bud");
    process.env.DAILY_AI_BUDGET_USD = "0";
    const snap = await snapshot(D.id);
    const r = await as(D, PLUMBER);
    expect(r).toEqual({ ok: false, error: { code: "save_failed", message: SAVE_FAILED, retryable: true } });
    expect(await snapshot(D.id)).toEqual(snap);
    expect(logs.events.some(([ev, p]) => ev === "ai_budget_refused" && p.reason === "exhausted")).toBe(true);
    // And a malformed cap fails closed too.
    process.env.DAILY_AI_BUDGET_USD = "lots";
    expect(await as(D, PLUMBER)).toMatchObject({ ok: false, error: { code: "save_failed" } });
    expect(await snapshot(D.id)).toEqual(snap);
  });

  it("direct RPC: auto-create and Undo are race-safe, owner-only all-or-nothing, and clock-guarded", async () => {
    const r = await as(A, TWO);
    if (!r.ok) throw new Error("refused");
    const other = await as(B, PLUMBER);
    if (!other.ok) throw new Error("refused");
    const mine = r.created[0]!;
    const theirs = other.created[0]!;
    const undo = (t: string[], ev: (number | null)[], at = new Date()) =>
      A.client.rpc("quick_add_undo", { p_thread_ids: t, p_event_ids: ev, p_now: at.toISOString() });
    const snapA = await snapshot(A.id);
    const snapB = await snapshot(B.id);
    expect((await undo([mine.threadId, theirs.threadId], [mine.eventId, theirs.eventId])).data).toEqual({ ok: false, error: "not_found" });
    expect((await undo([mine.threadId], [theirs.eventId])).data).toEqual({ ok: false, error: "invalid_transition" });
    expect((await undo([mine.threadId, mine.threadId], [mine.eventId, mine.eventId])).error?.code).toBe("22023");
    expect((await undo([], [])).error?.code).toBe("22023");
    for (const skew of [-60_000, 60_000]) {
      expect((await undo([mine.threadId], [mine.eventId], new Date(Date.now() + skew))).data).toEqual({ ok: false, error: "invalid_transition" });
      const auto = await A.client.rpc("quick_add_auto_create", { p_extraction_id: r.extractionId, p_now: new Date(Date.now() + skew).toISOString() });
      expect(auto.error?.code).toBe("22023");
    }
    // Nothing more to create, and five parallel calls create nothing twice.
    const again = await Promise.all(Array.from({ length: 5 }, () => A.client.rpc("quick_add_auto_create", { p_extraction_id: r.extractionId, p_now: new Date().toISOString() })));
    for (const x of again) expect(x.data).toEqual({ ok: true, created: [] });
    expect(await snapshot(A.id)).toEqual(snapA);
    expect(await snapshot(B.id)).toEqual(snapB);
    // Two Undos at once: exactly one removes.
    const race = await Promise.all([undo([mine.threadId], [mine.eventId]), undo([mine.threadId], [mine.eventId])]);
    expect(race.filter((x) => (x.data as { ok: boolean }).ok)).toHaveLength(1);
    expect((await admin.from("threads").select("id").eq("id", mine.threadId)).data).toEqual([]);
    // After Undo, calling auto-create again does not bring it back.
    const back = await A.client.rpc("quick_add_auto_create", { p_extraction_id: r.extractionId, p_now: new Date().toISOString() });
    expect(back.data).toEqual({ ok: true, created: [] });
  });

  it("a user cannot raise a Medium proposal to High and auto-create it (no direct write)", async () => {
    const r = await as(A, MAYBE);
    if (!r.ok) throw new Error("refused");
    await A.client.from("extraction_items").update({ band: "high" }).eq("extraction_id", r.extractionId);
    const { data } = await admin.from("extraction_items").select("band, review_status").eq("extraction_id", r.extractionId);
    expect(data).toEqual([{ band: "medium", review_status: "pending" }]);
  });

  it("every event a quick add sends passes the real allow-list, and nothing logged holds content", async () => {
    const r = await as(A, PLUMBER);
    if (!r.ok) throw new Error("refused");
    expect(await undoQuickAddAction(r.created.map((c) => ({ threadId: c.threadId, eventId: c.eventId })))).toEqual({ ok: true });
    expect(tracked.events.map((x) => x.name).sort()).toEqual(["extraction_completed", "source_submitted", "undo_used"]);
    for (const x of tracked.events) expect(ANALYTICS_EVENTS[x.name as keyof typeof ANALYTICS_EVENTS].safeParse(x.props).success, x.name).toBe(true);
    expect(JSON.stringify([tracked.events, logs.events])).not.toMatch(/plumber|leaking|tap/i);
  });

  it("the undone quick add leaves nothing behind once its source is deleted with the account", async () => {
    const Z = await makeUser("s14del");
    const r = await as(Z, TWO);
    if (!r.ok) throw new Error("refused");
    current.client = Z.client;
    expect(await undoQuickAddAction(r.created.map((c) => ({ threadId: c.threadId, eventId: c.eventId })))).toEqual({ ok: true });
    expect((await admin.auth.admin.deleteUser(Z.id)).error).toBeNull();
    for (const t of ["sources", "extractions", "extraction_items", "evidence", "threads", "thread_events"]) expect(await count(t, Z.id), t).toBe(0);
  });

  it("signed out: the action refuses before anything is saved", async () => {
    current.client = createClient(e.url, e.anon, opts);
    expect(await submitQuickAdd(form(PLUMBER))).toMatchObject({ ok: false, signedOut: true });
    expect(await undoQuickAddAction([{ threadId: randomUUID(), eventId: 1 }])).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  });
});
