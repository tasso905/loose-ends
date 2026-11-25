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
    form.set("user_id", uid);
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

  it("D7: a form rendered for another user, or for none, is refused before anything is stored, counted or sent", async () => {
    const { data } = await admin.auth.admin.createUser({ email: `le-test-qb-${randomUUID().slice(0, 6)}@example.com`, password: `pw-${randomUUID()}`, email_confirm: true });
    const a = data.user!.id; // A's form; `uid` is signed in
    const snap = async () =>
      Promise.all(
        [uid, a].flatMap((u) =>
          ["sources", "extractions", "extraction_items", "threads", "thread_events", "usage_counters"].map(async (t) => (await admin.from(t).select("*").eq("user_id", u)).data),
        ),
      );
    try {
      const before = await snap();
      const key = randomUUID();
      const fetched = vi.spyOn(globalThis, "fetch");
      for (const user of [a, "", "not-a-user", null]) {
        const form = new FormData();
        form.set("text", PLUMBER);
        form.set("key", key);
        if (user !== null) form.set("user_id", user);
        expect(await submitQuickAdd(form)).toEqual({ ok: false, signedOut: true, error: { code: "unauthenticated", message: "Sign in to continue.", retryable: false } });
      }
      // Nothing but the session check left the action: no rpc or table, so no write, count or model call.
      const urls = fetched.mock.calls.map(([u]) => new URL(u instanceof Request ? u.url : String(u)).pathname);
      fetched.mockRestore();
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.filter((p) => !p.startsWith("/auth/v1/user"))).toEqual([]);
      expect(await snap()).toEqual(before);

      // The key was not used up: the right form with it is a first submission.
      const form = new FormData();
      form.set("text", PLUMBER);
      form.set("key", key);
      form.set("user_id", uid);
      const r = await submitQuickAdd(form);
      if (!r.ok) throw new Error("refused");
      const pairs = r.created.map((c) => ({ threadId: c.threadId, eventId: c.eventId }));
      const held = await snap();
      expect(await undoQuickAddAction(pairs, a)).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
      expect(await snap()).toEqual(held);
      expect(await undoQuickAddAction(pairs, uid)).toEqual({ ok: true });
    } finally {
      await admin.auth.admin.deleteUser(a);
    }
  });

  it("Undo at 29 s (real clock) is accepted", async () => {
    const form = new FormData();
    form.set("text", PLUMBER);
    form.set("user_id", uid);
    const r = await submitQuickAdd(form);
    if (!r.ok) throw new Error("refused");
    await new Promise((res) => setTimeout(res, 29_000 - r.createdAfterMs));
    expect(await undoQuickAddAction(r.created.map((c) => ({ threadId: c.threadId, eventId: c.eventId })))).toEqual({ ok: true });
  }, 60_000);
});
