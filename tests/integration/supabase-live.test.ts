/**
 * Lead-tester: RLS, rate-limit and deletion checks against REAL local Supabase (Auth, PostgREST,
 * Storage), with real auth users and the anon / authenticated roles. Complements the PGlite tests,
 * which use stand-ins for auth and storage.
 *
 * Skipped unless LE_SUPABASE_LIVE=1. Then it reads URL and keys from `supabase status -o json`
 * (or LE_SUPABASE_URL / LE_SUPABASE_ANON_KEY / LE_SUPABASE_SERVICE_ROLE_KEY). With LE_SUPABASE_LIVE=1
 * it FAILS (never skips) when the env cannot be resolved or /auth/v1/health is not reachable. Run: LE_SUPABASE_LIVE=1 pnpm vitest run tests/integration/supabase-live.test.ts
 * Creates throwaway users (le-test-*@example.com) and deletes them at the end. Synthetic data only.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAccount, type AccountAdminClient } from "@/lib/account/deleteAccount";

interface Env {
  url: string;
  anon: string;
  service: string;
}

function loadEnv(): Env | null {
  if (process.env.LE_SUPABASE_LIVE !== "1") return null;
  if (process.env.LE_SUPABASE_URL && process.env.LE_SUPABASE_ANON_KEY && process.env.LE_SUPABASE_SERVICE_ROLE_KEY) {
    return { url: process.env.LE_SUPABASE_URL, anon: process.env.LE_SUPABASE_ANON_KEY, service: process.env.LE_SUPABASE_SERVICE_ROLE_KEY };
  }
  try {
    const out = execSync("pnpm exec supabase status -o json", { stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).toString();
    const j = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string>;
    if (!j.API_URL || !j.ANON_KEY || !j.SERVICE_ROLE_KEY) throw new Error("supabase status returned no API_URL or keys");
    return { url: j.API_URL, anon: j.ANON_KEY, service: j.SERVICE_ROLE_KEY };
  } catch (e) {
    // LE_SUPABASE_LIVE=1 means "run the live suite": a silent skip would read as a pass.
    throw new Error(`LE_SUPABASE_LIVE=1 but local Supabase env could not be resolved: ${(e as Error).message}`);
  }
}

/** Fails the suite when Auth is not reachable, so `pnpm test:supabase` cannot pass by skipping. */
async function assertReachable(e: Env): Promise<void> {
  const res = await fetch(`${e.url}/auth/v1/health`, { headers: { apikey: e.anon } }).catch((err: Error) => {
    throw new Error(`Supabase Auth not reachable at ${e.url}: ${err.message}`);
  });
  if (!res.ok) throw new Error(`Supabase Auth health check failed: HTTP ${res.status}`);
}

const env = loadEnv();
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const TOKEN = `zq${randomUUID().slice(0, 8)}`; // unique content marker for leftover scans
const RUN = randomUUID().slice(0, 8); // hash suffix (not content)
const has = (v: unknown) => new RegExp(TOKEN, "i").test(JSON.stringify(v));

const TABLES = [
  ["profiles", "id"],
  ["user_settings", "user_id"],
  ["sources", "user_id"],
  ["extractions", "user_id"],
  ["threads", "user_id"],
  ["extraction_items", "user_id"],
  ["evidence", "user_id"],
  ["thread_events", "user_id"],
  ["decisions", "user_id"],
  ["usage_counters", "user_id"],
  ["suppressions", "user_id"],
] as const;

interface User {
  id: string;
  email: string;
  client: SupabaseClient;
}

interface Graph {
  source: string;
  extraction: string;
  thread: string;
  item: string;
  path: string;
}

let admin: SupabaseClient;
let anon: SupabaseClient;
const created: string[] = [];

async function makeUser(tag: string): Promise<User> {
  const email = `le-test-${tag}-${randomUUID().slice(0, 6)}@example.com`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  created.push(data.user.id);
  const client = createClient(env!.url, env!.anon, opts);
  const s = await client.auth.signInWithPassword({ email, password });
  if (s.error) throw s.error;
  return { id: data.user.id, email, client };
}

/**
 * A full graph owned by `u`. Rows are written with the service role: users have no direct writes
 * to the trust tables (migration 20261021115926; they go through definer functions). The file is
 * uploaded with the user's own session, so storage RLS is still exercised.
 */
