/**
 * Lead-tester (fix/s9b-s10-thread-reason, migration 20261027125534_evidence_items_created_at):
 *  - ties on created_at break by id, in the Why panel (loadWhy) and Thread detail (getThreadDetail),
 *    and both pick the same first quote on every load;
 *  - the new columns default to now() and are NOT NULL;
 *  - RLS is unaffected: another user sees none of the rows (ordered by created_at or not), and an
 *    owner cannot rewrite created_at (the write model keeps evidence and proposals server-written);
 *  - rows written together by the extraction save share one created_at, so the id tie-break decides.
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
    // Same created_at; the id starting "1" must win although it was inserted second and is item 1.
    const items = await admin.from("extraction_items").insert([item(0, idStarting("9"), "medium"), item(1, idStarting("1"), "high")]);
    expect(items.error).toBeNull();

    const evidence = (key: string, id: string, quote: string, createdAt = SAME) => {
      ev[key] = id;
      return { id, user_id: a.id, source_id: sourceId, thread_id: threadId, quote, start_offset: TEXT.indexOf(quote), end_offset: TEXT.indexOf(quote) + quote.length, match_kind: "exact", created_at: createdAt };
    };
    // Inserted in source order; ids chosen so the id order is three, one, two among the tied rows.
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

  it("ties on created_at break by id: the Why panel and Thread detail show the same first quote and proposal on every load", async () => {
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
      expect(detail.detail.evidence.map((e) => e.quote)).toEqual(["we leave on the 30th.", "I will book the cabin.", "Ana pays the deposit."]);
      expect(detail.detail.evidence[0]!.quote).toBe(why.view.quote?.quote);
      expect(detail.detail.origin?.band).toBe("high");
    }
    expect([...seen]).toEqual(["we leave on the 30th.|high"]);
  });

  it("an earlier created_at beats a smaller id", async () => {
    const a = users[0]!;
    const quote = "Line one:";
    const early = await admin.from("evidence").insert({
      id: idStarting("f"),
      user_id: a.id,
      source_id: sourceId,
      thread_id: threadId,
      quote,
      start_offset: 0,
      end_offset: quote.length,
      match_kind: "exact",
      created_at: "2026-10-21T08:59:59Z",
    });
    expect(early.error).toBeNull();
    const why = await loadWhy(a.client, threadId, "UTC", new Date());
    expect(why.ok && why.view.quote?.quote).toBe(quote);
    const detail = await getThreadDetail(a.client, threadId);
    expect(detail.ok && detail.detail.evidence[0]!.quote).toBe(quote);
    await admin.from("evidence").delete().eq("quote", quote).eq("thread_id", threadId);
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
