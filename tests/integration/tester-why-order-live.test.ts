/**
 * Lead-tester (fix/s9b-s10-thread-reason, migration 20261027125534_evidence_items_created_at;
 * updated for fix/evidence-source-order):
 *  - evidence orders by (created_at, start_offset NULLS LAST, id) and extraction_items by
 *    (created_at, item_index, id), in the Why panel (loadWhy) and Thread detail (getThreadDetail),
 *    and both pick the same first quote and proposal on every load;
 *  - the new columns default to now() and are NOT NULL;
 *  - RLS is unaffected: another user sees none of the rows (ordered by created_at or not), and an
 *    owner cannot rewrite created_at (the write model keeps evidence and proposals server-written);
 *  - rows written together by the extraction save share one created_at, so source position
 *    (start_offset / item_index) decides, and id only when that ties too.
 * Real local Supabase; skipped unless LE_SUPABASE_LIVE=1 (`pnpm test:supabase`). Synthetic data only.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getThreadDetail } from "@/lib/threads/read";
import { loadWhy } from "@/lib/threads/whyRead";

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

/** A uuid with a fixed first hex digit, so the id order is known. */
const idStarting = (digit: string) => digit + randomUUID().slice(1);
const SAME = "2026-10-21T09:00:00Z";
const TEXT = "Line one: I will book the cabin. Line two: Ana pays the deposit. Line three: we leave on the 30th.";

