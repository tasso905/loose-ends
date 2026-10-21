/**
 * Lead-tester S2 checks against REAL local Supabase (PostgREST, Auth, RLS, real grants). Skipped
 * unless LE_SUPABASE_LIVE=1 (`pnpm test:supabase`). Throwaway users (le-test-*@example.com),
 * synthetic text only, deleted at the end. Never resets the database.
 *
 * Tests marked `it.fails` pin a defect found in S2 verification: they assert the SAFE behaviour and
 * currently fail. When the defect is fixed the test starts passing, `it.fails` turns red, and the
 * marker must be removed (flip it to `it`).
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecordedModel, Recording } from "@/lib/ai/fake";
import { readExtraction, retryExtraction, runExtraction, startExtraction, type RpcDb } from "@/lib/extraction/service";

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
const at = (base: string, deltaS: number) => new Date(new Date(base).getTime() + deltaS * 1000).toISOString();

const ALL_FNS = [
  ["start_source_extraction", { p_kind: "paste", p_text: "x", p_title: null, p_reference_date: null, p_now: new Date(0).toISOString(), p_model: "m", p_prompt_version: "p", p_schema_version: "s" }],
  ["retry_extraction", { p_extraction_id: randomUUID(), p_model: "m", p_prompt_version: "p", p_schema_version: "s" }],
  ["extraction_context", { p_extraction_id: randomUUID() }],
  ["set_extraction_stage", { p_extraction_id: randomUUID(), p_stage: "finding" }],
  ["complete_extraction", { p_extraction_id: randomUUID(), p_model: "m", p_input_tokens: null, p_output_tokens: null, p_latency_ms: null, p_raw_output: null, p_brief: null, p_items: [] }],
  ["fail_extraction", { p_extraction_id: randomUUID(), p_error: "x", p_model: null, p_latency_ms: null, p_raw_output: null }],
  ["get_extraction", { p_extraction_id: randomUUID(), p_now: new Date(0).toISOString() }],
] as const;

describe.skipIf(!live)("tester S2: extraction lifecycle on real local Supabase", () => {
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

  async function usage(uid: string): Promise<number> {
    const { data } = await admin.from("usage_counters").select("extractions").eq("user_id", uid);
    return (data ?? []).reduce((n, r) => n + (r.extractions as number), 0);
  }
  async function count(table: string, uid: string): Promise<number> {
    const { count: n, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq("user_id", uid);
    if (error) throw error;
    return n ?? 0;
  }
  async function start(c: SupabaseClient, text: string, writtenOn: string | null = "2026-10-05") {
    const r = await startExtraction(rpc(c), { text, title: null, writtenOn }, { now: now() });
    if (!r.ok) throw new Error(`start failed: ${r.error.error.code}`);
    return r;
  }

  beforeAll(async () => {
    e = env();
    admin = createClient(e.url, e.service, opts);
    anon = createClient(e.url, e.anon, opts);
  });

  afterAll(async () => {
    for (const u of users) await admin.auth.admin.deleteUser(u.id);
  });

  it("grants: anon can execute none of the seven S2 functions; no function is SECURITY DEFINER", async () => {
    for (const [fn, args] of ALL_FNS) {
      const res = await anon.rpc(fn, args);
      expect(res.error, fn).not.toBeNull();
      expect(res.error?.code, fn).toBe("42501"); // permission denied, not merely "not authenticated"
    }
  });

  it("cross-user: B cannot read, poll, time out, stage, fail, complete or retry A's extraction, by RPC or PostgREST", async () => {
    const a = await makeUser("s2xa");
    const b = await makeUser("s2xb");
    const s = await start(a.client, "Synthetic cross-user note.");
    const id = s.extractionId;

    // B's poll with a far-future clock must not mark A's row failed (the 90 s update is user-scoped).
    expect((await b.client.rpc("get_extraction", { p_extraction_id: id, p_now: "2099-01-01T00:00:00Z" })).data).toBeNull();
    expect((await b.client.rpc("extraction_context", { p_extraction_id: id })).data).toBeNull();
    expect((await b.client.rpc("set_extraction_stage", { p_extraction_id: id, p_stage: "checking" })).data).toBe(false);
    expect((await b.client.rpc("fail_extraction", { p_extraction_id: id, p_error: "x", p_model: null, p_latency_ms: null, p_raw_output: null })).data).toBe(false);
    const forged = [{ item_index: 0, payload: { v: 1 }, confidence: 0.9, band: "high", suppression_hash: "h", evidence: [{ quote: "q", start_offset: 0, end_offset: 1, page: null, match_kind: "exact", quote_hash: "x" }] }];
    expect((await b.client.rpc("complete_extraction", { p_extraction_id: id, p_model: "x", p_input_tokens: 1, p_output_tokens: 1, p_latency_ms: 1, p_raw_output: null, p_brief: null, p_items: forged })).data).toEqual({ ok: false, reason: "not_found" });
    expect((await b.client.rpc("retry_extraction", { p_extraction_id: id, p_model: "m", p_prompt_version: "p", p_schema_version: "s" })).data).toBeNull();

    // PostgREST tables.
    expect((await b.client.from("extractions").select("id").eq("id", id)).data).toEqual([]);
    expect((await b.client.from("sources").select("id, text_content").eq("id", s.sourceId)).data).toEqual([]);
    const upd = await b.client.from("extractions").update({ status: "failed" }).eq("id", id).select("id");
    expect(upd.data ?? []).toEqual([]);
    const del = await b.client.from("sources").delete().eq("id", s.sourceId).select("id");
    expect(del.data ?? []).toEqual([]);

    // A's rows are untouched; nothing was written under A.
    const { data: row } = await admin.from("extractions").select("status, stage, error").eq("id", id).single();
    expect(row).toEqual({ status: "running", stage: "reading", error: null });
    expect(await count("extraction_items", a.id)).toBe(0);
    expect(await count("evidence", a.id)).toBe(0);
    expect(await count("extraction_items", b.id)).toBe(0);
  });

  it("start is all-or-nothing: invalid input is refused before counting; a failing insert rolls back consume_usage", async () => {
    const a = await makeUser("s2atom");
    const base = { p_kind: "paste", p_title: null, p_reference_date: "2026-10-05", p_now: now().toISOString(), p_model: "m", p_prompt_version: "p", p_schema_version: "s" };
    expect((await a.client.rpc("start_source_extraction", { ...base, p_text: "x".repeat(30_001) })).error?.code).toBe("22023");
    expect((await a.client.rpc("start_source_extraction", { ...base, p_text: "     " })).error?.code).toBe("22023");
    expect((await a.client.rpc("start_source_extraction", { ...base, p_text: "ok", p_title: "t".repeat(121) })).error?.code).toBe("22023");
    expect((await a.client.rpc("start_source_extraction", { ...base, p_text: "ok", p_kind: "upload" })).error).not.toBeNull();
    // extractions.model is NOT NULL: this fails AFTER consume_usage and the sources insert.
    expect((await a.client.rpc("start_source_extraction", { ...base, p_text: "ok", p_model: null })).error).not.toBeNull();
    expect(await usage(a.id)).toBe(0);
    expect(await count("sources", a.id)).toBe(0);
    expect(await count("extractions", a.id)).toBe(0);
    // Exactly 30,000 is accepted (boundary is inclusive).
    expect((await a.client.rpc("start_source_extraction", { ...base, p_text: "y".repeat(30_000) })).data).toHaveProperty("extraction_id");
    expect(await usage(a.id)).toBe(1);
  });

  // DEFECT S2-5 (minor): the SQL backstop uses btrim(p_text), which strips spaces only, so text that
  // is only newlines/tabs passes start_source_extraction (counted, stored). The form and Zod reject
  // it (String.trim), so only a direct RPC call reaches this.
  it("SQL backstop refuses whitespace-only text that contains newlines or tabs", async () => {
    const a = await makeUser("s2ws");
    const res = await a.client.rpc("start_source_extraction", {
      p_kind: "paste", p_text: " \n\t\n ", p_title: null, p_reference_date: "2026-10-05", p_now: now().toISOString(), p_model: "m", p_prompt_version: "p", p_schema_version: "s",
    });
    expect(res.error?.code).toBe("22023");
    expect(await usage(a.id)).toBe(0);
  });

  it("rate limit: two concurrent submissions at 29/30 → exactly one succeeds; the 31st stores nothing", async () => {
    const a = await makeUser("s2rl");
    for (let i = 0; i < 29; i++) await start(a.client, `Synthetic rate note ${i}`);
    const both = await Promise.all([0, 1].map((i) => startExtraction(rpc(a.client), { text: `Race ${i}`, title: null, writtenOn: null }, { now: now() })));
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    const rejected = both.find((r) => !r.ok);
    expect(rejected && !rejected.ok && rejected.error.error).toEqual({
      code: "rate_limited",
      message: "You've reached today's limit of 30 sources. It resets at midnight (UTC).",
      retryable: false,
    });
    expect(await usage(a.id)).toBe(30);
    expect(await count("sources", a.id)).toBe(30);
    expect(await count("extractions", a.id)).toBe(30);
  });

  it("double retry: concurrent Try again on one failed attempt starts one new attempt, never two, and is not counted", async () => {
    const a = await makeUser("s2dr");
    const s = await start(a.client, MALFORMED.input!);
    expect(await runExtraction(rpc(a.client), s.extractionId, { model: createRecordedModel({ recordings: [MALFORMED] }), logger: () => {} })).toBe("failed");
    const before = await usage(a.id);
    const rs = await Promise.all([0, 1, 2].map(() => retryExtraction(rpc(a.client), s.extractionId, { logger: () => {} })));
    const ids = new Set(rs.map((r) => (r.ok ? r.extractionId : "x")));
    expect(ids.size).toBe(1);
    expect(ids.has("x")).toBe(false);
    const { data: rows } = await admin.from("extractions").select("id, status").eq("source_id", s.sourceId);
    expect(rows).toHaveLength(2);
    expect(await usage(a.id)).toBe(before);
  });

  // DEFECT S2-2: the second Try again (double click, two tabs) returns the attempt already started
  // with ok: true, and retryExtractionAction then schedules runExtraction for it AGAIN. Both runs
  // read status "running" and both call the model; the loser's complete is skipped. Two paid LLM
  // calls for one attempt. Safe behaviour: one model call.
  it("double retry does not run the pipeline twice for the same attempt (one model call)", async () => {
    const a = await makeUser("s2dr2");
    const s = await start(a.client, MALFORMED.input!);
    await runExtraction(rpc(a.client), s.extractionId, { model: createRecordedModel({ recordings: [MALFORMED] }), logger: () => {} });
    const first = await retryExtraction(rpc(a.client), s.extractionId, { logger: () => {} });
    const second = await retryExtraction(rpc(a.client), s.extractionId, { logger: () => {} });
    // What retryExtractionAction does for each successful result: after(() => runExtraction(...)).
    const model = createRecordedModel({ recordings: [{ ...MALFORMED, delay_ms: 300 }] });
    const runs = [first, second].filter((r) => r.ok).map((r) => runExtraction(rpc(a.client), (r as { extractionId: string }).extractionId, { model, logger: () => {} }));
    await Promise.all(runs);
    expect(model.doGenerateCalls.length).toBeLessThanOrEqual(2); // one attempt = one call + at most one internal retry (D43)
  });

  // DEFECT S2-1 (rate limit / LLM budget bypass): extractions_own and sources_own are FOR ALL, so a
  // signed-in user can INSERT a source and a FAILED extraction directly through PostgREST without
  // consume_usage, then call Try again (retry_extraction, not counted) to make the server run the
  // model. Safe behaviour: an attempt never starts unless it was counted once.
  it("a source + failed extraction inserted directly via PostgREST cannot be retried into an uncounted model run", async () => {
    const a = await makeUser("s2byp");
    const { data: src, error: e1 } = await a.client
      .from("sources")
      .insert({ user_id: a.id, kind: "paste", text_content: "Uncounted synthetic text.", reference_date: "2026-10-05", reference_date_source: "user" })
      .select("id")
      .single();
    const { data: ex, error: e2 } = await a.client
      .from("extractions")
      .insert({ user_id: a.id, source_id: src?.id, status: "failed", model: "m", prompt_version: "p", schema_version: "s" })
      .select("id")
      .single();
    const retry = e1 || e2 ? null : await retryExtraction(rpc(a.client), ex!.id, { logger: () => {} });
    // Evidence of the defect when this fails: retry.ok === true and usage is still 0.
    expect({ insertsRefused: Boolean(e1 || e2), retryOk: retry?.ok ?? false, usage: await usage(a.id) }).toMatchObject({ retryOk: false });
  });

  // DEFECT S2-1b: after any attempt finishes, the owner can UPDATE extractions.status back to
  // 'failed' via PostgREST and press Try again again: unlimited uncounted model runs from one count.
  it("the owner cannot flip a finished attempt back to failed to get another uncounted run", async () => {
    const a = await makeUser("s2loop");
    const s = await start(a.client, MALFORMED.input!);
    await runExtraction(rpc(a.client), s.extractionId, { model: createRecordedModel({ recordings: [MALFORMED] }), logger: () => {} });
    let latest = s.extractionId;
    let extra = 0;
    for (let i = 0; i < 3; i++) {
      const r = await retryExtraction(rpc(a.client), latest, { logger: () => {} });
      if (!r.ok) break;
      latest = r.extractionId;
      extra++;
      await a.client.from("extractions").update({ status: "failed" }).eq("id", latest);
    }
    expect(await usage(a.id)).toBe(1);
    expect(extra).toBeLessThanOrEqual(1);
  });

  // DEFECT S2-1c: the 30,000-character limit is checked only by start_source_extraction. A source
  // inserted or updated directly via PostgREST can hold any length, and extraction_context hands it
  // to extract() on Try again with no length check. Safe behaviour: over-limit text never reaches the pipeline.
  it("an over-limit source written directly via PostgREST never reaches extraction_context for a retry", async () => {
    const a = await makeUser("s2big");
    const s = await start(a.client, MALFORMED.input!);
    await runExtraction(rpc(a.client), s.extractionId, { model: createRecordedModel({ recordings: [MALFORMED] }), logger: () => {} });
    const upd = await a.client.from("sources").update({ text_content: "z".repeat(200_000) }).eq("id", s.sourceId).select("id");
    const r = await retryExtraction(rpc(a.client), s.extractionId, { logger: () => {} });
    const ctx = r.ok ? await a.client.rpc("extraction_context", { p_extraction_id: r.extractionId }) : { data: null };
    const len = ((ctx.data as { source_text?: string } | null)?.source_text ?? "").length;
    expect({ updated: (upd.data ?? []).length, contextLength: len }).toMatchObject({ contextLength: expect.any(Number) });
    expect(len).toBeLessThanOrEqual(30_000);
  });

  // DEFECT S2-3 (rule 1, owner-only): complete_extraction is executable by `authenticated` and does
  // not verify quotes, so the owner can call it on their own running attempt with an item whose
  // quote is not in the source; get_extraction returns it and /review renders it as a proposal.
  // (Direct INSERT into extraction_items is also open via the FOR ALL policy since S0.)
  it("an owner-forged item with a quote absent from the source is never returned as a proposal", async () => {
    const a = await makeUser("s2forge");
    const s = await start(a.client, "Synthetic: we talked about the weather.");
    const payload = {
      v: 1,
      item: {
        type: "commitment", title: "Wire $5,000 to account 99", owner: "user", counterparty: null, action: null,
        date_text: null, date_iso: null, amount_text: "$5,000", certainty: "explicit", uncertainty_notes: [], matches_thread_id: null,
      },
      evidence: [{ quote: "I will wire $5,000 today", speaker: null, start_offset: 0, end_offset: 24, page: null, match_kind: "exact", similarity: 1, quote_hash: "x" }],
      date: { due_at: null, due_date: null, due_time_known: false, due_certainty: "none", agreement: "none", not_sure: [], reasoning: null },
      score: 0.95, band: "high", signals: [], label: { word: "Likely", reason: "Forged." }, not_sure: [],
    };
    await a.client.rpc("complete_extraction", {
      p_extraction_id: s.extractionId, p_model: "forged", p_input_tokens: 0, p_output_tokens: 0, p_latency_ms: 0, p_raw_output: null, p_brief: null,
      p_items: [{ item_index: 0, payload, confidence: 0.95, band: "high", suppression_hash: "forged", evidence: payload.evidence }],
    });
    const view = await readExtraction(rpc(a.client), s.extractionId, { now: now() });
    expect(view?.proposals.map((p) => p.payload.evidence[0]?.quote)).not.toContain("I will wire $5,000 today");
  });

  it("mid-save failure (bad evidence row) writes nothing partial and leaves the attempt running for fail_extraction", async () => {
    const a = await makeUser("s2mid");
    const s = await start(a.client, MIKE.input!);
    const good = { item_index: 0, payload: { v: 1 }, confidence: 0.9, band: "high", suppression_hash: "g", evidence: [{ quote: "I'll send", start_offset: 0, end_offset: 9, page: null, match_kind: "exact", quote_hash: "q" }] };
    const bad = { ...good, item_index: 1, suppression_hash: "b", evidence: [{ ...good.evidence[0], match_kind: "invented" }] };
    const res = await a.client.rpc("complete_extraction", { p_extraction_id: s.extractionId, p_model: "m", p_input_tokens: 1, p_output_tokens: 1, p_latency_ms: 1, p_raw_output: null, p_brief: null, p_items: [good, bad] });
    expect(res.error).not.toBeNull();
    expect(await count("extraction_items", a.id)).toBe(0);
    expect(await count("evidence", a.id)).toBe(0);
    const { data: row } = await admin.from("extractions").select("status").eq("id", s.extractionId).single();
    expect(row?.status).toBe("running");
  });

  it("full run on real Supabase: verified items only, Ignore stored not returned, Low returned, no thread created, trace fields recorded", async () => {
    const a = await makeUser("s2run");
    const s = await start(a.client, MIKE.input!, "2026-10-05");
    expect(await runExtraction(rpc(a.client), s.extractionId, { model: createRecordedModel({ recordings: [MIKE] }), logger: () => {} })).toBe("succeeded");
    const view = await readExtraction(rpc(a.client), s.extractionId, { now: now() });
    expect(view?.status).toBe("succeeded");
    const quotes = view!.proposals.flatMap((p) => p.payload.evidence.map((ev) => ev.quote));
    for (const q of quotes) expect(MIKE.input!).toContain(q); // rule 1: every returned quote is in the source
    expect(view!.proposals.map((p) => p.payload.item.title)).not.toContain("Call the insurer");
    expect(view!.proposals.some((p) => p.band === "low")).toBe(true);
    // Rule 2: nothing became a thread.
    expect(await count("threads", a.id)).toBe(0);
    expect(view!.proposals.every((p) => p.threadId === null && p.reviewStatus === "pending")).toBe(true);
    // Rule 3: chrono's date for "Friday" written Mon Oct 5 is Fri Oct 9.
    const send = view!.proposals.find((p) => p.payload.item.title === "Send revised proposal to Mike");
    expect(send?.payload.date.due_date).toBe("2026-10-09");
    // F5: trace fields.
    const { data: ex } = await admin.from("extractions").select("model, prompt_version, schema_version, input_tokens, output_tokens, latency_ms, raw_output").eq("id", s.extractionId).single();
    expect(ex?.model).toBeTruthy();
    expect(ex?.prompt_version).toBeTruthy();
    expect(ex?.schema_version).toBeTruthy();
    expect(ex?.input_tokens).toBeGreaterThan(0);
    expect(ex?.output_tokens).toBeGreaterThan(0);
    expect(ex?.latency_ms).not.toBeNull();
    expect(ex?.raw_output).not.toBeNull();
  });

  it("rule 3: with a written-on date that makes the model's date wrong, chrono's value is kept, marked inferred, with a Not sure line", async () => {
    const a = await makeUser("s2date");
    // Written Mon Oct 12: "Friday" is Oct 16; the recording's model says 2026-10-09.
    const s = await start(a.client, MIKE.input!, "2026-10-12");
    expect(await runExtraction(rpc(a.client), s.extractionId, { model: createRecordedModel({ recordings: [MIKE] }), logger: () => {} })).toBe("succeeded");
    const view = await readExtraction(rpc(a.client), s.extractionId, { now: now() });
    const send = view!.proposals.find((p) => p.payload.item.title === "Send revised proposal to Mike")!;
    expect(send.payload.date).toMatchObject({ due_date: "2026-10-16", agreement: "disagree", due_certainty: "inferred" });
    expect(send.payload.date.not_sure.length + send.payload.not_sure.length).toBeGreaterThan(0);
    // Never filled: the speculative lunch item has no date.
    const lunch = view!.proposals.find((p) => p.payload.item.title === "Lunch with Mike");
    expect(lunch?.payload.date.due_date ?? null).toBeNull();
  });

  it("Ignore-band rows are stored but never returned by get_extraction", async () => {
    const a = await makeUser("s2ign");
    const s = await start(a.client, "Synthetic ignore source text.");
    const mk = (i: number, band: string) => ({
      item_index: i, payload: { v: 1 }, confidence: 0.1, band, suppression_hash: `h${i}`,
      evidence: [{ quote: "Synthetic", start_offset: 0, end_offset: 9, page: null, match_kind: "exact", quote_hash: `q${i}` }],
    });
    const done = await a.client.rpc("complete_extraction", { p_extraction_id: s.extractionId, p_model: "m", p_input_tokens: 1, p_output_tokens: 1, p_latency_ms: 1, p_raw_output: null, p_brief: null, p_items: [mk(0, "ignore"), mk(1, "low")] });
    expect(done.error).toBeNull();
    expect(await count("extraction_items", a.id)).toBe(2);
    const raw = (await a.client.rpc("get_extraction", { p_extraction_id: s.extractionId, p_now: now().toISOString() })).data as { proposals: Array<{ band: string }> };
    expect(raw.proposals.map((p) => p.band)).toEqual(["low"]);
  });

  it("the 90 s rule with a faked clock: running at +89 s (slow from +45 s), failed 'timeout' at +91 s; a late complete writes nothing", async () => {
    const a = await makeUser("s2stale");
    const s = await start(a.client, MIKE.input!);
    const { data: row } = await admin.from("extractions").select("created_at").eq("id", s.extractionId).single();
    const created = row!.created_at as string;

    const v44 = await readExtraction(rpc(a.client), s.extractionId, { now: new Date(at(created, 44)) });
    expect(v44).toMatchObject({ status: "running", slow: false });
    const v45 = await readExtraction(rpc(a.client), s.extractionId, { now: new Date(at(created, 45)) });
    expect(v45).toMatchObject({ status: "running", slow: true });
    const v89 = await readExtraction(rpc(a.client), s.extractionId, { now: new Date(at(created, 89.9)) });
    expect(v89?.status).toBe("running");
    // Exactly 90 s is still running (strict "older than 90 s").
    const v90 = await readExtraction(rpc(a.client), s.extractionId, { now: new Date(at(created, 90)) });
    expect(v90?.status).toBe("running");
    const v91 = await readExtraction(rpc(a.client), s.extractionId, { now: new Date(at(created, 91)) });
    expect(v91).toMatchObject({ status: "failed", slow: false, error: { code: "extraction_failed" } });
    const { data: after } = await admin.from("extractions").select("status, error, stage").eq("id", s.extractionId).single();
    expect(after).toEqual({ status: "failed", error: "timeout", stage: null });

    // The pipeline finishing late is skipped, writes nothing, and (developer's noted gap) reports nothing.
    let reported = 0;
    const outcome = await runExtraction(rpc(a.client), s.extractionId, { model: createRecordedModel({ recordings: [MIKE] }), logger: () => {}, onComplete: () => void reported++ });
    expect(outcome).toBe("skipped");
    expect(reported).toBe(0);
    expect(await count("extraction_items", a.id)).toBe(0);
    // A poll with an earlier clock never revives it.
    expect((await readExtraction(rpc(a.client), s.extractionId, { now: new Date(at(created, 1)) }))?.status).toBe("failed");
  });
});
