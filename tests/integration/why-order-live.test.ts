/**
 * F8 Why panel and Thread detail pick the same first quote and the same proposal on every load
 * (tester finding on test/s9b-s10-verify): rows are ordered by (created_at, id), not by a uuid or
 * not at all. Real local Supabase; skipped unless LE_SUPABASE_LIVE=1 (`pnpm test:supabase`).
 * Throwaway user, synthetic text only, no model. Never resets the database.
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

/** A random uuid whose first hex digit is fixed, so the uuid order is the opposite of creation order. */
const idStarting = (digit: "0" | "f") => digit + randomUUID().slice(1);

describe.skipIf(!live)("Why panel and Thread detail order evidence and proposals by (created_at, id)", () => {
  let admin: SupabaseClient;
  let user: { id: string; client: SupabaseClient };

  beforeAll(async () => {
    const e = env();
    admin = createClient(e.url, e.service, opts);
    const email = `le-test-whyorder-${randomUUID().slice(0, 6)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    const client = createClient(e.url, e.anon, opts);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
    user = { id: data.user.id, client };
  }, 60_000);

  afterAll(async () => {
    if (user) await admin.auth.admin.deleteUser(user.id);
  });

  it("the earliest evidence row and proposal win, though their uuids sort last; the same on every load", async () => {
    const text = "Earliest line: I will send the cedar quote Friday. Later line: the fence goes in Monday.";
    const src = await admin.from("sources").insert({ user_id: user.id, kind: "paste", text_content: text, reference_date: "2026-10-20", reference_date_source: "user" }).select("id").single();
    expect(src.error).toBeNull();
    const ex = await admin
      .from("extractions")
      .insert({ user_id: user.id, source_id: src.data!.id, status: "succeeded", model: "fake:recorded", prompt_version: "extract.v1", schema_version: "extraction.v1" })
      .select("id")
      .single();
    expect(ex.error).toBeNull();
    const t = await admin.from("threads").insert({ user_id: user.id, title: "Send the cedar quote", kind: "commitment", status: "open", primary_source_id: src.data!.id }).select("id").single();
    expect(t.error).toBeNull();
    const threadId = t.data!.id as string;

    const item = (index: number, id: string, band: string, createdAt: string) => ({
      id,
      item_index: index,
      user_id: user.id,
      extraction_id: ex.data!.id,
      band,
      confidence: band === "high" ? 0.9 : 0.6,
      review_status: "accepted",
      thread_id: threadId,
      created_at: createdAt,
      payload: { item: { type: "commitment", title: "Send the cedar quote" }, label: { word: band === "high" ? "Likely" : "Maybe", reason: "synthetic" } },
    });
    const items = await admin.from("extraction_items").insert([
      item(0, idStarting("f"), "high", "2026-10-20T10:00:00Z"),
      item(1, idStarting("0"), "medium", "2026-10-20T11:00:00Z"),
    ]);
    expect(items.error).toBeNull();

    const evidence = (id: string, quote: string, createdAt: string) => ({
      id,
      user_id: user.id,
      source_id: src.data!.id,
      thread_id: threadId,
      quote,
      start_offset: text.indexOf(quote),
      end_offset: text.indexOf(quote) + quote.length,
      match_kind: "exact",
      created_at: createdAt,
    });
    const ev = await admin.from("evidence").insert([
      evidence(idStarting("f"), "I will send the cedar quote Friday.", "2026-10-20T10:00:00Z"),
      evidence(idStarting("0"), "the fence goes in Monday.", "2026-10-20T11:00:00Z"),
    ]);
    expect(ev.error).toBeNull();

    for (let i = 0; i < 3; i++) {
      const why = await loadWhy(user.client, threadId, "UTC", new Date());
      expect(why.ok).toBe(true);
      if (!why.ok) return;
      expect(why.view.quote?.quote).toBe("I will send the cedar quote Friday.");
      expect(why.view.origin?.band).toBe("high");
    }

    const detail = await getThreadDetail(user.client, threadId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.detail.evidence.map((e) => e.quote)).toEqual(["I will send the cedar quote Friday.", "the fence goes in Monday."]);
    expect(detail.detail.origin?.band).toBe("high");
  });
});