describe.skipIf(!live)("tester: (created_at, id) ordering, defaults and RLS for evidence and extraction_items", () => {
  let admin: SupabaseClient;
  const users: { id: string; client: SupabaseClient }[] = [];
  let threadId = "";
  let sourceId = "";
  let extractionId = "";
  const ev: Record<string, string> = {};

  async function mkUser() {
    const e = env();
    const email = `le-test-tworder-${randomUUID().slice(0, 6)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    const client = createClient(e.url, e.anon, opts);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
    users.push({ id: data.user.id, client });
    return users[users.length - 1]!;
  }

  beforeAll(async () => {
    const e = env();
    admin = createClient(e.url, e.service, opts);
    const a = await mkUser();
    await mkUser();
    const src = await admin.from("sources").insert({ user_id: a.id, kind: "paste", text_content: TEXT, reference_date: "2026-10-21", reference_date_source: "user" }).select("id").single();
    expect(src.error).toBeNull();
    sourceId = src.data!.id as string;
    const ex = await admin
      .from("extractions")
      .insert({ user_id: a.id, source_id: sourceId, status: "succeeded", model: "fake:recorded", prompt_version: "extract.v1", schema_version: "extraction.v1" })
      .select("id")
      .single();
    expect(ex.error).toBeNull();
    extractionId = ex.data!.id as string;
    const t = await admin.from("threads").insert({ user_id: a.id, title: "Book the cabin", kind: "commitment", status: "open", primary_source_id: sourceId }).select("id").single();
    expect(t.error).toBeNull();
    threadId = t.data!.id as string;

    const item = (index: number, id: string, band: string) => ({
      id,
      item_index: index,
      user_id: a.id,
      extraction_id: extractionId,
      band,
      confidence: band === "high" ? 0.9 : 0.6,
      review_status: "accepted",
      thread_id: threadId,
      created_at: SAME,
      payload: { item: { type: "commitment", title: "Book the cabin" }, label: { word: band === "high" ? "Likely" : "Maybe", reason: "synthetic" } },
    });
    // Same created_at: item_index 0 (medium) must win although its id ("9…") sorts after item 1's ("1…").
    const items = await admin.from("extraction_items").insert([item(0, idStarting("9"), "medium"), item(1, idStarting("1"), "high")]);
    expect(items.error).toBeNull();

    const evidence = (key: string, id: string, quote: string, createdAt = SAME) => {
      ev[key] = id;
      return { id, user_id: a.id, source_id: sourceId, thread_id: threadId, quote, start_offset: TEXT.indexOf(quote), end_offset: TEXT.indexOf(quote) + quote.length, match_kind: "exact", created_at: createdAt };
    };
    // Same created_at; ids chosen so the id order (three, one, two) disagrees with source order (one, two, three).
    const ins = await admin.from("evidence").insert([
      evidence("one", idStarting("a"), "I will book the cabin."),
      evidence("two", idStarting("e"), "Ana pays the deposit."),
      evidence("three", idStarting("3"), "we leave on the 30th."),
    ]);
    expect(ins.error).toBeNull();
  }, 60_000);

  afterAll(async () => {
    for (const u of users) await admin.auth.admin.deleteUser(u.id);
  });

  it("ties on created_at break by source position (start_offset, item_index), not id: Why panel and Thread detail agree on every load", async () => {
    const a = users[0]!;
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const why = await loadWhy(a.client, threadId, "UTC", new Date());
      expect(why.ok).toBe(true);
      if (!why.ok) return;
      seen.add(`${why.view.quote?.quote}|${why.view.origin?.band}`);
      const detail = await getThreadDetail(a.client, threadId);
      expect(detail.ok).toBe(true);
      if (!detail.ok) return;
      expect(detail.detail.evidence.map((e) => e.quote)).toEqual(["I will book the cabin.", "Ana pays the deposit.", "we leave on the 30th."]);
      expect(detail.detail.evidence[0]!.quote).toBe(why.view.quote?.quote);
      expect(detail.detail.origin?.band).toBe("medium");
    }
    expect([...seen]).toEqual(["I will book the cabin.|medium"]);
  });

  /** Inserts one evidence row on the thread; returns a cleanup. */
  async function addEvidence(row: { id: string; quote: string; start_offset: number | null; created_at?: string }) {
    const a = users[0]!;
    const off = row.start_offset;
    const ins = await admin.from("evidence").insert({
      id: row.id,
      user_id: a.id,
      source_id: sourceId,
      thread_id: threadId,
      quote: row.quote,
      start_offset: off,
      end_offset: off === null ? null : off + row.quote.length,
      match_kind: "exact",
      created_at: row.created_at ?? SAME,
    });
    expect(ins.error).toBeNull();
    return () => admin.from("evidence").delete().eq("id", row.id);
  }
  async function firstQuotes() {
    const a = users[0]!;
    const why = await loadWhy(a.client, threadId, "UTC", new Date());
    const detail = await getThreadDetail(a.client, threadId);
    expect(why.ok && detail.ok).toBe(true);
    if (!why.ok || !detail.ok) throw new Error("load failed");
    return { why: why.view.quote?.quote, detail: detail.detail.evidence.map((e) => e.quote) };
  }

  it("an earlier created_at beats a smaller start_offset and a smaller id", async () => {
    const quote = "we leave on the 30th.";
    const undo = await addEvidence({ id: idStarting("f"), quote, start_offset: TEXT.indexOf(quote), created_at: "2026-10-21T08:59:59Z" });
    const r = await firstQuotes();
    expect(r.why).toBe(quote);
    expect(r.detail[0]).toBe(quote);
    await undo();
  });

  it("equal created_at and start_offset fall back to id", async () => {
    // Same position as "I will book the cabin." (id "a…"); a "0…" id must now come first.
    const quote = "I will book the cabin.";
    const undo = await addEvidence({ id: idStarting("0"), quote, start_offset: TEXT.indexOf(quote) });
    const a = users[0]!;
    const detail = await getThreadDetail(a.client, threadId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    const ids = detail.detail.evidence.filter((e) => e.quote === quote).map((e) => (e as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(ids[0]!.startsWith("0")).toBe(true);
    expect(ids[1]).toBe(ev.one);
    for (let i = 0; i < 3; i++) expect((await firstQuotes()).detail).toEqual((await firstQuotes()).detail);
    await undo();
  });

  it("a NULL start_offset sorts last among rows with the same created_at, even with the smallest id", async () => {
    const quote = "Line one:";
    const undo = await addEvidence({ id: idStarting("0"), quote, start_offset: null });
    const r = await firstQuotes();
    expect(r.why).toBe("I will book the cabin.");
    expect(r.detail).toEqual(["I will book the cabin.", "Ana pays the deposit.", "we leave on the 30th.", quote]);
    await undo();
  });

  it("proposals tied on created_at and item_index (two extractions) fall back to id", async () => {
    const a = users[0]!;
    const ex2 = await admin
      .from("extractions")
      .insert({ user_id: a.id, source_id: sourceId, status: "succeeded", model: "fake:recorded", prompt_version: "extract.v1", schema_version: "extraction.v1" })
      .select("id")
      .single();
    expect(ex2.error).toBeNull();
    // item_index 0 like the "9…" medium row, same created_at, smaller id "0…", band low.
    const ins = await admin.from("extraction_items").insert({
      id: idStarting("0"),
      item_index: 0,
      user_id: a.id,
      extraction_id: ex2.data!.id,
      band: "low",
      confidence: 0.2,
      review_status: "accepted",
      thread_id: threadId,
      created_at: SAME,
      payload: { item: { type: "commitment", title: "Book the cabin" }, label: { word: "Also noticed", reason: "synthetic" } },
    });
    expect(ins.error).toBeNull();
    const why = await loadWhy(a.client, threadId, "UTC", new Date());
    const detail = await getThreadDetail(a.client, threadId);
    expect(why.ok && why.view.origin?.band).toBe("low");
    expect(detail.ok && detail.detail.origin?.band).toBe("low");
    await admin.from("extraction_items").delete().eq("extraction_id", ex2.data!.id);
    await admin.from("extractions").delete().eq("id", ex2.data!.id);
  });

  it("created_at defaults to now() and is NOT NULL on both tables", async () => {
    const a = users[0]!;
    const before = Date.now();
    const q = "Ana pays the deposit.";
    const ins = await admin
      .from("evidence")
      .insert({ user_id: a.id, source_id: sourceId, quote: q, start_offset: TEXT.indexOf(q), end_offset: TEXT.indexOf(q) + q.length, match_kind: "exact" })
      .select("id, created_at")
      .single();
    expect(ins.error).toBeNull();
    const at = new Date(ins.data!.created_at as string).getTime();
    expect(Math.abs(at - before)).toBeLessThan(60_000);
    await admin.from("evidence").delete().eq("id", ins.data!.id);

    const nulled = await admin.from("evidence").insert({ user_id: a.id, source_id: sourceId, quote: q, start_offset: TEXT.indexOf(q), end_offset: TEXT.indexOf(q) + q.length, match_kind: "exact", created_at: null });
    expect(nulled.error?.code).toBe("23502");
    const nulledItem = await admin.from("extraction_items").insert({
      item_index: 7,
      user_id: a.id,
      extraction_id: extractionId,
      band: "low",
      confidence: 0.2,
      review_status: "pending",
      created_at: null,
      payload: { item: { type: "commitment", title: "x" }, label: { word: "Also noticed", reason: "synthetic" } },
    });
    expect(nulledItem.error?.code).toBe("23502");
  });

  it("RLS unaffected: another user reads none of the rows, ordered by created_at or not, and the Why panel and Thread detail fail closed", async () => {
    const b = users[1]!;
    expect((await b.client.from("evidence").select("id, created_at").eq("thread_id", threadId).order("created_at").order("id")).data).toEqual([]);
    expect((await b.client.from("extraction_items").select("id, created_at").eq("thread_id", threadId).order("created_at").order("id")).data).toEqual([]);
    expect((await b.client.from("evidence").select("id").gte("created_at", "2000-01-01")).data).toEqual([]);
    const why = await loadWhy(b.client, threadId, "UTC", new Date());
    expect(why.ok).toBe(false);
    const detail = await getThreadDetail(b.client, threadId);
    expect(detail.ok).toBe(false);
    // The owner can read created_at (no column grant is missing).
    const own = await users[0]!.client.from("evidence").select("id, created_at").eq("thread_id", threadId).order("created_at").order("id");
    expect(own.error).toBeNull();
    expect(own.data!.length).toBe(3);
  });

  it("neither the owner nor another user can rewrite created_at to reorder quotes", async () => {
    for (const u of users) {
      await u.client.from("evidence").update({ created_at: "2000-01-01T00:00:00Z" }).eq("id", ev.two!);
      await u.client.from("extraction_items").update({ created_at: "2000-01-01T00:00:00Z" }).eq("thread_id", threadId);
    }
    const row = await admin.from("evidence").select("created_at").eq("id", ev.two!).single();
    expect(new Date(row.data!.created_at as string).toISOString()).toBe(new Date(SAME).toISOString());
    const items = await admin.from("extraction_items").select("created_at").eq("thread_id", threadId);
    for (const r of items.data!) expect(new Date(r.created_at as string).toISOString()).toBe(new Date(SAME).toISOString());
  });
});