async function seed(u: User, tag: string): Promise<Graph> {
  const c = u.client;
  const quote = `I'll send the ${TOKEN} proposal ${tag} Friday`;
  const ins = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await admin.from(table).insert(row).select().single();
    if (error) throw new Error(`${table}: ${error.message}`);
    return data as { id: string };
  };
  const source = await ins("sources", {
    user_id: u.id,
    kind: "upload",
    text_content: `${quote}. Also the parrot memo.`,
    reference_date: "2026-10-05",
    reference_date_source: "user",
  });
  const path = `${u.id}/${source.id}.txt`;
  const up = await c.storage.from("sources").upload(path, new Blob([`${quote}`], { type: "text/plain" }));
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const sp = await admin.from("sources").update({ storage_path: path }).eq("id", source.id);
  if (sp.error) throw new Error(`sources.storage_path: ${sp.error.message}`);
  const brief = {
    what_this_is: [{ text: "A note about a proposal", basis: "interpretation", quote: null }],
    what_to_do: [
      { text: `Send the ${TOKEN} proposal`, basis: "source", quote },
      { text: "Read the parrot memo", basis: "source", quote: "Also the parrot memo" },
    ],
    by_when: [],
    if_you_dont: [],
    worth_considering: [],
    not_sure_about: [],
  };
  const extraction = await ins("extractions", {
    user_id: u.id,
    source_id: source.id,
    status: "succeeded",
    model: "fake:recorded",
    prompt_version: "extract.v1",
    schema_version: "extraction.v1",
    raw_output: { source_summary: "Note", participants: [], items: [{ title: `Send ${TOKEN} ${tag}`, evidence: [{ quote }] }], brief },
    brief,
  });
  const thread = await ins("threads", { user_id: u.id, title: `Send ${TOKEN} ${tag}`, kind: "commitment", primary_source_id: source.id });
  const item = await ins("extraction_items", {
    user_id: u.id,
    extraction_id: extraction.id,
    payload: { title: `Send ${TOKEN} ${tag}`, evidence: [{ quote }] },
    confidence: 0.95,
    band: "high",
    review_status: "accepted",
    thread_id: thread.id,
    suppression_hash: `hash-${tag}-${RUN}`,
    item_index: 0,
  });
  await ins("evidence", { user_id: u.id, source_id: source.id, thread_id: thread.id, extraction_item_id: item.id, quote, match_kind: "exact" });
  await ins("thread_events", { user_id: u.id, thread_id: thread.id, actor: "user", type: "created", after: { title: `Send ${TOKEN} ${tag}` } });
  await ins("decisions", { user_id: u.id, thread_id: thread.id, choice: `Sent ${TOKEN}`, reason_user: `Asked twice ${TOKEN}` });
  await ins("suppressions", { user_id: u.id, suppression_hash: `seed-${tag}-${RUN}`, reason: "rejected" });
  const rpc = await c.rpc("consume_usage", { p_kind: "ask" });
  if (rpc.error) throw new Error(`consume_usage: ${rpc.error.message}`);
  return { source: source.id, extraction: extraction.id, thread: thread.id, item: item.id, path };
}

/** Every row of every table for a user, read with the service role. */
async function allRows(uid: string): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [t, col] of TABLES) {
    const { data, error } = await admin.from(t).select("*").eq(col, uid);
    if (error) throw new Error(`${t}: ${error.message}`);
    out[t] = data ?? [];
  }
  return out;
}

const tablesWithToken = (rows: Record<string, unknown[]>) => Object.entries(rows).filter(([, v]) => has(v)).map(([t]) => t);

