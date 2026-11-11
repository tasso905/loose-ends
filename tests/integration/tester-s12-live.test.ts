/**
 * Lead-tester S12 (F9: Mark waiting, Snooze, Dismiss, Back to me, Wake now, Reopen, Edit and Undo)
 * against REAL local Supabase (PostgREST, Auth, RLS, real grants, real row locks, real clock guard),
 * through the real server actions (user-scoped client replaced by a signed-in supabase-js client)
 * and direct RPC. Skipped unless LE_SUPABASE_LIVE=1. Throwaway users, synthetic text only,
 * recorded-fixture model only (no live LLM). Never resets the database.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone } from "date-fns-tz";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
const tracked = vi.hoisted(() => ({ events: [] as Array<{ userId: string; name: string; props: unknown }> }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("@/lib/analytics/track", () => ({
  track: (userId: string, name: string, props: unknown) => void tracked.events.push({ userId, name, props }),
  createTracker: () => ({ track: () => {}, trackAwaited: async () => "disabled" }),
}));

import { editAction, markWaitingAction, simpleAction, snoozeAction, undoAction } from "@/app/threads/[id]/actions";
import { createRecordedModel, Recording } from "@/lib/ai/fake";
import { readExtraction, runExtraction, startExtraction, type RpcDb } from "@/lib/extraction/service";
import { acceptProposals } from "@/lib/review/service";

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
const MIKE = Recording.parse(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "llm", "mike-email.extract.json"), "utf8")));
const quiet = () => {};
const nowIso = () => new Date().toISOString();
const TZ = "America/New_York";

type User = { id: string; client: SupabaseClient };

describe.skipIf(!live)("tester S12: thread actions on real local Supabase", () => {
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

  /** Paste the Mike email (recorded model) as `u`, accept the High proposal; returns its thread id and title. */
  async function thread(u: User): Promise<{ id: string; title: string }> {
    const s = await startExtraction(rpc(u.client), { text: MIKE.input!, title: null, writtenOn: "2026-10-05" }, { now: new Date() });
    if (!s.ok) throw new Error(`start failed: ${s.error.error.code}`);
    await runExtraction(rpc(u.client), s.extractionId, { model: createRecordedModel({ recordings: [MIKE] }), logger: quiet });
    const view = await readExtraction(rpc(u.client), s.extractionId, { now: new Date(), logger: quiet });
    const high = view!.proposals.find((p) => p.band === "high")!;
    const acc = await acceptProposals(rpc(u.client), s.extractionId, [high.id], { now: new Date(), logger: quiet });
    if (!acc.ok) throw new Error("accept failed");
    return { id: acc.created[0]!.thread_id!, title: high.payload.item.title };
  }

  const as = <T,>(u: User, fn: () => Promise<T>) => {
    current.client = u.client;
    return fn();
  };
  const row = async (id: string) => (await admin.from("threads").select("*").eq("id", id).single()).data as Record<string, unknown>;
  const events = async (id: string) => (await admin.from("thread_events").select("*").eq("thread_id", id).order("id")).data ?? [];

  beforeAll(async () => {
    e = env();
    admin = createClient(e.url, e.service, opts);
    anon = createClient(e.url, e.anon, opts);
    A = await makeUser("s12a");
    B = await makeUser("s12b");
    await admin.from("profiles").update({ timezone: TZ }).eq("id", A.id);
  }, 60_000);

  afterAll(async () => {
    for (const u of users) await admin.auth.admin.deleteUser(u.id);
  });

  beforeEach(async () => {
    tracked.events = [];
    // A Dismiss in an earlier test (e.g. the concurrent one, whichever call wins) suppresses the Mike
    // item for A, so the next paste would have no High proposal. Each test starts unsuppressed.
    await admin.from("suppressions").delete().eq("user_id", A.id);
  });

  const calls = (threadId: string): Array<[string, Record<string, unknown>]> => [
    ["thread_mark_waiting", { p_thread_id: threadId, p_from_status: "open", p_waiting_on: "X", p_expected_by: null, p_now: nowIso() }],
    ["thread_snooze", { p_thread_id: threadId, p_from_status: "open", p_until: new Date(Date.now() + 86_400_000).toISOString(), p_now: nowIso() }],
    ["thread_dismiss", { p_thread_id: threadId, p_from_status: "open", p_now: nowIso() }],
    ["thread_back_to_me", { p_thread_id: threadId, p_from_status: "waiting", p_now: nowIso() }],
    ["thread_wake", { p_thread_id: threadId, p_from_status: "snoozed", p_now: nowIso() }],
    ["thread_reopen", { p_thread_id: threadId, p_from_status: "dismissed", p_now: nowIso() }],
    ["thread_edit", { p_thread_id: threadId, p_from_status: "open", p_fields: { title: "pwned" }, p_now: nowIso() }],
  ];

  it("another user calling every new function on A's thread gets not_found; nothing changes", async () => {
    const t = await thread(A);
    const before = { thread: await row(t.id), events: await events(t.id) };
    for (const [fn, args] of calls(t.id)) {
      const { data, error } = await B.client.rpc(fn, args);
      expect(error, fn).toBeNull();
      expect(data, fn).toEqual({ ok: false, error: "not_found" });
    }
    expect({ thread: await row(t.id), events: await events(t.id) }).toEqual(before);
    expect((await admin.from("suppressions").select("suppression_hash").eq("user_id", A.id)).data).toEqual([]);
  });

  it("anon cannot execute any new function (permission denied), nor the private helpers", async () => {
    const t = await thread(A);
    for (const [fn, args] of calls(t.id)) {
      const { data, error } = await anon.rpc(fn, args);
      expect(data, fn).toBeNull();
      expect(error?.code, fn).toBe("42501");
    }
    // The private helpers are not exposed through PostgREST at all.
    const { error } = await A.client.schema("private" as "public").rpc("thread_commit", {});
    expect(error).not.toBeNull();
    expect((await row(t.id)).status).toBe("open");
  });

  it("server actions: Mark waiting stores expected_by at 23:59 local; Snooze stores 9:00 local; analytics carry ids and enums only", async () => {
    const t = await thread(A);
    const w = await as(A, () => markWaitingAction({ threadId: t.id, fromStatus: "open", waitingOn: "Mike", expectedBy: "2026-12-15" }));
    expect(w).toMatchObject({ ok: true, status: "waiting" });
    const r1 = await row(t.id);
    expect(r1.status).toBe("waiting");
    expect(formatInTimeZone(new Date(r1.expected_by as string), TZ, "yyyy-MM-dd HH:mm")).toBe("2026-12-15 23:59");

    const back = await as(A, () => simpleAction({ threadId: t.id, fromStatus: "waiting", action: "back_to_me" }));
    expect(back).toMatchObject({ ok: true, status: "open" });
    expect(await row(t.id)).toMatchObject({ status: "open", waiting_on: null, expected_by: null });

    const s = await as(A, () => snoozeAction({ threadId: t.id, fromStatus: "open", choice: { preset: "tomorrow" } }));
    expect(s).toMatchObject({ ok: true, status: "snoozed" });
    const until = new Date((await row(t.id)).snoozed_until as string);
    const tomorrowLocal = formatInTimeZone(new Date(Date.now() + 86_400_000), TZ, "yyyy-MM-dd");
    expect(formatInTimeZone(until, TZ, "yyyy-MM-dd HH:mm")).toBe(`${tomorrowLocal} 09:00`);

    const evs = tracked.events.filter((x) => x.name === "thread_action");
    expect(evs.map((x) => (x.props as { action: string }).action)).toEqual(["mark_waiting", "back_to_me", "snooze"]);
    for (const x of evs) {
      expect(Object.keys(x.props as object).sort()).toEqual(["action", "from_status", "surface", "thread_id", "to_status"]);
      const json = JSON.stringify(x.props);
      expect(json).not.toContain("Mike");
      expect(json).not.toContain(t.title);
    }
  });

  it("server action Edit stores text exactly as typed; Undo restores; analytics carry no content", async () => {
    const t = await thread(A);
    const odd = "  Ask  Mike about the proposal  ";
    const res = await as(A, () => editAction({ threadId: t.id, fromStatus: "open", fields: { title: odd } }));
    if (!res.ok || res.eventId === null) throw new Error(`edit failed: ${JSON.stringify(res)}`);
    expect((await row(t.id)).title).toBe(odd);
    expect(await as(A, () => undoAction(t.id, res.eventId!))).toEqual({ ok: true });
    expect((await row(t.id)).title).toBe(t.title);
    for (const x of tracked.events) expect(JSON.stringify(x.props)).not.toMatch(/Mike|proposal/);
    expect(tracked.events.map((x) => x.name)).toEqual(["thread_action", "undo_used"]);
    expect(tracked.events[1]!.props).toEqual({ action: "edit" });
  });

  it("server action Snooze refuses a date that is not in the future, and a stale status is invalid_transition", async () => {
    const t = await thread(A);
    const yesterday = formatInTimeZone(new Date(Date.now() - 86_400_000), TZ, "yyyy-MM-dd");
    const past = await as(A, () => snoozeAction({ threadId: t.id, fromStatus: "open", choice: { preset: "date", date: yesterday } }));
    expect(past).toMatchObject({ ok: false, field: "date", error: { code: "invalid_input", message: "Pick a date after today." } });
    const stale = await as(A, () => simpleAction({ threadId: t.id, fromStatus: "waiting", action: "back_to_me" }));
    expect(stale).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    expect((await events(t.id)).map((x) => x.type)).toEqual(["created"]);
  });

  it("concurrent Dismiss and Mark waiting on the same open thread: exactly one wins (row lock)", async () => {
    const t = await thread(A);
    const [d, w] = await Promise.all([
      A.client.rpc("thread_dismiss", { p_thread_id: t.id, p_from_status: "open", p_now: nowIso() }),
      A.client.rpc("thread_mark_waiting", { p_thread_id: t.id, p_from_status: "open", p_waiting_on: "Mike", p_expected_by: null, p_now: nowIso() }),
    ]);
    const oks = [d.data, w.data].filter((x) => (x as { ok: boolean }).ok);
    expect(oks).toHaveLength(1);
    expect([d.data, w.data]).toContainEqual({ ok: false, error: "invalid_transition" });
    expect((await events(t.id)).map((x) => x.type)).toEqual(["created", "status_changed"]);
  });

  it("B cannot undo A's Dismiss; A can; the suppression goes with it", async () => {
    const t = await thread(A);
    const d = await as(A, () => simpleAction({ threadId: t.id, fromStatus: "open", action: "dismiss" }));
    if (!d.ok || d.eventId === null) throw new Error("dismiss failed");
    expect((await admin.from("suppressions").select("reason, thread_id").eq("user_id", A.id)).data).toEqual([{ reason: "dismissed", thread_id: t.id }]);
    expect(await as(B, () => undoAction(t.id, d.eventId!))).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await as(A, () => undoAction(t.id, d.eventId!))).toEqual({ ok: true });
    // The suppression leaves this thread. Earlier tests here leave other A threads dismissed with the
    // same Mike hash, so since the D1 fix (migration 20261111090000) the row is handed to one of them
    // rather than deleted; it is deleted only when no dismissed thread carries the hash.
    const left = ((await admin.from("suppressions").select("thread_id").eq("user_id", A.id)).data ?? []) as Array<{ thread_id: string }>;
    for (const s of left) {
      expect(s.thread_id).not.toBe(t.id);
      expect((await row(s.thread_id)).status).toBe("dismissed");
    }
    expect((await row(t.id)).status).toBe("open");
  });
});
