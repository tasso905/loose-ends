/**
 * Lead-tester S8 (F11 Resolve + decisions write model) attacks against REAL local Supabase
 * (PostgREST, Auth, RLS, real grants, real row locks), through the real server action
 * `resolveAction` (user-scoped client replaced by a signed-in supabase-js client) and direct RPC.
 * Skipped unless LE_SUPABASE_LIVE=1 (`pnpm test:supabase`). Throwaway users, synthetic text only,
 * recorded-fixture model only (no live LLM). Never resets the database.
 *
 * `it.fails` pins a defect: it asserts the SAFE behaviour and currently fails.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
const tracked = vi.hoisted(() => ({ events: [] as Array<{ userId: string; name: string; props: unknown }> }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("@/lib/analytics/track", () => ({
  track: (userId: string, name: string, props: unknown) => void tracked.events.push({ userId, name, props }),
  createTracker: () => ({ track: () => {}, trackAwaited: async () => "disabled" }),
}));

import { resolveAction, undoAction } from "@/app/threads/[id]/actions";
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

type User = { id: string; client: SupabaseClient };

describe.skipIf(!live)("tester S8: Resolve and decisions on real local Supabase", () => {
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

  /** Paste the Mike email (recorded model), accept the first proposal; returns its thread id. */
  async function thread(u: User, kind?: string): Promise<string> {
    const s = await startExtraction(rpc(u.client), { text: MIKE.input!, title: null, writtenOn: "2026-10-05" }, { now: new Date() });
    if (!s.ok) throw new Error(`start failed: ${s.error.error.code}`);
    await runExtraction(rpc(u.client), s.extractionId, { model: createRecordedModel({ recordings: [MIKE] }), logger: quiet });
    const view = await readExtraction(rpc(u.client), s.extractionId, { now: new Date(), logger: quiet });
    const first = view!.proposals[0]!;
    const acc = await acceptProposals(rpc(u.client), s.extractionId, [first.id], { now: new Date(), logger: quiet });
    if (!acc.ok) throw new Error("accept failed");
    const id = acc.created[0]!.thread_id!;
    if (kind) await admin.from("threads").update({ kind }).eq("id", id);
    return id;
  }

  const as = <T,>(u: User, fn: () => Promise<T>) => {
    current.client = u.client;
    return fn();
  };
  const decisions = async (threadId: string) =>
    ((await admin.from("decisions").select("id, user_id, choice, reason_user, reason_ai_summary, resolution_event_id").eq("thread_id", threadId)).data ?? []) as Array<{
      id: string; user_id: string; choice: string; reason_user: string | null; reason_ai_summary: string | null; resolution_event_id: number;
    }>;
  const threadRow = async (id: string) => (await admin.from("threads").select("status, resolution, resolved_at").eq("id", id).single()).data!;
  const events = async (id: string) =>
    ((await admin.from("thread_events").select("id, type, after").eq("thread_id", id).order("id")).data ?? []) as Array<{ id: number; type: string; after: Record<string, unknown> }>;
  const resolveRpc = (u: User, threadId: string, resolution: string, choice: string | null = null, reason: string | null = null, from = "open") =>
    u.client.rpc("thread_resolve", { p_thread_id: threadId, p_from_status: from, p_resolution: resolution, p_choice: choice, p_reason: reason, p_now: nowIso() });

  beforeAll(async () => {
    e = env();
    process.env.NEXT_PUBLIC_SUPABASE_URL = e.url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = e.anon;
    admin = createClient(e.url, e.service, opts);
    anon = createClient(e.url, e.anon, opts);
    A = await makeUser("s8a");
    B = await makeUser("s8b");
  }, 60_000);

  beforeEach(() => {
    tracked.events.length = 0;
  });

  afterAll(async () => {
    for (const u of users) await admin.auth.admin.deleteUser(u.id);
  });

  // -------------------------------------------------------------------------------------------
  it("direct writes on decisions over PostgREST: insert, update, delete and upsert are refused; the row is unchanged", async () => {
    const id = await thread(A);
    const res = await as(A, () => resolveAction({ threadId: id, fromStatus: "open", resolution: "decided", choice: "Renew", reason: "price" }));
    expect(res.ok).toBe(true);
    const [d] = await decisions(id);

    const ins = await A.client.from("decisions").insert({ user_id: A.id, thread_id: id, choice: "forged" }).select();
    expect(ins.error?.code).toBe("42501");
    const upd = await A.client.from("decisions").update({ reason_user: "rewritten", reason_ai_summary: "forged" }).eq("id", d!.id).select();
    expect(upd.error?.code).toBe("42501");
    const del = await A.client.from("decisions").delete().eq("id", d!.id).select();
    expect(del.error?.code).toBe("42501");
    const ups = await A.client.from("decisions").upsert({ id: d!.id, user_id: A.id, thread_id: id, choice: "upserted", reason_user: "rewritten" }).select();
    expect(ups.error?.code).toBe("42501");
    const upsIgnore = await A.client
      .from("decisions")
      .upsert({ id: d!.id, user_id: A.id, thread_id: id, choice: "upserted" }, { ignoreDuplicates: true })
      .select();
    expect(upsIgnore.error?.code).toBe("42501");

    expect(await decisions(id)).toEqual([{ ...d! }]);
    expect(d).toMatchObject({ choice: "Renew", reason_user: "price", reason_ai_summary: null });
  });

  it("embedding: A reads her own decision through threads?select=decisions(*); B's embed of A's thread returns nothing", async () => {
    const id = await thread(A);
    await as(A, () => resolveAction({ threadId: id, fromStatus: "open", resolution: "decided", choice: "Embed me", reason: null }));
    const mine = await A.client.from("threads").select("id, decisions(choice, reason_user)").eq("id", id).single();
    expect(mine.data).toMatchObject({ id, decisions: [{ choice: "Embed me", reason_user: null }] });
    const theirs = await B.client.from("threads").select("id, decisions(choice)").eq("id", id);
    expect(theirs.data ?? []).toEqual([]);
    const direct = await B.client.from("decisions").select("choice").eq("thread_id", id);
    expect(direct.data ?? []).toEqual([]);
    expect((await anon.from("decisions").select("choice")).data ?? []).toEqual([]);
    // The private undo body is not reachable through the API.
    expect((await A.client.rpc("thread_undo_unguarded", { p_thread_id: id, p_event_id: 1, p_now: nowIso() })).error).not.toBeNull();
  });

  it("forging: B resolves A's thread (RPC and server action) → not found; anon refused; nothing written", async () => {
    const id = await thread(A);
    const before = { t: await threadRow(id), ev: await events(id) };
    const r1 = await resolveRpc(B, id, "decided", "forged by B", "x");
    expect(r1.data).toEqual({ ok: false, error: "not_found" });
    const r2 = await as(B, () => resolveAction({ threadId: id, fromStatus: "open", resolution: "decided", choice: "forged", reason: null }));
    expect(!r2.ok && r2.error.code).toBe("not_found");
    expect((await resolveRpc({ id: "", client: anon }, id, "done")).error).not.toBeNull();
    expect({ t: await threadRow(id), ev: await events(id) }).toEqual(before);
    expect(await decisions(id)).toEqual([]);
    expect(tracked.events.filter((t) => t.name === "resolve_saved")).toEqual([]);
  });

  const EXOTIC = [
    "  leading and trailing spaces  ",
    "line one\n\n  line three\twith a tab\r\nCRLF",
    "Emoji: 👩🏽‍💻 🏳️‍🌈 ❤️ — family 👨‍👩‍👧‍👦",
    "RTL: ‮evil‬ and Arabic مرحبا with an LRM ‎ mark",
    "'); delete from public.decisions; --",
    "<script>alert(1)</script> & <b>bold</b> {{x}} ${x}",
    "Zero width:​‌‍, NBSP: , combining: é",
  ];
  it.each(EXOTIC)("verbatim round trip through the server action (reason and choice): %j", async (text) => {
    const id = await thread(A);
    const res = await as(A, () => resolveAction({ threadId: id, fromStatus: "open", resolution: "decided", choice: text, reason: text }));
    expect(res.ok).toBe(true);
    const [d] = await decisions(id);
    expect(d!.choice).toBe(text);
    expect(d!.reason_user).toBe(text);
    const read = await A.client.from("decisions").select("choice, reason_user").eq("thread_id", id).single();
    expect(read.data).toEqual({ choice: text, reason_user: text });
  });

  it("a NUL character cannot be stored: refused, nothing written (no partial save)", async () => {
    const id = await thread(A);
    const res = await as(A, () => resolveAction({ threadId: id, fromStatus: "open", resolution: "decided", choice: "Renew", reason: "a\u0000b" }));
    expect(res.ok).toBe(false);
    expect((await threadRow(id)).status).toBe("open");
    expect(await decisions(id)).toEqual([]);
  });

  it("length limits count code points: 300 / 2,000 accepted (emoji included), 301 / 2,001 refused by the action and by the RPC", async () => {
    const ok1 = await thread(A);
    const choice300 = "😀".repeat(300);
    const reason2000 = "é".repeat(1999) + "😀";
    expect((await as(A, () => resolveAction({ threadId: ok1, fromStatus: "open", resolution: "decided", choice: choice300, reason: reason2000 }))).ok).toBe(true);
    expect((await decisions(ok1))[0]).toMatchObject({ choice: choice300, reason_user: reason2000 });

    const bad = await thread(A);
    const r1 = await as(A, () => resolveAction({ threadId: bad, fromStatus: "open", resolution: "decided", choice: "x".repeat(301), reason: null }));
    expect(!r1.ok && r1.error.code).toBe("invalid_input");
    const r2 = await as(A, () => resolveAction({ threadId: bad, fromStatus: "open", resolution: "decided", choice: "x", reason: "y".repeat(2001) }));
    expect(r2.ok).toBe(false);
    expect((await resolveRpc(A, bad, "decided", "x".repeat(301))).error?.code).toBe("22023");
    expect((await resolveRpc(A, bad, "decided", "x", "😀".repeat(2001))).error?.code).toBe("22023");
    expect((await resolveRpc(A, bad, "done", "x")).error?.code).toBe("22023");
    expect((await resolveRpc(A, bad, "decided", "  ​ ")).error?.code).toBe("22023");
    expect((await threadRow(bad)).status).toBe("open");
    expect(await decisions(bad)).toEqual([]);
  });

  // NON-BLOCKING: the action's blank check is JS trim(), which keeps U+200B (zero-width space);
  // the database's is_blank() treats it as blank and raises 22023. The user then sees the generic
  // save failure (offering a retry that can never work) instead of the field error.
  it("a decision of only zero-width spaces gets the field error, not a generic save failure", async () => {
    const id = await thread(A);
    const res = await as(A, () => resolveAction({ threadId: id, fromStatus: "open", resolution: "decided", choice: "​​", reason: null }));
    expect(res).toMatchObject({ ok: false, field: "choice", error: { code: "invalid_input" } });
  });

  it("stale status, closed thread and Done on a decision thread → invalid_transition; nothing written", async () => {
    const id = await thread(A);
    expect((await resolveRpc(A, id, "done", null, null, "waiting")).data).toEqual({ ok: false, error: "invalid_transition" });
    expect((await as(A, () => resolveAction({ threadId: id, fromStatus: "snoozed", resolution: "not_needed" }))).ok).toBe(false);
    const dec = await thread(A, "decision");
    expect((await resolveRpc(A, dec, "done")).data).toEqual({ ok: false, error: "invalid_transition" });
    expect((await resolveRpc(A, dec, "not_needed")).data).toMatchObject({ ok: true });
    expect((await resolveRpc(A, dec, "decided", "again", null, "resolved")).data).toEqual({ ok: false, error: "invalid_transition" });
    expect((await events(id)).map((x) => x.type)).toEqual(["created"]);
    expect(await decisions(dec)).toEqual([]);
  });

  it("double submit: 5 concurrent Resolves of one thread → exactly one succeeds, one resolved event, one decision", async () => {
    const id = await thread(A);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => as(A, () => resolveAction({ threadId: id, fromStatus: "open", resolution: "decided", choice: `Choice ${i}`, reason: null }))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.error.code)).toEqual(Array(4).fill("invalid_transition"));
    expect((await events(id)).filter((x) => x.type === "resolved")).toHaveLength(1);
    expect(await decisions(id)).toHaveLength(1);
    expect(tracked.events.filter((t) => t.name === "resolve_saved")).toHaveLength(1);
  });

  it("Undo racing Undo and Resolve: the end state is consistent (decision exists iff resolved as Decided, linked to the latest resolved event)", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await thread(A);
      const first = await as(A, () => resolveAction({ threadId: id, fromStatus: "open", resolution: "decided", choice: "First", reason: "r1" }));
      expect(first.ok).toBe(true);
      const ev = first.ok ? first.eventId : -1;
      const [u1, u2, again] = await Promise.all([
        as(A, () => undoAction(id, ev)),
        as(A, () => undoAction(id, ev)),
        as(A, () => resolveAction({ threadId: id, fromStatus: "open", resolution: "decided", choice: "Second", reason: null })),
      ]);
      expect([u1, u2].filter((u) => u.ok)).toHaveLength(1);
      const t = await threadRow(id);
      const ds = await decisions(id);
      const resolvedEvents = (await events(id)).filter((x) => x.type === "resolved");
      if (again.ok) {
        expect(t).toMatchObject({ status: "resolved", resolution: "decided" });
        expect(ds.map((d) => d.choice)).toEqual(["Second"]);
        expect(ds[0]!.resolution_event_id).toBe(resolvedEvents.at(-1)!.id);
      } else {
        expect(t.status).toBe("open");
        expect(ds).toEqual([]);
      }
      expect((await events(id)).filter((x) => x.type === "undone")).toHaveLength(1);
    }
  }, 120_000);

  it("Forget (also deleting the source) removes the decision by cascade, although the owner cannot delete decisions", async () => {
    const id = await thread(A);
    await as(A, () => resolveAction({ threadId: id, fromStatus: "open", resolution: "decided", choice: "Forget me", reason: "secret reason" }));
    expect(await decisions(id)).toHaveLength(1);
    const f = await A.client.rpc("forget_thread", { p_thread_id: id, p_delete_source: true });
    expect(f.error).toBeNull();
    expect(await decisions(id)).toEqual([]);
    const any = (await admin.from("decisions").select("id, choice, reason_user").eq("user_id", A.id)).data ?? [];
    expect(any.some((d) => d.choice === "Forget me" || d.reason_user === "secret reason")).toBe(false);
  });

  it("analytics: resolve_saved and thread_action carry only enums, booleans and ids — never the choice or reason", async () => {
    const id = await thread(A);
    const choice = `CHOICE-${randomUUID()}`;
    const reason = `REASON-${randomUUID()}`;
    await as(A, () => resolveAction({ threadId: id, fromStatus: "open", resolution: "decided", choice, reason }));
    const blob = JSON.stringify(tracked.events);
    expect(blob).not.toContain(choice);
    expect(blob).not.toContain(reason);
    expect(tracked.events.map((t) => t.name).sort()).toEqual(["resolve_saved", "thread_action"]);
    expect(tracked.events.find((t) => t.name === "resolve_saved")!.props).toEqual({ resolution: "decided", reason_given: true });
    expect(tracked.events.find((t) => t.name === "thread_action")!.props).toEqual({
      thread_id: id, action: "resolve", from_status: "open", to_status: "resolved", surface: "detail",
    });
    // Skip: no reason given.
    tracked.events.length = 0;
    const id2 = await thread(A);
    await as(A, () => resolveAction({ threadId: id2, fromStatus: "open", resolution: "decided", choice: "c", reason: "   " }));
    expect(tracked.events.find((t) => t.name === "resolve_saved")!.props).toEqual({ resolution: "decided", reason_given: false });
    expect((await decisions(id2))[0]!.reason_user).toBeNull();
  });
});
