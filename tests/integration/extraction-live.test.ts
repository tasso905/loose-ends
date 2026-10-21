/**
 * S2 extraction functions against REAL local Supabase (PostgREST, Auth, RLS). Skipped unless
 * LE_SUPABASE_LIVE=1 (`pnpm test:supabase`); then it fails, never skips, if Supabase is unreachable.
 * Throwaway users (le-test-*@example.com), synthetic text only, deleted at the end.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readExtraction, retryExtraction, startExtraction, type RpcDb } from "@/lib/extraction/service";

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

const db = (c: SupabaseClient): RpcDb => ({ rpc: (fn, args) => c.rpc(fn, args) });
const NOW = () => new Date(Date.now());

describe.skipIf(!live)("real local Supabase: S2 extraction functions", () => {
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
    users.push({ id: data.user.id, client });
    return { id: data.user.id, client };
  }

  beforeAll(async () => {
    e = env();
    admin = createClient(e.url, e.service, opts);
    anon = createClient(e.url, e.anon, opts);
    await makeUser("s2a");
    await makeUser("s2b");
  });

  afterAll(async () => {
    for (const u of users) await admin.auth.admin.deleteUser(u.id);
  });

  it("start → read is scoped to the owner; another user gets not found and cannot change it", async () => {
    const [a, b] = users as [(typeof users)[0], (typeof users)[0]];
    const started = await startExtraction(db(a.client), { text: "Synthetic live note.", title: null, writtenOn: null }, { now: NOW() });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.extractionId;

    expect(await readExtraction(db(a.client), id, { now: NOW() })).toMatchObject({ status: "running", stage: "reading" });
    expect(await readExtraction(db(b.client), id, { now: NOW() })).toBeNull();
    expect(await retryExtraction(db(b.client), id)).toMatchObject({ ok: false, notFound: true });

    const stage = await b.client.rpc("set_extraction_stage", { p_extraction_id: id, p_stage: "checking" });
    expect(stage.data).toBe(false);
    const fail = await b.client.rpc("fail_extraction", { p_extraction_id: id, p_error: "x", p_model: null, p_latency_ms: null, p_raw_output: null });
    expect(fail.data).toBe(false);
    const done = await b.client.rpc("complete_extraction", {
      p_extraction_id: id, p_model: "x", p_input_tokens: null, p_output_tokens: null, p_latency_ms: null,
      p_raw_output: null, p_brief: null, p_items: [],
    });
    expect(done.data).toEqual({ ok: false, reason: "not_found" });
    const ctx = await b.client.rpc("extraction_context", { p_extraction_id: id });
    expect(ctx.data).toBeNull();

    const { data: row } = await admin.from("extractions").select("status, stage").eq("id", id).single();
    expect(row).toEqual({ status: "running", stage: "reading" });
    const { data: src } = await admin.from("sources").select("reference_date_source").eq("id", started.sourceId).single();
    expect(src).toEqual({ reference_date_source: "defaulted" });
  });

  it("anon cannot call any extraction function", async () => {
    const id = randomUUID();
    for (const [fn, args] of [
      ["start_source_extraction", { p_kind: "paste", p_text: "x", p_title: null, p_reference_date: null, p_now: NOW().toISOString(), p_model: "m", p_prompt_version: "p", p_schema_version: "s" }],
      ["get_extraction", { p_extraction_id: id, p_now: NOW().toISOString() }],
      ["retry_extraction", { p_extraction_id: id, p_model: "m", p_prompt_version: "p", p_schema_version: "s" }],
      ["extraction_context", { p_extraction_id: id }],
    ] as const) {
      const res = await anon.rpc(fn, args);
      expect(res.error, fn).not.toBeNull();
    }
  });

  it("a user cannot write extraction_items into another user's extraction", async () => {
    const [a, b] = users as [(typeof users)[0], (typeof users)[0]];
    const started = await startExtraction(db(a.client), { text: "Second synthetic live note.", title: null, writtenOn: "2026-10-05" }, { now: NOW() });
    if (!started.ok) throw new Error("start failed");
    const { error } = await b.client.from("extraction_items").insert({
      user_id: b.id, extraction_id: started.extractionId, payload: {}, confidence: 0.5, band: "medium", item_index: 0,
    });
    expect(error).not.toBeNull();
  });
});
