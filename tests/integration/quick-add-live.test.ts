import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * S14 D2 on real local Supabase, through the real submitQuickAdd (recorded model): concurrent
 * requests with one key, as when a response is lost while the first request is still running.
 * Runs with `pnpm test:supabase` (LE_SUPABASE_* must point at an isolated stack).
 */
vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void Promise.resolve().then(fn) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
const tracked = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/analytics/track", () => ({
  track: (_u: string, event: string) => void tracked.push(event),
  createTracker: () => ({ trackAndWait: async (_u: string, event: string) => void tracked.push(event) }),
}));
import { submitQuickAdd, undoQuickAddAction } from "@/app/add/actions";

const live = process.env.LE_SUPABASE_LIVE === "1";
const PLUMBER = "Call the plumber about the leaking tap";

describe.skipIf(!live)("quick add idempotency (live)", () => {
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  let admin: SupabaseClient;
  let uid = "";
  const saved = { ...process.env };

  beforeAll(async () => {
    const url = process.env.LE_SUPABASE_URL!;
    admin = createClient(url, process.env.LE_SUPABASE_SERVICE_ROLE_KEY!, opts);
    Object.assign(process.env, { AI_PROVIDER: "fake", AI_MODEL: "recorded" });
    delete process.env.DAILY_AI_BUDGET_USD;
    const email = `le-test-qa-${randomUUID().slice(0, 6)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    uid = data.user!.id;
    const client = createClient(url, process.env.LE_SUPABASE_ANON_KEY!, opts);
    await client.auth.signInWithPassword({ email, password });
    current.client = client;
  });
  afterAll(async () => {
    if (uid) await admin.auth.admin.deleteUser(uid);
    process.env = saved;
  });

  it("five concurrent requests with one key: one source, count, extraction and thread; every answer carries the same Undo", async () => {
    const form = new FormData();
    form.set("text", PLUMBER);
    form.set("key", randomUUID());
    const results = await Promise.all(Array.from({ length: 5 }, () => submitQuickAdd(form)));
    const created = results.map((r) => (r.ok ? r.created : r));
    expect(created[0]).toMatchObject([{ title: PLUMBER }]);
    for (const c of created) expect(c).toEqual(created[0]);
    for (const r of results) expect(r).toMatchObject({ ok: true, route: "stay", undoable: true });
    const n = async (t: string) => (await admin.from(t).select("*", { count: "exact", head: true }).eq("user_id", uid)).count;
    expect([await n("sources"), await n("extractions"), await n("threads"), await n("thread_events")]).toEqual([1, 1, 1, 1]);
    expect((await admin.from("usage_counters").select("extractions").eq("user_id", uid)).data).toEqual([{ extractions: 1 }]);
    expect(tracked.filter((e) => e === "source_submitted")).toHaveLength(1);

    // A later replay: created before it arrived, so its offset is negative.
    await new Promise((r) => setTimeout(r, 1_000));
    const late = await submitQuickAdd(form);
    expect(late).toMatchObject({ ok: true, created: created[0] });
    expect(late.ok && late.createdAfterMs).toBeLessThan(-500);
    const pair = (created[0] as { threadId: string; eventId: number }[])[0]!;
    expect(await undoQuickAddAction([{ threadId: pair.threadId, eventId: pair.eventId }])).toEqual({ ok: true });
    expect(await n("threads")).toBe(0);
  });

  it("Undo at 29 s (real clock) is accepted", async () => {
    const form = new FormData();
    form.set("text", PLUMBER);
    const r = await submitQuickAdd(form);
    if (!r.ok) throw new Error("refused");
    await new Promise((res) => setTimeout(res, 29_000 - r.createdAfterMs));
    expect(await undoQuickAddAction(r.created.map((c) => ({ threadId: c.threadId, eventId: c.eventId })))).toEqual({ ok: true });
  }, 60_000);
});