describe.skipIf(!env)("real local Supabase: RLS, rate limit, deletion", () => {
  let A: User;
  let B: User;
  let gA: Graph;
  let gB: Graph;

  beforeAll(async () => {
    await assertReachable(env!);
    admin = createClient(env!.url, env!.service, opts);
    anon = createClient(env!.url, env!.anon, opts);
    A = await makeUser("a");
    B = await makeUser("b");
    gA = await seed(A, "a");
    gB = await seed(B, "b");
  }, 60_000);

  afterAll(async () => {
    // Deleting an auth user does not remove their storage objects on real Supabase (no owner FK), so
    // remove each test user's folder through the Storage API first.
    for (const id of created) {
      const { data } = await admin.storage.from("sources").list(id);
      if (data?.length) await admin.storage.from("sources").remove(data.map((o) => `${id}/${o.name}`));
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
  });

  it("sign-up trigger created profiles and user_settings for real auth users", async () => {
    const rows = await allRows(A.id);
    expect(rows.profiles).toHaveLength(1);
    expect(rows.user_settings).toHaveLength(1);
  });

  it.each(TABLES)("RLS %s: A reads only own rows, cannot update or delete B's", async (t, col) => {
    const own = await A.client.from(t).select("*");
    expect(own.error).toBeNull();
    expect((own.data ?? []).length).toBeGreaterThan(0);
    expect((own.data ?? []).every((r: Record<string, unknown>) => r[col] === A.id)).toBe(true);
    expect((await A.client.from(t).select("*").eq(col, B.id)).data).toEqual([]);

    const before = (await admin.from(t).select("*").eq(col, B.id)).data;
    const patch: Record<string, unknown> = t === "profiles" ? { display_name: "hijacked" } : t === "usage_counters" ? { asks: 0 } : { [col]: B.id };
    const upd = await A.client.from(t).update(patch).eq(col, B.id).select();
    expect(upd.data ?? []).toEqual([]);
    const del = await A.client.from(t).delete().eq(col, B.id).select();
    expect(del.data ?? []).toEqual([]);
    expect((await admin.from(t).select("*").eq(col, B.id)).data).toEqual(before);
  });

  it.each(TABLES)("anon reads nothing from %s", async (t) => {
    const r = await anon.from(t).select("*");
    expect(r.data ?? []).toEqual([]);
  });

  it("A cannot insert rows owned by B or linked to B's rows", async () => {
    const attempts = [
      A.client.from("threads").insert({ user_id: B.id, title: "x", kind: "commitment" }),
      A.client.from("thread_events").insert({ user_id: A.id, thread_id: gB.thread, actor: "user", type: "edited" }),
      A.client.from("evidence").insert({ user_id: A.id, thread_id: gB.thread, quote: "x", match_kind: "exact" }),
      A.client.from("decisions").insert({ user_id: A.id, thread_id: gB.thread, choice: "x" }),
      A.client.from("suppressions").insert({ user_id: B.id, suppression_hash: "x", reason: "rejected" }),
      A.client.from("usage_counters").insert({ user_id: A.id, day: "2030-01-01" }),
      A.client.from("profiles").insert({ id: randomUUID(), display_name: "x" }),
    ];
    for (const r of await Promise.all(attempts)) expect(r.error).not.toBeNull();
  });

  it("thread_events is append-only for the owner", async () => {
    const upd = await A.client.from("thread_events").update({ type: "rewritten" }).eq("user_id", A.id).select();
    expect(upd.data ?? []).toEqual([]);
    const del = await A.client.from("thread_events").delete().eq("user_id", A.id).select();
    expect(del.data ?? []).toEqual([]);
  });

  it("S4: threads cannot be updated directly; Done and Undo go through the definer functions, owner only", async () => {
    // No direct UPDATE, even of one's own thread (status changes need a thread_events row).
    const direct = await A.client.from("threads").update({ status: "resolved" }).eq("id", gA.thread).select();
    expect(direct.error?.code).toBe("42501");
    expect((await admin.from("threads").select("status").eq("id", gA.thread).single()).data).toEqual({ status: "open" });

    // B cannot Done A's thread.
    const now = new Date();
    const foreign = await B.client.rpc("thread_done", { p_thread_id: gA.thread, p_from_status: "open", p_now: now.toISOString() });
    expect(foreign.data).toEqual({ ok: false, error: "not_found" });
    // anon cannot call it at all.
    expect((await anon.rpc("thread_done", { p_thread_id: gA.thread, p_from_status: "open", p_now: now.toISOString() })).error).not.toBeNull();

    const done = await A.client.rpc("thread_done", { p_thread_id: gA.thread, p_from_status: "open", p_now: now.toISOString() });
    expect(done.data).toMatchObject({ ok: true, from_status: "open", to_status: "resolved" });
    expect((await B.client.rpc("thread_undo", { p_thread_id: gA.thread, p_event_id: done.data.event_id, p_now: now.toISOString() })).data).toEqual({ ok: false, error: "not_found" });
    const undo = await A.client.rpc("thread_undo", { p_thread_id: gA.thread, p_event_id: done.data.event_id, p_now: new Date(now.getTime() + 2000).toISOString() });
    expect(undo.data).toMatchObject({ ok: true, to_status: "open", undone_event_id: done.data.event_id });
    expect((await admin.from("threads").select("status, resolution").eq("id", gA.thread).single()).data).toEqual({ status: "open", resolution: null });
    const { data: ev } = await admin.from("thread_events").select("type").eq("thread_id", gA.thread).order("id");
    expect(ev!.map((e) => e.type)).toEqual(["created", "resolved", "undone"]);
  });

  it("profiles and user_settings cannot be deleted by the owner; invalid timezone is refused", async () => {
    expect((await A.client.from("profiles").delete().eq("id", A.id).select()).data ?? []).toEqual([]);
    expect((await A.client.from("user_settings").delete().eq("user_id", A.id).select()).data ?? []).toEqual([]);
    expect((await A.client.from("profiles").update({ timezone: "Mars/Olympus" }).eq("id", A.id)).error).not.toBeNull();
    expect((await A.client.from("profiles").update({ timezone: "America/New_York" }).eq("id", A.id).select()).data).toHaveLength(1);
  });

  it("storage: own folder only; anon has no access", async () => {
    expect((await A.client.storage.from("sources").download(gA.path)).error).toBeNull();
    expect((await A.client.storage.from("sources").download(gB.path)).error).not.toBeNull();
    expect((await A.client.storage.from("sources").upload(`${B.id}/evil.txt`, new Blob(["x"]))).error).not.toBeNull();
    expect((await A.client.storage.from("sources").upload(`evil.txt`, new Blob(["x"]))).error).not.toBeNull();
    await A.client.storage.from("sources").remove([gB.path]);
    expect((await B.client.storage.from("sources").download(gB.path)).error).toBeNull();
    expect((await anon.storage.from("sources").download(gA.path)).error).not.toBeNull();
    const list = await A.client.storage.from("sources").list(B.id);
    expect(list.data ?? []).toEqual([]);
  });

  it("consume_usage: 30 extractions then refused; direct writes and anon refused", async () => {
    const C = await makeUser("c");
    let ok = 0;
    for (let i = 0; i < 31; i++) {
      const r = await C.client.rpc("consume_usage", { p_kind: "extraction" });
      expect(r.error).toBeNull();
      if (r.data === true) ok++;
    }
    expect(ok).toBe(30);
    expect((await C.client.from("usage_counters").update({ extractions: 0 }).eq("user_id", C.id).select()).data ?? []).toEqual([]);
    expect((await C.client.from("usage_counters").delete().eq("user_id", C.id).select()).data ?? []).toEqual([]);
    expect((await C.client.rpc("consume_usage", { p_kind: "extraction" })).data).toBe(false);
    expect((await anon.rpc("consume_usage", { p_kind: "extraction" })).error).not.toBeNull();
    expect((await anon.rpc("forget_thread", { p_thread_id: gA.thread, p_delete_source: false })).error).not.toBeNull();
  }, 60_000);

  it("forget_thread refuses another user's thread", async () => {
    const r = await B.client.rpc("forget_thread", { p_thread_id: gA.thread, p_delete_source: true });
    expect(r.error).not.toBeNull();
    expect((await admin.from("threads").select("id").eq("id", gA.thread)).data).toHaveLength(1);
  });

  it("F13 delete source only: thread and its quote stay; proposal and source-only evidence go; file removable", async () => {
    const D = await makeUser("d");
    const g = await seed(D, "d");
    // pending proposal with evidence, and a source-only evidence row (seeded with the service role;
    // quotes must be in the source text, which every writer's quote trigger checks)
    const item2 = await admin
      .from("extraction_items")
      .insert({ user_id: D.id, extraction_id: g.extraction, payload: {}, confidence: 0.6, band: "medium", item_index: 1 })
      .select()
      .single();
    expect(item2.error).toBeNull();
    const e1 = await admin.from("evidence").insert({ user_id: D.id, source_id: g.source, extraction_item_id: item2.data!.id, quote: "Also the parrot memo", match_kind: "exact" });
    expect(e1.error).toBeNull();
    const e2 = await admin.from("evidence").insert({ user_id: D.id, source_id: g.source, quote: `the ${TOKEN} proposal d`, match_kind: "exact" });
    expect(e2.error).toBeNull();
    expect((await admin.from("evidence").select("id").eq("user_id", D.id)).data).toHaveLength(3);

    const del = await D.client.from("sources").delete().eq("id", g.source).select();
    expect(del.error).toBeNull();
    expect(del.data).toHaveLength(1);
    expect((await D.client.storage.from("sources").remove([g.path])).error).toBeNull();
    expect((await D.client.storage.from("sources").download(g.path)).error).not.toBeNull();

    const rows = await allRows(D.id);
    expect(rows.threads).toHaveLength(1);
    expect((rows.evidence as Array<{ quote: string; source_id: string | null }>).map((e) => [e.quote.startsWith("I'll send"), e.source_id])).toEqual([[true, null]]);
    expect(rows.extractions).toEqual([]);
    expect(rows.extraction_items).toEqual([]);
  });

  it("forget keeping the source: content only in sources.text_content; unrelated brief line kept", async () => {
    const E = await makeUser("e");
    const g = await seed(E, "e");
    const r = await E.client.rpc("forget_thread", { p_thread_id: g.thread, p_delete_source: false });
    expect(r.error).toBeNull();
    const rows = await allRows(E.id);
    expect(tablesWithToken(rows)).toEqual(["sources"]);
    const ex = rows.extractions![0] as { brief: { what_to_do: Array<{ text: string }> }; raw_output: { items: unknown[] } };
    expect(ex.brief.what_to_do.map((l) => l.text)).toEqual(["Read the parrot memo"]);
    expect(ex.raw_output.items).toEqual([null]);
    expect((await admin.from("suppressions").select("suppression_hash,reason").eq("user_id", E.id)).data).toContainEqual({
      suppression_hash: `hash-e-${RUN}`,
      reason: "forgotten",
    });
  });

  it("forget with 'also delete source': nothing left but hashes; storage path returned and removable", async () => {
    const F = await makeUser("f");
    const g = await seed(F, "f");
    const r = await F.client.rpc("forget_thread", { p_thread_id: g.thread, p_delete_source: true });
    expect(r.error).toBeNull();
    expect((r.data as { storage_path: string }).storage_path).toBe(g.path);
    expect((await F.client.storage.from("sources").remove([g.path])).error).toBeNull();
    const rows = await allRows(F.id);
    expect(tablesWithToken(rows)).toEqual([]);
    expect(rows.threads).toEqual([]);
    expect(rows.sources).toEqual([]);
  });

  it("account deletion (admin API) removes every row in all 11 tables", async () => {
    const G = await makeUser("g");
    const g = await seed(G, "g");
    // Storage objects must be removed first through the Storage API (a cascade cannot).
    expect((await admin.storage.from("sources").remove([g.path])).error).toBeNull();
    const del = await admin.auth.admin.deleteUser(G.id);
    expect(del.error).toBeNull();
    const rows = await allRows(G.id);
    for (const [t] of TABLES) expect(rows[t], t).toEqual([]);
  });

  it("account deletion while a storage object still exists: auth delete outcome is recorded", async () => {
    const H = await makeUser("h");
    const g = await seed(H, "h");
    const del = await admin.auth.admin.deleteUser(H.id);
    // Whatever the outcome, no table rows may survive a successful delete, and the object must be
    // removable afterwards by the service role.
    if (!del.error) {
      const rows = await allRows(H.id);
      for (const [t] of TABLES) expect(rows[t], t).toEqual([]);
    }
    expect((await admin.storage.from("sources").remove([g.path])).error).toBeNull();
  });

  /* ---- Pre-release hardening (lead-developer) ---- */

  it("deleteAccount(): removes every storage object (paginated, subfolder) and then all rows", async () => {
    const K = await makeUser("k");
    await seed(K, "k");
    for (const p of ["a.txt", "b.txt", "c.txt", "nested/d.txt", "nested/e.txt"]) {
      const up = await K.client.storage.from("sources").upload(`${K.id}/${p}`, new Blob([`x ${TOKEN}`], { type: "text/plain" }));
      expect(up.error).toBeNull();
    }
    const r = await deleteAccount(admin as unknown as AccountAdminClient, K.id, { pageSize: 2 });
    expect(r).toEqual({ ok: true, objectsRemoved: 6 });
    const rows = await allRows(K.id);
    for (const [t] of TABLES) expect(rows[t], t).toEqual([]);
    expect((await admin.storage.from("sources").list(K.id)).data ?? []).toEqual([]);
    expect((await admin.storage.from("sources").list(`${K.id}/nested`)).data ?? []).toEqual([]);
    expect((await admin.auth.admin.getUserById(K.id)).data.user).toBeNull();
  }, 60_000);

  it("deleteAccount(): a storage failure leaves the user and rows in place", async () => {
    const L = await makeUser("l");
    const g = await seed(L, "l");
    const broken = {
      storage: { from: () => ({ list: async () => ({ data: null, error: { message: "down" } }), remove: async () => ({ data: null, error: null }) }) },
      auth: admin.auth,
    } as unknown as AccountAdminClient;
    const r = await deleteAccount(broken, L.id);
    expect(r).toMatchObject({ ok: false, error: { code: "save_failed", retryable: true } });
    expect((await admin.auth.admin.getUserById(L.id)).data.user?.id).toBe(L.id);
    expect((await allRows(L.id)).threads).toHaveLength(1);
    expect((await admin.storage.from("sources").download(g.path)).error).toBeNull();
  });

  it.each([
    ["scrub_brief", { p_brief: {}, p_quotes: [] }],
    ["norm_quote", { t: "x" }],
    ["touch_updated_at", {}],
    ["handle_new_user", {}],
    ["profiles_check_timezone", {}],
    ["extraction_items_delete_evidence", {}],
    ["sources_delete_source_only_evidence", {}],
    ["thread_events_no_update", {}],
  ])("RPC %s is refused for anon and authenticated", async (fn, args) => {
    expect((await anon.rpc(fn, args)).error, `anon ${fn}`).not.toBeNull();
    expect((await A.client.rpc(fn, args)).error, `authenticated ${fn}`).not.toBeNull();
  });

  it("private helpers are not reachable through the API", async () => {
    const r = await A.client.schema("private").rpc("scrub_brief", { p_brief: {}, p_quotes: [] });
    expect(r.error).not.toBeNull();
  });

  it("forget_thread and consume_usage still work for authenticated after the grant changes", async () => {
    const M = await makeUser("m");
    const g = await seed(M, "m");
    expect((await M.client.rpc("consume_usage", { p_kind: "ask" })).error).toBeNull();
    const f = await M.client.rpc("forget_thread", { p_thread_id: g.thread, p_delete_source: false });
    expect(f.error).toBeNull();
    const ex = (await admin.from("extractions").select("brief").eq("id", g.extraction).single()).data as { brief: { what_to_do: Array<{ text: string }> } };
    expect(ex.brief.what_to_do.map((l) => l.text)).toEqual(["Read the parrot memo"]);
  });
});

describe.skipIf(!env)("real local Supabase: account deletion vs a still-valid session (pre-release review)", () => {
  // REGRESSION GUARD (medium-high, rule 8, fixed pre-release review): JWTs are stateless, and the storage insert policy only checks
  // auth.uid() against the folder name. After deleteAccount() removes the files and deletes the auth
  // user, the user's existing session (another tab, an in-flight upload) can still upload into the
  // folder. Table inserts fail on the profiles foreign key; storage has no such check, so the object is
  // orphaned. Suggested fix: the storage insert policy also requires
  // `exists (select 1 from public.profiles p where p.id = auth.uid())`, and deleteAccount() sweeps the
  // folder once more after deleteUser().
  beforeAll(async () => assertReachable(env!));

  it("a deleted user's session cannot upload to storage", async () => {
    const svc = createClient(env!.url, env!.service, opts);
    const email = `le-test-post-${randomUUID().slice(0, 6)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    const uid = data.user!.id;
    const user = createClient(env!.url, env!.anon, opts);
    await user.auth.signInWithPassword({ email, password });
    expect((await svc.auth.admin.deleteUser(uid)).error).toBeNull();
    const up = await user.storage.from("sources").upload(`${uid}/after-delete.txt`, new Blob(["after delete"]));
    // clean up whatever got through before asserting
    const left = (await svc.storage.from("sources").list(uid)).data ?? [];
    if (left.length) await svc.storage.from("sources").remove(left.map((o) => `${uid}/${o.name}`));
    expect(up.error).not.toBeNull();
  });
});

describe.skipIf(!env)("real local Supabase: user_settings.analytics_enabled (S1, D40)", () => {
  // Lead-tester. Through real PostgREST + RLS with real auth sessions. Read-only against other
  // accounts in the shared local stack: it only counts null values, never reads or changes them.
  let svc: SupabaseClient;
  let A: User;
  let B: User;
  const mine: string[] = [];

  async function liveUser(tag: string): Promise<User> {
    const email = `le-test-analytics-${tag}-${randomUUID().slice(0, 6)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    mine.push(data.user.id);
    const client = createClient(env!.url, env!.anon, opts);
    const s = await client.auth.signInWithPassword({ email, password });
    if (s.error) throw s.error;
    return { id: data.user.id, email, client };
  }
  const valueOf = async (uid: string) =>
    (await svc.from("user_settings").select("analytics_enabled").eq("user_id", uid).single()).data?.analytics_enabled;

  beforeAll(async () => {
    await assertReachable(env!);
    svc = createClient(env!.url, env!.service, opts);
    A = await liveUser("a");
    B = await liveUser("b");
  }, 60_000);
  afterAll(async () => {
    for (const id of mine) await svc.auth.admin.deleteUser(id).catch(() => {});
  });

  it("the column exists on every row and no row is null (migration applied; not null default true)", async () => {
    const all = await svc.from("user_settings").select("user_id", { count: "exact", head: true });
    expect(all.error).toBeNull();
    expect(all.count).toBeGreaterThan(0);
    const nulls = await svc.from("user_settings").select("user_id", { count: "exact", head: true }).is("analytics_enabled", null);
    expect(nulls.error).toBeNull();
    expect(nulls.count).toBe(0);
  });

  it("a new sign-up gets analytics_enabled = true from the default", async () => {
    expect(await valueOf(A.id)).toBe(true);
    expect(await valueOf(B.id)).toBe(true);
    const own = await A.client.from("user_settings").select("user_id, analytics_enabled");
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ user_id: A.id, analytics_enabled: true }]);
  });

  it("A cannot read B's row, by filter or unfiltered", async () => {
    const byId = await A.client.from("user_settings").select("analytics_enabled").eq("user_id", B.id);
    expect(byId.error).toBeNull();
    expect(byId.data).toEqual([]);
    const all = await A.client.from("user_settings").select("user_id");
    expect(all.data?.map((r) => r.user_id)).toEqual([A.id]);
  });

  it("A cannot update B's analytics_enabled, or move their own row onto B, or insert/upsert B's row", async () => {
    const upd = await A.client.from("user_settings").update({ analytics_enabled: false }).eq("user_id", B.id).select();
    expect(upd.data ?? []).toEqual([]);
    expect(await valueOf(B.id)).toBe(true);

    const unfiltered = await A.client.from("user_settings").update({ analytics_enabled: false }).neq("user_id", A.id).select();
    expect(unfiltered.data ?? []).toEqual([]);
    expect(await valueOf(B.id)).toBe(true);

    const move = await A.client.from("user_settings").update({ user_id: B.id }).eq("user_id", A.id).select();
    expect(move.error).not.toBeNull();

    const ups = await A.client.from("user_settings").upsert({ user_id: B.id, analytics_enabled: false }).select();
    expect(ups.error).not.toBeNull();
    expect(await valueOf(B.id)).toBe(true);
  });

  it("anon can neither read nor update any analytics_enabled", async () => {
    const a = createClient(env!.url, env!.anon, opts);
    expect((await a.from("user_settings").select("user_id")).data ?? []).toEqual([]);
    const upd = await a.from("user_settings").update({ analytics_enabled: false }).eq("user_id", B.id).select();
    expect(upd.data ?? []).toEqual([]);
    expect(await valueOf(B.id)).toBe(true);
  });

  it("A can turn their own analytics off and on, and the update returns exactly one row (what the server action relies on)", async () => {
    const off = await A.client.from("user_settings").update({ analytics_enabled: false }).eq("user_id", A.id).select("analytics_enabled");
    expect(off.error).toBeNull();
    expect(off.data).toEqual([{ analytics_enabled: false }]);
    expect(await valueOf(A.id)).toBe(false);
    expect(await valueOf(B.id)).toBe(true);
    const on = await A.client.from("user_settings").update({ analytics_enabled: true }).eq("user_id", A.id).select("analytics_enabled");
    expect(on.data).toEqual([{ analytics_enabled: true }]);
  });

  it("null is refused", async () => {
    const r = await A.client.from("user_settings").update({ analytics_enabled: null }).eq("user_id", A.id).select();
    expect(r.error?.code).toBe("23502");
  });
});
