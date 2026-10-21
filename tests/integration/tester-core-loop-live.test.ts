/**
 * Lead-tester core-loop checks (S2 fixes + write model + S3 review tray + S4 Done/Undo) against REAL
 * local Supabase (PostgREST, Auth, RLS, real grants). Skipped unless LE_SUPABASE_LIVE=1
 * (`pnpm test:supabase`). Throwaway users (le-test-*@example.com), synthetic text only, deleted at
 * the end. Never resets the database. No live LLM: the recorded-fixture model only.
 *
 * Tests marked `it.fails` pin a defect or flagged risk: they assert the SAFE behaviour and currently
 * fail. When it is fixed the test starts passing, `it.fails` turns red, and the marker must be
 * removed (flip it to `it`).
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAccount } from "@/lib/account/deleteAccount";
import { createRecordedModel, Recording } from "@/lib/ai/fake";
import { readExtraction, retryExtraction, runExtraction, startExtraction, type RpcDb } from "@/lib/extraction/service";
import { acceptProposals, rejectProposals, undoRejectProposals } from "@/lib/review/service";
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
const recording = (name: string) =>
  Recording.parse(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "llm", `${name}.extract.json`), "utf8")));
const MIKE = recording("mike-email");
const MALFORMED = recording("always-malformed");
const now = () => new Date(Date.now());
const quiet = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TRUST_TABLES = ["extractions", "extraction_items", "evidence", "threads", "thread_events", "suppressions"] as const;
const ALL_TABLES = ["profiles", "user_settings", "sources", "extractions", "extraction_items", "evidence", "threads", "thread_events", "decisions", "suppressions", "usage_counters"] as const;

describe.skipIf(!live)("tester core loop on real local Supabase", () => {
  let e: ReturnType<typeof env>;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  const users: Array<{ id: string; client: SupabaseClient }> = [];

  async function makeUser(tag: string) {
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

  async function count(table: string, uid: string): Promise<number> {
    const col = table === "profiles" ? "id" : "user_id";
    const { count: n, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq(col, uid);
    if (error) throw error;
    return n ?? 0;
  }

  /** Paste MIKE, run the pipeline with the recorded model, return the shown proposals. */
  async function pasteAndRun(c: SupabaseClient, text = MIKE.input!) {
    const s = await startExtraction(rpc(c), { text, title: null, writtenOn: "2026-10-05" }, { now: now() });
    if (!s.ok) throw new Error(`start failed: ${s.error.error.code}`);
    await runExtraction(rpc(c), s.extractionId, { model: createRecordedModel({ recordings: [MIKE] }), logger: quiet });
    const view = await readExtraction(rpc(c), s.extractionId, { now: now(), logger: quiet });
    if (!view || view.status !== "succeeded") throw new Error(`run did not succeed: ${view?.status}`);
    return { extractionId: s.extractionId, sourceId: s.sourceId, proposals: view.proposals };
  }

  /** Paste, run, accept the first proposal; returns its thread id. */
  async function acceptedThread(c: SupabaseClient) {
    const r = await pasteAndRun(c);
    const first = r.proposals[0]!;
    const acc = await acceptProposals(rpc(c), r.extractionId, [first.id], { now: now(), logger: quiet });
    if (!acc.ok || acc.created.length !== 1) throw new Error("accept failed");
    const threadId = acc.created[0]!.thread_id;
    if (!threadId) throw new Error("accept returned no thread id");
    return { ...r, itemId: first.id, threadId };
  }

  const threadRow = async (id: string) => (await admin.from("threads").select("*").eq("id", id).single()).data as Record<string, unknown>;
  const events = async (id: string) =>
    ((await admin.from("thread_events").select("id, type, actor, before, after").eq("thread_id", id).order("id")).data ?? []) as Array<{
      id: number; type: string; actor: string; before: unknown; after: unknown;
    }>;

  beforeAll(async () => {
    e = env();
    admin = createClient(e.url, e.service, opts);
    anon = createClient(e.url, e.anon, opts);
  });

  afterAll(async () => {
    for (const u of users) await admin.auth.admin.deleteUser(u.id);
  });

  // ---------------------------------------------------------------------------------------------
  describe("write model: no direct writes for authenticated (own rows included)", () => {
    it("INSERT, UPDATE and DELETE on the six trust tables are refused with 42501, even on the owner's own rows", async () => {
      const a = await makeUser("wm");
      const t = await acceptedThread(a.client);
      const ids: Record<(typeof TRUST_TABLES)[number], { col: string; val: unknown }> = {
        extractions: { col: "id", val: t.extractionId },
        extraction_items: { col: "id", val: t.itemId },
        evidence: { col: "thread_id", val: t.threadId },
        threads: { col: "id", val: t.threadId },
        thread_events: { col: "thread_id", val: t.threadId },
        suppressions: { col: "user_id", val: a.id },
      };
      // A suppression of A's own, written through the function, so there is a row to attack.
      const r2 = await pasteAndRun(a.client);
      if (r2.proposals[1]) await rejectProposals(rpc(a.client), r2.extractionId, [r2.proposals[1].id], { now: now(), logger: quiet });

      const before = Object.fromEntries(await Promise.all(TRUST_TABLES.map(async (tb) => [tb, await count(tb, a.id)] as const)));
      for (const tb of TRUST_TABLES) {
        const { col, val } = ids[tb];
        const ins = await a.client.from(tb).insert({ user_id: a.id }).select();
        expect(ins.error?.code, `${tb} insert`).toBe("42501");
        const upd = await a.client.from(tb).update({ user_id: a.id }).eq(col, val).select();
        expect(upd.error?.code, `${tb} update`).toBe("42501");
        const del = await a.client.from(tb).delete().eq(col, val).select();
        expect(del.error?.code, `${tb} delete`).toBe("42501");
      }
      const after = Object.fromEntries(await Promise.all(TRUST_TABLES.map(async (tb) => [tb, await count(tb, a.id)] as const)));
      expect(after).toEqual(before);
      expect((await threadRow(t.threadId)).status).toBe("open");
    });

    it("sources: INSERT and UPDATE refused; DELETE of one's own works and of another user's does nothing", async () => {
      const a = await makeUser("wms");
      const b = await makeUser("wmsb");
      const r = await pasteAndRun(a.client);
      const ins = await a.client.from("sources").insert({ user_id: a.id, kind: "paste", text_content: "x", reference_date: "2026-10-05", reference_date_source: "user" }).select();
      expect(ins.error?.code).toBe("42501");
      const upd = await a.client.from("sources").update({ title: "renamed" }).eq("id", r.sourceId).select();
      expect(upd.error?.code).toBe("42501");
      const delB = await b.client.from("sources").delete().eq("id", r.sourceId).select("id");
      expect(delB.data ?? []).toEqual([]);
      expect(await count("sources", a.id)).toBe(1);
      const delA = await a.client.from("sources").delete().eq("id", r.sourceId).select("id");
      expect(delA.error).toBeNull();
      expect(delA.data).toEqual([{ id: r.sourceId }]);
      // Cascade: the attempt, its proposals and their evidence are gone too.
      for (const tb of ["sources", "extractions", "extraction_items", "evidence"]) expect(await count(tb, a.id), tb).toBe(0);
    });

    it("usage_counters: the owner cannot lower, reset or delete their own count (rate limit cannot be undone)", async () => {
      const a = await makeUser("wmu");
      await pasteAndRun(a.client);
      const day = (await admin.from("usage_counters").select("day, extractions").eq("user_id", a.id).single()).data!;
      expect(day.extractions).toBe(1);
      const upd = await a.client.from("usage_counters").update({ extractions: 0 }).eq("user_id", a.id).select();
      expect(upd.data ?? []).toEqual([]);
      const del = await a.client.from("usage_counters").delete().eq("user_id", a.id).select();
      expect(del.data ?? []).toEqual([]);
      const ins = await a.client.from("usage_counters").upsert({ user_id: a.id, day: "2099-01-01", extractions: -100 }).select();
      expect(ins.error).not.toBeNull();
      expect((await admin.from("usage_counters").select("extractions").eq("user_id", a.id)).data).toEqual([{ extractions: 1 }]);
    });

    it("decisions: another user's thread cannot be referenced (composite FK + RLS)", async () => {
      const a = await makeUser("dxa");
      const b = await makeUser("dxb");
      const t = await acceptedThread(a.client);
      const ins = await b.client.from("decisions").insert({ user_id: b.id, thread_id: t.threadId, choice: "forged" }).select();
      expect(ins.error).not.toBeNull();
      const ins2 = await b.client.from("decisions").insert({ user_id: a.id, thread_id: t.threadId, choice: "forged" }).select();
      expect(ins2.error).not.toBeNull();
      expect(await count("decisions", a.id)).toBe(0);
    });

    // FLAGGED RISK (decisions still FOR ALL; Resolve is not built yet). The owner can write
    // decisions directly through PostgREST: no thread_events row, any decided_at, a
    // reason_ai_summary the UI would label as Interpretation although the user typed it, and
    // reason_user can be rewritten later. Rule 5 ("decision reasons are stored and shown
    // verbatim") and "history is never rewritten" depend on decisions being written only by a
    // Resolve function. Safe behaviour: no direct INSERT/UPDATE/DELETE on decisions.
    it.fails("RISK: the owner cannot write or rewrite a decision directly (decisions must go through Resolve)", async () => {
      const a = await makeUser("dxo");
      const t = await acceptedThread(a.client);
      const ins = await a.client
        .from("decisions")
        .insert({ user_id: a.id, thread_id: t.threadId, choice: "Chose the cheaper plan", reason_user: "price", reason_ai_summary: "forged by the user", decided_at: "2001-01-01T00:00:00Z" })
        .select("id")
        .single();
      expect(ins.error?.code).toBe("42501");
      if (ins.data) {
        const upd = await a.client.from("decisions").update({ reason_user: "rewritten" }).eq("id", ins.data.id).select();
        expect(upd.error?.code).toBe("42501");
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("cross-user: every writer refuses another user's ids and writes nothing", () => {
    it("accept, reject, undo-reject, Done, Undo and Forget on A's ids by B: refused; A's rows unchanged", async () => {
      const a = await makeUser("xa");
      const b = await makeUser("xb");
      const t = await acceptedThread(a.client);
      const r = await pasteAndRun(a.client);
      const pending = r.proposals.map((p) => p.id);
      const bOwn = await pasteAndRun(b.client);
      const done = await markDone(rpc(a.client), t.threadId, "open", { now: now(), logger: quiet });
      expect(done.ok).toBe(true);
      const doneEvent = done.ok ? done.event_id : -1;

      const snapshot = async () => ({
        thread: await threadRow(t.threadId),
        events: await events(t.threadId),
        items: (await admin.from("extraction_items").select("id, review_status, thread_id").eq("user_id", a.id).order("id")).data,
        supp: await count("suppressions", a.id),
        bThreads: await count("threads", b.id),
        bSupp: await count("suppressions", b.id),
      });
      const before = await snapshot();
      const bdb = rpc(b.client);

      for (const extraction of [r.extractionId, bOwn.extractionId]) {
        expect(await acceptProposals(bdb, extraction, pending, { now: now(), logger: quiet })).toMatchObject({ ok: false, notFound: true });
        expect(await rejectProposals(bdb, extraction, pending, { now: now(), logger: quiet })).toMatchObject({ ok: false, notFound: true });
        expect(await undoRejectProposals(bdb, extraction, pending, { logger: quiet })).toMatchObject({ ok: false, notFound: true });
      }
      // Mixed: one of B's own ids plus one of A's refuses the whole call.
      expect(await acceptProposals(bdb, bOwn.extractionId, [bOwn.proposals[0]!.id, pending[0]!], { now: now(), logger: quiet })).toMatchObject({ ok: false, notFound: true });
      expect(await markDone(bdb, t.threadId, "resolved", { now: now(), logger: quiet })).toMatchObject({ ok: false, code: "not_found" });
      expect(await markDone(bdb, t.threadId, "open", { now: now(), logger: quiet })).toMatchObject({ ok: false, code: "not_found" });
      expect(await undoEvent(bdb, t.threadId, doneEvent, { now: now(), logger: quiet })).toMatchObject({ ok: false, code: "not_found" });
      const f = await b.client.rpc("forget_thread", { p_thread_id: t.threadId, p_delete_source: true });
      expect(f.error?.code).toBe("P0002");

      expect(await snapshot()).toEqual(before);
      expect((await threadRow(t.threadId)).status).toBe("resolved");
    });

    it("anon can execute none of the 13 writer functions", async () => {
      const u = randomUUID();
      const calls: Array<[string, Record<string, unknown>]> = [
        ["accept_proposals", { p_extraction_id: u, p_item_ids: [u], p_now: now().toISOString() }],
        ["reject_proposals", { p_extraction_id: u, p_item_ids: [u], p_now: now().toISOString() }],
        ["undo_reject_proposals", { p_extraction_id: u, p_item_ids: [u] }],
        ["thread_done", { p_thread_id: u, p_from_status: "open", p_now: now().toISOString() }],
        ["thread_undo", { p_thread_id: u, p_event_id: 1, p_now: now().toISOString() }],
        ["forget_thread", { p_thread_id: u, p_delete_source: false }],
        ["consume_usage", { p_kind: "extraction" }],
      ];
      for (const [fn, args] of calls) {
        const res = await anon.rpc(fn, args);
        expect(res.error?.code, fn).toBe("42501");
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("S3 review tray (live)", () => {
    it("accept is idempotent under concurrency: two simultaneous accepts make one thread, one event, one evidence link", async () => {
      const a = await makeUser("acc2");
      const r = await pasteAndRun(a.client);
      const id = r.proposals[0]!.id;
      const [x, y] = await Promise.all([
        acceptProposals(rpc(a.client), r.extractionId, [id], { now: now(), logger: quiet }),
        acceptProposals(rpc(a.client), r.extractionId, [id], { now: now(), logger: quiet }),
      ]);
      expect(x.ok && y.ok).toBe(true);
      const created = (x.ok ? x.created.length : 0) + (y.ok ? y.created.length : 0);
      const already = (x.ok ? x.already.length : 0) + (y.ok ? y.already.length : 0);
      expect({ created, already }).toEqual({ created: 1, already: 1 });
      expect(await count("threads", a.id)).toBe(1);
      expect(await count("thread_events", a.id)).toBe(1);
      const ev = (await admin.from("evidence").select("thread_id").eq("user_id", a.id)).data ?? [];
      expect(ev.filter((r) => r.thread_id !== null)).toHaveLength(1);
    });

    it("the accepted thread carries the proposal's verified quote and a created event; nothing becomes a thread before accept (rule 2)", async () => {
      const a = await makeUser("acc3");
      const r = await pasteAndRun(a.client);
      expect(await count("threads", a.id)).toBe(0);
      const p = r.proposals[0]!;
      const acc = await acceptProposals(rpc(a.client), r.extractionId, [p.id], { now: now(), logger: quiet });
      if (!acc.ok) throw new Error("accept failed");
      const tid = acc.created[0]!.thread_id as string;
      const ev = (await admin.from("evidence").select("quote").eq("thread_id", tid)).data!;
      expect(ev.map((x) => x.quote)).toEqual(p.payload.evidence.map((x) => x.quote));
      for (const q of ev) expect(MIKE.input!).toContain(q.quote);
      expect((await events(tid)).map((x) => [x.type, x.actor])).toEqual([["created", "user"]]);
    });

    it("reject → suppression → a re-paste of the same text does not propose it again; undo reject → proposed again", async () => {
      const a = await makeUser("rej");
      const r1 = await pasteAndRun(a.client);
      const target = r1.proposals[0]!;
      const rej = await rejectProposals(rpc(a.client), r1.extractionId, [target.id], { now: now(), logger: quiet });
      expect(rej.ok && rej.rejected.length).toBe(1);
      expect(await count("suppressions", a.id)).toBe(1);
      const r2 = await pasteAndRun(a.client);
      expect(r2.proposals.map((p) => p.payload.item.title)).not.toContain(target.payload.item.title);
      expect(r2.proposals).toHaveLength(r1.proposals.length - 1);

      const und = await undoRejectProposals(rpc(a.client), r1.extractionId, [target.id], { logger: quiet });
      expect(und.ok && und.restored.length).toBe(1);
      expect(await count("suppressions", a.id)).toBe(0);
      const r3 = await pasteAndRun(a.client);
      expect(r3.proposals.map((p) => p.payload.item.title)).toContain(target.payload.item.title);
    });

    it("an owner-forged proposal via complete_extraction with no evidence rows is never shown or accepted", async () => {
      const a = await makeUser("forge2");
      const s = await startExtraction(rpc(a.client), { text: MIKE.input!, title: null, writtenOn: "2026-10-05" }, { now: now() });
      if (!s.ok) throw new Error("start failed");
      // Payload with a verbatim quote (the trigger allows it) but no evidence rows, and a forged band.
      const quote = "I'll send you the revised proposal Friday";
      const payload = {
        v: 1,
        item: { type: "commitment", title: "Forged title", owner: "user", action: null, counterparty: "Mike", due_text: null, due_reasoning: null, confidence: 0.99 },
        evidence: [{ quote, speaker: null, start_offset: 0, end_offset: quote.length, page: null, match_kind: "exact", similarity: 1, quote_hash: "h" }],
        date: { due_at: null, due_date: null, due_time_known: false, due_certainty: "none", agreement: "none", not_sure: [], reasoning: null },
        score: 0.99, band: "high", signals: [], label: null, not_sure: [],
      };
      const res = await a.client.rpc("complete_extraction", {
        p_extraction_id: s.extractionId, p_model: "forged", p_input_tokens: 1, p_output_tokens: 1, p_latency_ms: 1, p_raw_output: null, p_brief: null,
        p_items: [{ item_index: 0, payload, confidence: 0.99, band: "high", suppression_hash: "forged", evidence: [] }],
      });
      expect(res.error).toBeNull();
      const view = await readExtraction(rpc(a.client), s.extractionId, { now: now(), logger: quiet });
      for (const p of view?.proposals ?? []) {
        const acc = await acceptProposals(rpc(a.client), s.extractionId, [p.id], { now: now(), logger: quiet });
        expect(acc.ok && acc.created).toEqual([]);
      }
      expect(await count("threads", a.id)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("S4 Done and 8 s Undo (live)", () => {
    it("Done then Undo within 8 s restores every thread column exactly (except updated_at); history is append-only", async () => {
      const a = await makeUser("du");
      const t = await acceptedThread(a.client);
      const before = await threadRow(t.threadId);
      const done = await markDone(rpc(a.client), t.threadId, "open", { now: now(), logger: quiet });
      if (!done.ok) throw new Error("done failed");
      const mid = await threadRow(t.threadId);
      expect(mid).toMatchObject({ status: "resolved", resolution: "done" });
      expect(mid.resolved_at).not.toBeNull();
      const und = await undoEvent(rpc(a.client), t.threadId, done.event_id, { now: now(), logger: quiet });
      expect(und).toMatchObject({ ok: true, from_status: "resolved", to_status: "open", undone_action: "done" });
      const after = await threadRow(t.threadId);
      const strip = (r: Record<string, unknown>) => ({ ...r, updated_at: undefined });
      expect(strip(after)).toEqual(strip(before));
      const ev = await events(t.threadId);
      expect(ev.map((x) => x.type)).toEqual(["created", "resolved", "undone"]);
      expect(ev[1]!.before).toEqual({ status: "open", resolution: null, resolved_at: null });
      expect(ev[2]!.after).toMatchObject({ status: "open", undone_event_id: ev[1]!.id });
      // A second undo of the same Done, and an undo of the 'undone' event, are refused.
      expect(await undoEvent(rpc(a.client), t.threadId, done.event_id, { now: now(), logger: quiet })).toMatchObject({ ok: false, code: "invalid_transition" });
      expect(await undoEvent(rpc(a.client), t.threadId, ev[2]!.id, { now: now(), logger: quiet })).toMatchObject({ ok: false, code: "invalid_transition" });
      expect((await events(t.threadId)).length).toBe(3);
    });

    it("concurrent double Done: exactly one succeeds, one resolved event", async () => {
      const a = await makeUser("dd");
      const t = await acceptedThread(a.client);
      const [x, y] = await Promise.all([
        markDone(rpc(a.client), t.threadId, "open", { now: now(), logger: quiet }),
        markDone(rpc(a.client), t.threadId, "open", { now: now(), logger: quiet }),
      ]);
      expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
      expect([x, y].find((r) => !r.ok)).toMatchObject({ code: "invalid_transition" });
      expect((await events(t.threadId)).map((r) => r.type)).toEqual(["created", "resolved"]);
    });

    it("concurrent double Undo: exactly one succeeds, one undone event", async () => {
      const a = await makeUser("duu");
      const t = await acceptedThread(a.client);
      const done = await markDone(rpc(a.client), t.threadId, "open", { now: now(), logger: quiet });
      if (!done.ok) throw new Error("done failed");
      const [x, y] = await Promise.all([
        undoEvent(rpc(a.client), t.threadId, done.event_id, { now: now(), logger: quiet }),
        undoEvent(rpc(a.client), t.threadId, done.event_id, { now: now(), logger: quiet }),
      ]);
      expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
      expect((await events(t.threadId)).map((r) => r.type)).toEqual(["created", "resolved", "undone"]);
      expect((await threadRow(t.threadId)).status).toBe("open");
    });

    it("Undo after 8 s on the real clock is invalid_transition and writes nothing", { timeout: 20_000 }, async () => {
      const a = await makeUser("d8");
      const t = await acceptedThread(a.client);
      const done = await markDone(rpc(a.client), t.threadId, "open", { now: now(), logger: quiet });
      if (!done.ok) throw new Error("done failed");
      await sleep(8_600);
      expect(await undoEvent(rpc(a.client), t.threadId, done.event_id, { now: now(), logger: quiet })).toMatchObject({ ok: false, code: "invalid_transition" });
      expect((await threadRow(t.threadId)).status).toBe("resolved");
      expect((await events(t.threadId)).length).toBe(2);
    });

    // DEFECT (minor, own data only): thread_undo (and thread_done, accept_proposals) take the clock
    // from the caller (p_now). app/threads/[id]/actions.ts says "The 8 s window is checked on the
    // server's getNow()", but the function is callable directly through PostgREST, so a signed-in
    // user can undo a Done minutes later by passing p_now = the Done's time + 1 s, and can write
    // thread_events.created_at / threads.resolved_at at any instant (out of order with ids).
    // Safe behaviour: the database refuses a p_now far from its own now().
    it.fails("DEFECT: a direct RPC cannot undo a Done after 8 s by supplying an old p_now", { timeout: 20_000 }, async () => {
      const a = await makeUser("d8b");
      const t = await acceptedThread(a.client);
      const doneAt = now();
      const done = await markDone(rpc(a.client), t.threadId, "open", { now: doneAt, logger: quiet });
      if (!done.ok) throw new Error("done failed");
      await sleep(8_600);
      const res = await a.client.rpc("thread_undo", { p_thread_id: t.threadId, p_event_id: done.event_id, p_now: new Date(doneAt.getTime() + 1000).toISOString() });
      expect(res.data).toEqual({ ok: false, error: "invalid_transition" });
    });

    it("thread_events: the owner can neither update nor delete history", async () => {
      const a = await makeUser("hist");
      const t = await acceptedThread(a.client);
      const upd = await a.client.from("thread_events").update({ type: "undone" }).eq("thread_id", t.threadId).select();
      expect(upd.error?.code).toBe("42501");
      const del = await a.client.from("thread_events").delete().eq("thread_id", t.threadId).select();
      expect(del.error?.code).toBe("42501");
      expect((await events(t.threadId)).map((x) => x.type)).toEqual(["created"]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("S2 re-attack (live)", () => {
    it("retry cap: after the first attempt, at most 3 Try again; the 4th is retry_limit and retry_available is false", async () => {
      const a = await makeUser("cap");
      const s = await startExtraction(rpc(a.client), { text: MALFORMED.input!, title: null, writtenOn: "2026-10-05" }, { now: now() });
      if (!s.ok) throw new Error("start failed");
      let id = s.extractionId;
      const model = createRecordedModel({ recordings: [MALFORMED] });
      await runExtraction(rpc(a.client), id, { model, logger: quiet });
      for (let i = 0; i < 3; i++) {
        const v = await readExtraction(rpc(a.client), id, { now: now(), logger: quiet });
        expect(v, `attempt ${i + 1}`).toMatchObject({ status: "failed", retryAvailable: true });
        const r = await a.client.rpc("retry_extraction", { p_extraction_id: id, p_model: "m", p_prompt_version: "p", p_schema_version: "s" });
        expect(r.data).toMatchObject({ already_started: false });
        id = (r.data as { extraction_id: string }).extraction_id;
        await runExtraction(rpc(a.client), id, { model, logger: quiet });
      }
      const last = await readExtraction(rpc(a.client), id, { now: now(), logger: quiet });
      expect(last).toMatchObject({ status: "failed", retryAvailable: false });
      const r4 = await a.client.rpc("retry_extraction", { p_extraction_id: id, p_model: "m", p_prompt_version: "p", p_schema_version: "s" });
      expect(r4.data).toEqual({ error: "retry_limit" });
      // The service maps it to a refusal and starts nothing.
      const svc = await retryExtraction(rpc(a.client), id, { logger: quiet });
      expect(svc).toMatchObject({ ok: false, notFound: false });
      if (!svc.ok) expect(svc.error.error.code).toBe("retry_limit");
      expect(await count("extractions", a.id)).toBe(4);
      expect((await admin.from("usage_counters").select("extractions").eq("user_id", a.id)).data).toEqual([{ extractions: 1 }]);
    });

    it("the cap cannot be reset by deleting old attempts: deleting the source is the only way, and that deletes the text", async () => {
      const a = await makeUser("cap2");
      const s = await startExtraction(rpc(a.client), { text: MALFORMED.input!, title: null, writtenOn: "2026-10-05" }, { now: now() });
      if (!s.ok) throw new Error("start failed");
      const del = await a.client.from("extractions").delete().eq("id", s.extractionId).select();
      expect(del.error?.code).toBe("42501");
      const { data } = await admin.from("sources").select("pipeline_attempts").eq("id", s.sourceId).single();
      expect(data).toEqual({ pipeline_attempts: 1 });
    });

    it("a client-supplied far-future p_now on get_extraction can only fail the caller's own running attempt (one timed_out)", async () => {
      const a = await makeUser("to");
      const s = await startExtraction(rpc(a.client), { text: MIKE.input!, title: null, writtenOn: "2026-10-05" }, { now: now() });
      if (!s.ok) throw new Error("start failed");
      const far = new Date(Date.now() + 91_000);
      const [x, y] = await Promise.all([
        readExtraction(rpc(a.client), s.extractionId, { now: far, logger: quiet }),
        readExtraction(rpc(a.client), s.extractionId, { now: far, logger: quiet }),
      ]);
      expect([x?.timedOut, y?.timedOut].filter(Boolean)).toHaveLength(1);
      expect(x).toMatchObject({ status: "failed" });
      // The late pipeline run writes nothing.
      await runExtraction(rpc(a.client), s.extractionId, { model: createRecordedModel({ recordings: [MIKE] }), logger: quiet });
      expect(await count("extraction_items", a.id)).toBe(0);
    });

    it("rate limit: consume_usage called directly only counts up; a 31st start is refused and stores nothing", async () => {
      const a = await makeUser("rl");
      for (let i = 0; i < 30; i++) expect((await a.client.rpc("consume_usage", { p_kind: "extraction" })).data).toBe(true);
      const s = await startExtraction(rpc(a.client), { text: MIKE.input!, title: null, writtenOn: "2026-10-05" }, { now: now() });
      expect(s.ok).toBe(false);
      if (!s.ok) expect(s.error.error.code).toBe("rate_limited");
      const quick = await a.client.rpc("start_source_extraction", {
        p_kind: "quick_add", p_text: "x", p_title: null, p_reference_date: null, p_now: now().toISOString(), p_model: "m", p_prompt_version: "p", p_schema_version: "s",
      });
      expect(quick.data).toEqual({ error: "rate_limited" });
      expect(await count("sources", a.id)).toBe(0);
    });

    it("over-limit text (30,001 chars) by direct RPC is refused before counting", async () => {
      const a = await makeUser("big");
      const res = await a.client.rpc("start_source_extraction", {
        p_kind: "paste", p_text: "a".repeat(30_001), p_title: null, p_reference_date: "2026-10-05", p_now: now().toISOString(), p_model: "m", p_prompt_version: "p", p_schema_version: "s",
      });
      expect(res.error?.code).toBe("22023");
      expect(await count("usage_counters", a.id)).toBe(0);
      expect(await count("sources", a.id)).toBe(0);
    });

    it("forged brief: a source-basis line whose quote is not in the text is refused; nothing saved", async () => {
      const a = await makeUser("brief");
      const s = await startExtraction(rpc(a.client), { text: MIKE.input!, title: null, writtenOn: "2026-10-05" }, { now: now() });
      if (!s.ok) throw new Error("start failed");
      const res = await a.client.rpc("complete_extraction", {
        p_extraction_id: s.extractionId, p_model: "x", p_input_tokens: 1, p_output_tokens: 1, p_latency_ms: 1, p_raw_output: null,
        p_brief: { key_points: [{ text: "Mike owes you money", basis: "source", quote: "Mike owes you 500 dollars" }] }, p_items: [],
      });
      expect(res.error).not.toBeNull();
      const { data } = await admin.from("extractions").select("status, brief").eq("id", s.extractionId).single();
      expect(data).toEqual({ status: "running", brief: null });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("rule 8 after the write model (live)", () => {
    it("Forget with 'also delete source' on a Done+Undone thread leaves only the suppression hash", async () => {
      const a = await makeUser("fg");
      const t = await acceptedThread(a.client);
      const done = await markDone(rpc(a.client), t.threadId, "open", { now: now(), logger: quiet });
      if (!done.ok) throw new Error("done failed");
      await undoEvent(rpc(a.client), t.threadId, done.event_id, { now: now(), logger: quiet });
      const f = await a.client.rpc("forget_thread", { p_thread_id: t.threadId, p_delete_source: true });
      expect(f.error).toBeNull();
      for (const tb of ["sources", "extractions", "extraction_items", "evidence", "threads", "thread_events"]) expect(await count(tb, a.id), tb).toBe(0);
      const supp = (await admin.from("suppressions").select("reason, thread_id").eq("user_id", a.id)).data!;
      expect(supp).toEqual([{ reason: "forgotten", thread_id: null }]);
      // A re-paste of the same text does not propose the forgotten item again.
      const r = await pasteAndRun(a.client);
      const forgotten = t.proposals[0]!.payload.item.title;
      expect(r.proposals.map((p) => p.payload.item.title)).not.toContain(forgotten);
      expect(r.proposals).toHaveLength(t.proposals.length - 1);
    });

    it("Forget keeping the source: the thread, its events and every quote copy go; the source text stays", async () => {
      const a = await makeUser("fk");
      const t = await acceptedThread(a.client);
      const f = await a.client.rpc("forget_thread", { p_thread_id: t.threadId, p_delete_source: false });
      expect(f.error).toBeNull();
      for (const tb of ["threads", "thread_events"]) expect(await count(tb, a.id), tb).toBe(0);
      // Only the forgotten item's proposal and evidence go; the other (unaccepted) proposal stays.
      const left = (await admin.from("extraction_items").select("id").eq("user_id", a.id)).data!.map((x) => x.id);
      expect(left).toEqual(t.proposals.filter((p) => p.id !== t.itemId).map((p) => p.id));
      const ev = (await admin.from("evidence").select("quote, extraction_item_id").eq("user_id", a.id)).data!;
      expect(ev.every((x) => x.extraction_item_id !== t.itemId)).toBe(true);
      expect(await count("sources", a.id)).toBe(1);
      const raw = (await admin.from("extractions").select("raw_output").eq("user_id", a.id).single()).data!.raw_output as { items?: unknown[] } | null;
      const quote = t.proposals[0]!.payload.evidence[0]!.quote;
      expect(ev.map((x) => x.quote)).not.toContain(quote);
      expect(JSON.stringify(raw ?? null)).not.toContain(quote);
    });

    it("account deletion after the full loop (accepted, Done, rejected, file uploaded) removes every row in all 11 tables and every object", async () => {
      const a = await makeUser("acct");
      const t = await acceptedThread(a.client);
      await markDone(rpc(a.client), t.threadId, "open", { now: now(), logger: quiet });
      const r = await pasteAndRun(a.client);
      if (r.proposals[1]) await rejectProposals(rpc(a.client), r.extractionId, [r.proposals[1].id], { now: now(), logger: quiet });
      const up = await admin.storage.from("sources").upload(`${a.id}/synthetic.txt`, new Blob(["synthetic"]), { upsert: true });
      expect(up.error).toBeNull();
      expect(await count("threads", a.id)).toBeGreaterThan(0);
      const res = await deleteAccount(admin as never, a.id, { logger: quiet });
      expect(res.ok).toBe(true);
      for (const tb of ALL_TABLES) expect(await count(tb, a.id), tb).toBe(0);
      const list = await admin.storage.from("sources").list(a.id);
      expect(list.data ?? []).toEqual([]);
      users.splice(users.findIndex((u) => u.id === a.id), 1);
    });
  });
});
