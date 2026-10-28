/**
 * S11 (F13, F9 Forget, D14; rule 8) against REAL local Supabase: PostgREST, Auth, RLS and the Storage
 * API with real files. Server actions run with their user-scoped client replaced by a signed-in
 * supabase-js client. Proves: deleting a source removes its rows AND its stored file; Forget with
 * "Also delete source" removes the file; another user can delete nothing; the export holds every
 * table's rows for the user and no one else's; account deletion leaves no rows and no files.
 * Skipped unless LE_SUPABASE_LIVE=1 (`pnpm test:supabase`). Throwaway users, synthetic text only,
 * no model. Never resets the database.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
const tracked = vi.hoisted(() => ({ events: [] as Array<{ name: string; props: unknown }> }));
const jar = vi.hoisted(() => ({ set: [] as Array<{ name: string; value: string }> }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: (name: string, value: string) => void jar.set.push({ name, value }), get: () => undefined }),
}));
vi.mock("@/lib/analytics/track", () => ({
  track: (_u: string, name: string, props: unknown) => void tracked.events.push({ name, props }),
  createTracker: () => ({ track: (_u: string, name: string, props: unknown) => void tracked.events.push({ name, props }) }),
}));

import { GET as exportRoute } from "@/app/api/export/route";
import { deleteAccountAction, deleteSourceAction } from "@/app/settings/data-actions";
import { forgetAction } from "@/app/threads/[id]/actions";
import { EXPORT_TABLES } from "@/lib/account/export";

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

type User = { id: string; client: SupabaseClient };
const SECRET = "Quillon zebrafish";

describe.skipIf(!live)("S11 deletion and export on real local Supabase", () => {
  let e: ReturnType<typeof env>;
  let admin: SupabaseClient;
  const users: User[] = [];

  async function makeUser(tag: string): Promise<User> {
    const email = `le-test-${tag}-${randomUUID().slice(0, 6)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    const client = createClient(e.url, e.anon, opts);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
    const u = { id: data.user.id, client };
    users.push(u);
    return u;
  }

  /** An uploaded source with its file, an extraction, an accepted proposal, a thread with evidence, history and a decision. */
  async function seed(u: User) {
    const path = `${u.id}/${randomUUID()}`;
    const up = await u.client.storage.from("sources").upload(path, new Blob([`Notes: ${SECRET} proposal Friday.`]), { contentType: "text/plain" });
    if (up.error) throw up.error;
    const text = `I'll send ${SECRET} proposal Friday.`;
    const quote = `send ${SECRET} proposal Friday`;
    const src = await admin
      .from("sources")
      .insert({ user_id: u.id, kind: "upload", title: `${SECRET} notes`, text_content: text, storage_path: path, reference_date: "2026-10-20", reference_date_source: "user" })
      .select("id")
      .single();
    if (src.error) throw src.error;
    const ex = await admin
      .from("extractions")
      .insert({ user_id: u.id, source_id: src.data.id, status: "succeeded", model: "fake:recorded", prompt_version: "extract.v1", schema_version: "extraction.v1" })
      .select("id")
      .single();
    if (ex.error) throw ex.error;
    const thr = await admin
      .from("threads")
      .insert({ user_id: u.id, title: `Send ${SECRET} proposal`, kind: "commitment", status: "open", primary_source_id: src.data.id })
      .select("id")
      .single();
    if (thr.error) throw thr.error;
    const item = await admin
      .from("extraction_items")
      .insert({
        user_id: u.id,
        extraction_id: ex.data.id,
        item_index: 0,
        band: "high",
        confidence: 0.9,
        review_status: "accepted",
        thread_id: thr.data.id,
        suppression_hash: "d".repeat(64),
        payload: { item: { type: "commitment", title: `Send ${SECRET} proposal` }, label: { word: "Likely", reason: "synthetic" } },
      })
      .select("id")
      .single();
    if (item.error) throw item.error;
    const ev = await admin.from("evidence").insert({
      user_id: u.id,
      source_id: src.data.id,
      thread_id: thr.data.id,
      extraction_item_id: item.data.id,
      quote,
      start_offset: text.indexOf(quote),
      end_offset: text.indexOf(quote) + quote.length,
      match_kind: "exact",
    });
    if (ev.error) throw ev.error;
    await admin.from("thread_events").insert({ user_id: u.id, thread_id: thr.data.id, actor: "user", type: "created", after: { title: `Send ${SECRET} proposal` } });
    return { sourceId: src.data.id as string, threadId: thr.data.id as string, path };
  }

  const fileExists = async (path: string) => {
    const slash = path.lastIndexOf("/");
    const { data, error } = await admin.storage.from("sources").list(path.slice(0, slash), { search: path.slice(slash + 1) });
    if (error) throw error;
    return (data ?? []).some((o) => o.name === path.slice(slash + 1));
  };
  const count = async (table: string, column: string, value: string) => (await admin.from(table).select("*", { count: "exact", head: true }).eq(column, value)).count ?? 0;

  beforeAll(async () => {
    e = env();
    process.env.NEXT_PUBLIC_SUPABASE_URL = e.url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = e.anon;
    process.env.SUPABASE_SERVICE_ROLE_KEY = e.service;
    admin = createClient(e.url, e.service, opts);
  }, 60_000);

  afterAll(async () => {
    for (const u of users) await admin.auth.admin.deleteUser(u.id).catch(() => undefined);
  });

  it("Delete source only: rows and the stored file are gone; the thread keeps its quote with no source", async () => {
    const A = await makeUser("s11a");
    const s = await seed(A);
    expect(await fileExists(s.path)).toBe(true);
    current.client = A.client;
    tracked.events.length = 0;
    expect(await deleteSourceAction(s.sourceId, false)).toEqual({ ok: true, threadsForgotten: 0 });
    expect(await count("sources", "id", s.sourceId)).toBe(0);
    expect(await count("extractions", "source_id", s.sourceId)).toBe(0);
    expect(await fileExists(s.path)).toBe(false);
    expect(await count("threads", "id", s.threadId)).toBe(1);
    const ev = await admin.from("evidence").select("source_id, quote").eq("thread_id", s.threadId);
    expect(ev.data).toEqual([{ source_id: null, quote: `send ${SECRET} proposal Friday` }]);
    expect(await A.client.rpc("storage_deletions_settle")).toMatchObject({ data: [], error: null });
    expect(tracked.events).toEqual([{ name: "source_deleted", props: { cascade: false } }]);
  });

  it("Delete source and everything from it: the thread is forgotten too, and the file is gone", async () => {
    const A = await makeUser("s11b");
    const s = await seed(A);
    current.client = A.client;
    expect(await deleteSourceAction(s.sourceId, true)).toEqual({ ok: true, threadsForgotten: 1 });
    expect(await count("threads", "id", s.threadId)).toBe(0);
    expect(await fileExists(s.path)).toBe(false);
    for (const { table } of EXPORT_TABLES) {
      const owner = table === "profiles" ? "id" : "user_id";
      const rows = (await admin.from(table).select("*").eq(owner, A.id)).data ?? [];
      expect(JSON.stringify(rows), table).not.toContain("zebrafish");
    }
  });

  it("Forget permanently with Also delete source removes the thread, the source and its file", async () => {
    const A = await makeUser("s11c");
    const s = await seed(A);
    current.client = A.client;
    tracked.events.length = 0;
    expect(await forgetAction(s.threadId, true)).toEqual({ ok: true });
    expect(await count("threads", "id", s.threadId)).toBe(0);
    expect(await count("sources", "id", s.sourceId)).toBe(0);
    expect(await fileExists(s.path)).toBe(false);
    expect(tracked.events.map((t) => t.name)).toEqual(["thread_action", "source_deleted"]);
    expect(JSON.stringify(tracked.events)).not.toMatch(/zebrafish|quillon/i);
  });

  it("Forget keeping the source leaves the source and its file", async () => {
    const A = await makeUser("s11d");
    const s = await seed(A);
    current.client = A.client;
    expect(await forgetAction(s.threadId, false)).toEqual({ ok: true });
    expect(await count("sources", "id", s.sourceId)).toBe(1);
    expect(await fileExists(s.path)).toBe(true);
  });

  it("another user can delete nothing: not found, and the owner's rows and file stay", async () => {
    const A = await makeUser("s11e");
    const B = await makeUser("s11f");
    const s = await seed(A);
    current.client = B.client;
    expect(await deleteSourceAction(s.sourceId, true)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await forgetAction(s.threadId, true)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await count("sources", "id", s.sourceId)).toBe(1);
    expect(await count("threads", "id", s.threadId)).toBe(1);
    expect(await fileExists(s.path)).toBe(true);
    // B cannot remove A's file through Storage either.
    await B.client.storage.from("sources").remove([s.path]);
    expect(await fileExists(s.path)).toBe(true);
  });

  it("export: every table's rows for the user and no one else's; 401 when signed out", async () => {
    const A = await makeUser("s11g");
    const B = await makeUser("s11h");
    await seed(A);
    await seed(B);
    current.client = A.client;
    tracked.events.length = 0;
    const res = await exportRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="loose-ends-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const body = (await res.json()) as { user_id: string; tables: Record<string, Array<Record<string, unknown>>> };
    expect(body.user_id).toBe(A.id);
    expect(Object.keys(body.tables).sort()).toEqual(EXPORT_TABLES.map((t) => t.table).sort());
    for (const { table, owner } of EXPORT_TABLES) {
      const all = (await admin.from(table).select("*").eq(owner, A.id)).data ?? [];
      expect(body.tables[table]!.length, table).toBe(all.length);
      for (const row of body.tables[table]!) expect(row[owner], table).toBe(A.id);
    }
    for (const t of ["sources", "threads", "evidence", "thread_events", "extraction_items", "extractions", "profiles", "user_settings"]) {
      expect(body.tables[t]!.length, t).toBeGreaterThan(0);
    }
    expect(JSON.stringify(body)).not.toContain(B.id);
    expect(tracked.events).toEqual([{ name: "data_exported", props: {} }]);

    current.client = createClient(e.url, e.anon, opts);
    expect((await exportRoute()).status).toBe(401);
  });

  it("account deletion needs the typed word, then leaves no rows and no files for the user", async () => {
    const A = await makeUser("s11i");
    const s = await seed(A);
    const extra = `${A.id}/${randomUUID()}`;
    await A.client.storage.from("sources").upload(extra, new Blob(["orphan"]), { contentType: "text/plain" });
    current.client = A.client;
    expect(await deleteAccountAction("delet")).toMatchObject({ ok: false, field: "confirm", error: { code: "invalid_input" } });
    expect(await count("profiles", "id", A.id)).toBe(1);

    tracked.events.length = 0;
    jar.set.length = 0;
    expect(await deleteAccountAction(" Delete ")).toEqual({ ok: true });
    for (const { table, owner } of EXPORT_TABLES) expect(await count(table, owner, A.id), table).toBe(0);
    expect(await fileExists(s.path)).toBe(false);
    expect(await fileExists(extra)).toBe(false);
    expect((await admin.storage.from("sources").list(A.id)).data ?? []).toEqual([]);
    expect((await admin.auth.admin.getUserById(A.id)).data.user).toBeNull();
    expect(tracked.events).toEqual([{ name: "account_deleted", props: {} }]);
    expect(jar.set).toEqual([{ name: "le_account_deleted", value: "1" }]);
  });
});
