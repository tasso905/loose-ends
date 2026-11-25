/**
 * Lead-tester S14 re-verification (D2, D4): start_quick_add / quick_add_result and submitQuickAdd's
 * idempotency key on REAL local Supabase, recorded model only. Needs LE_SUPABASE_LIVE=1 and the
 * LE_SUPABASE_* variables of an isolated stack; LE_S11_DB_CONTAINER adds checks of the private table.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
const tracked = vi.hoisted(() => [] as string[]);
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void Promise.resolve().then(fn) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("@/lib/analytics/track", () => ({
  track: (_u: string, event: string) => void tracked.push(event),
  createTracker: () => ({ track: () => {}, trackAndWait: async (_u: string, event: string) => void tracked.push(event) }),
}));
import { submitQuickAdd, undoQuickAddAction } from "@/app/add/actions";
import { EXPORT_TABLES } from "@/lib/account/export";

const live = process.env.LE_SUPABASE_LIVE === "1" && Boolean(process.env.LE_SUPABASE_URL);
const DB = process.env.LE_S11_DB_CONTAINER;
const PLUMBER = "Call the plumber about the leaking tap";
const TWO = "Water the ferns and email the landlord about the boiler";
const MAYBE = "Maybe ask Dana about the gutters";
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const psql = (q: string) => execFileSync("docker", ["exec", DB!, "psql", "-U", "postgres", "-d", "postgres", "-tAc", q], { encoding: "utf8" }).trim();

describe.skipIf(!live)("tester S14: quick-add idempotency", () => {
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  const ids: string[] = [];
  const saved = { ...process.env };
  type U = { id: string; client: SupabaseClient };
  async function user(): Promise<U> {
    const email = `le-test-idem-${randomUUID().slice(0, 8)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    const client = createClient(process.env.LE_SUPABASE_URL!, process.env.LE_SUPABASE_ANON_KEY!, opts);
    await client.auth.signInWithPassword({ email, password });
    ids.push(data.user!.id);
    current.client = client;
    return { id: data.user!.id, client };
  }
  function send(u: U, key: string | null, text = PLUMBER) {
    current.client = u.client;
    const f = new FormData();
    f.set("text", text);
    f.set("user_id", u.id);
    if (key) f.set("key", key);
    return submitQuickAdd(f);
  }
  const n = async (t: string, u: U) => (await admin.from(t).select("*", { count: "exact", head: true }).eq("user_id", u.id)).count;
  const state = async (u: U) => ({
    sources: await n("sources", u), extractions: await n("extractions", u), items: await n("extraction_items", u), threads: await n("threads", u),
    used: (await admin.from("usage_counters").select("extractions").eq("user_id", u.id)).data?.[0]?.extractions ?? 0,
  });
  const start = (c: SupabaseClient, key: string | null, over: Record<string, unknown> = {}) =>
    c.rpc("start_quick_add", {
      p_key: key, p_allow_new: true, p_text: PLUMBER, p_reference_date: "2026-11-24", p_now: new Date().toISOString(),
      p_model: "m", p_prompt_version: "p", p_schema_version: "s", ...over,
    });

  beforeAll(() => {
    admin = createClient(process.env.LE_SUPABASE_URL!, process.env.LE_SUPABASE_SERVICE_ROLE_KEY!, opts);
    anon = createClient(process.env.LE_SUPABASE_URL!, process.env.LE_SUPABASE_ANON_KEY!, opts);
    Object.assign(process.env, { AI_PROVIDER: "fake", AI_MODEL: "recorded", NEXT_PUBLIC_SUPABASE_URL: process.env.LE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.LE_SUPABASE_SERVICE_ROLE_KEY });
  });
  beforeEach(() => {
    delete process.env.DAILY_AI_BUDGET_USD;
    tracked.length = 0;
  });
  afterAll(async () => {
    for (const id of ids) await admin.auth.admin.deleteUser(id).catch(() => undefined);
    process.env = saved;
  });

  it("eight at once, two High items: one of everything, one set of analytics, every answer the same Undo", async () => {
    const u = await user();
    const key = randomUUID();
    const r = await Promise.all(Array.from({ length: 8 }, () => send(u, key, TWO)));
    for (const x of r) expect(x).toMatchObject({ ok: true, route: "stay", undoable: true });
    expect(new Set(r.map((x) => JSON.stringify(x.ok && x.created))).size).toBe(1);
    expect(await state(u)).toEqual({ sources: 1, extractions: 1, items: 2, threads: 2, used: 1 });
    expect(tracked.filter((e) => e === "source_submitted")).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 50));
    expect(tracked.filter((e) => e === "extraction_completed")).toHaveLength(1);
  });

  it("after Undo a replay brings nothing back and is not charged", async () => {
    const u = await user();
    const key = randomUUID();
    const r = await send(u, key);
    if (!r.ok) throw new Error("refused");
    expect(await undoQuickAddAction(r.created.map((c) => ({ threadId: c.threadId, eventId: c.eventId })))).toEqual({ ok: true });
    const before = await state(u);
    const again = await send(u, key);
    expect(again).toMatchObject({ ok: true, created: [], undoable: false });
    expect(await state(u)).toEqual(before);
    // A new submission of the same words (new key) is a new add.
    expect(await send(u, randomUUID())).toMatchObject({ ok: true, created: [{ title: PLUMBER }] });
  });

  it("after a failed extraction a replay goes to review, never extracts or charges again", async () => {
    const u = await user();
    const key = randomUUID();
    const text = `No recording ${randomUUID()}`;
    const a = await send(u, key, text);
    expect(a).toMatchObject({ ok: true, route: "review", created: [] });
    const before = await state(u);
    expect(await send(u, key, text)).toMatchObject({ ok: true, route: "review", created: [], extractionId: a.ok ? a.extractionId : "" });
    expect(await state(u)).toEqual(before);
  });

  it("a Medium item replayed stays pending (rule 2)", async () => {
    const u = await user();
    const key = randomUUID();
    await send(u, key, MAYBE);
    expect(await send(u, key, MAYBE)).toMatchObject({ ok: true, route: "review", created: [] });
    expect((await admin.from("extraction_items").select("band, review_status").eq("user_id", u.id)).data).toEqual([{ band: "medium", review_status: "pending" }]);
    expect(await n("threads", u)).toBe(0);
  });

  it("another text under the key is refused and changes nothing; another user's key is theirs alone", async () => {
    const u = await user();
    const v = await user();
    const key = randomUUID();
    await send(u, key);
    const before = await state(u);
    expect(await send(u, key, MAYBE)).toMatchObject({ ok: false, error: { code: "save_failed" } });
    expect(await state(u)).toEqual(before);
    const mine = await start(u.client, key);
    const theirs = await start(v.client, key);
    expect(theirs.data).toMatchObject({ replayed: false });
    expect((theirs.data as { extraction_id: string }).extraction_id).not.toBe((mine.data as { extraction_id: string }).extraction_id);
    expect((await v.client.rpc("quick_add_result", { p_extraction_id: (mine.data as { extraction_id: string }).extraction_id, p_now: new Date().toISOString() })).data)
      .toEqual({ created: [], age_ms: 0, untouched: false });
  });

  it("limit closed: a replay answers, a new key is refused. Budget closed: likewise", async () => {
    const u = await user();
    const key = randomUUID();
    const first = await send(u, key);
    await admin.from("usage_counters").update({ extractions: 30 }).eq("user_id", u.id);
    const before = await state(u);
    expect(await send(u, key)).toMatchObject({ ok: true, created: first.ok ? first.created : [] });
    expect(await send(u, randomUUID())).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(await send(u, null)).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    await admin.from("usage_counters").update({ extractions: 0 }).eq("user_id", u.id);
    process.env.DAILY_AI_BUDGET_USD = "0";
    expect(await send(u, key)).toMatchObject({ ok: true, created: first.ok ? first.created : [] });
    expect(await send(u, randomUUID())).toMatchObject({ ok: false, error: { code: "save_failed" } });
    expect(await state(u)).toEqual({ ...before, used: 0 });
  });

  it("budget closed before a started extraction ran: the replay does not call the model; it fails to review with no thread", async () => {
    const u = await user();
    const key = randomUUID();
    expect((await start(u.client, key)).data).toMatchObject({ replayed: false });
    process.env.DAILY_AI_BUDGET_USD = "0";
    expect(await send(u, key)).toMatchObject({ ok: true, route: "review", created: [] });
    expect((await admin.from("extractions").select("status").eq("user_id", u.id)).data).toEqual([{ status: "failed" }]);
    expect(await n("threads", u)).toBe(0);
  });

  it("a first request that died after extracting: a replay creates the thread, undoable from its own creation", async () => {
    const u = await user();
    const key = randomUUID();
    const { data } = await start(u.client, key);
    const id = (data as { extraction_id: string }).extraction_id;
    const { runExtraction } = await import("@/lib/extraction/service");
    expect(await runExtraction({ rpc: (f, a) => u.client.rpc(f, a) }, id, { logger: () => {} })).toBe("succeeded");
    await new Promise((res) => setTimeout(res, 1_500));
    const r = await send(u, key);
    expect(r).toMatchObject({ ok: true, undoable: true, created: [{ title: PLUMBER }] });
    expect(r.ok && r.createdAfterMs).toBeGreaterThanOrEqual(0);
  });

  it("a replay after 30 s is not undoable in time: the age says so, and the server refuses", async () => {
    const u = await user();
    const key = randomUUID();
    await send(u, key);
    await new Promise((res) => setTimeout(res, 30_300));
    const r = await send(u, key);
    if (!r.ok) throw new Error("refused");
    expect(r.createdAfterMs).toBeLessThan(-30_000);
    expect(await undoQuickAddAction(r.created.map((c) => ({ threadId: c.threadId, eventId: c.eventId })))).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
  }, 60_000);

  it("grants, arguments and clock: anon refused; null key, long or blank text, far clock save nothing", async () => {
    const u = await user();
    expect((await start(anon, randomUUID())).error?.code).toBe("42501");
    expect((await anon.rpc("quick_add_result", { p_extraction_id: randomUUID(), p_now: new Date().toISOString() })).error?.code).toBe("42501");
    for (const over of [{ p_text: "x".repeat(2_001) }, { p_text: "  " }, { p_text: null }, { p_allow_new: null }]) {
      expect((await start(u.client, randomUUID(), over)).error, JSON.stringify(over).slice(0, 30)).not.toBeNull();
    }
    expect((await start(u.client, null)).error?.code).toBe("22023");
    expect((await start(u.client, randomUUID(), { p_allow_new: false })).data).toEqual({ error: "not_started" });
    expect(await state(u)).toEqual({ sources: 0, extractions: 0, items: 0, threads: 0, used: 0 });
    for (const c of [u.client, anon]) expect((await c.schema("private").from("quick_add_submissions").select("*")).error).not.toBeNull();
  });

  it.skipIf(!DB)("rule 8: a key goes with its source and with the account; ids only; not exported", async () => {
    const u = await user();
    await send(u, randomUUID());
    await send(u, randomUUID(), TWO);
    const left = () => psql(`select count(*) from private.quick_add_submissions where user_id = '${u.id}'`);
    expect(left()).toBe("2");
    const { data } = await admin.from("sources").select("id").eq("user_id", u.id).eq("text_content", PLUMBER).single();
    await admin.from("sources").delete().eq("id", data!.id);
    expect(left()).toBe("1");
    await admin.auth.admin.deleteUser(u.id);
    expect(left()).toBe("0");
    expect(psql("select string_agg(format_type(atttypid, atttypmod), ',') from pg_attribute where attrelid='private.quick_add_submissions'::regclass and attnum > 0")).toBe("uuid,uuid,uuid,uuid");
    expect(JSON.stringify(EXPORT_TABLES)).not.toContain("quick_add_submissions");
    expect(psql("select count(*) from information_schema.role_table_grants where table_name='quick_add_submissions' and grantee in ('anon','authenticated','PUBLIC','service_role')")).toBe("0");
  });

  it("PRIVACY P19, P20: source only keeps the auto-created thread and its quote; everything leaves nothing of it", async () => {
    const u = await user();
    const { deleteSource } = await import("@/lib/account/data");
    for (const everything of [false, true]) {
      expect(await send(u, randomUUID())).toMatchObject({ ok: true, created: [{ title: PLUMBER }] });
      const { data: s } = await admin.from("sources").select("id").eq("user_id", u.id).single();
      await deleteSource(u.client as never, s!.id, everything, () => undefined);
      expect([await n("sources", u), await n("extractions", u)]).toEqual([0, 0]);
      expect([await n("threads", u), await n("evidence", u)]).toEqual([1, 1]); // round 2 removes only its own
    }
    if (DB) expect(psql(`select count(*) from private.quick_add_submissions where user_id = '${u.id}'`)).toBe("0");
  });
});
