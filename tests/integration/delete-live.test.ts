/**
 * S11 (F13, F9 Forget, D14; rule 8) against REAL local Supabase: PostgREST, Auth, RLS and the Storage
 * API with real files. Server actions run with their user-scoped client replaced by a signed-in
 * supabase-js client. Proves: deleting a source removes its rows AND its stored file; Forget with
 * "Also delete source" removes the file; another user can delete nothing; the export holds every
 * table's rows for the user and no one else's; account deletion leaves no rows and no files.
 * Skipped unless LE_SUPABASE_LIVE=1 (`pnpm test:supabase`). Throwaway users, synthetic text only,
 * no model. Never resets the database.
 */
import { execFileSync, execSync } from "node:child_process";
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
// Lets a test act just after the real auth user delete: a race upload, or Storage going down.
const adminHook = vi.hoisted(() => ({ afterDeleteUser: null as null | (() => Promise<void>) }));
vi.mock("@/lib/supabase/admin", async (original) => {
  const actual = await original<typeof import("@/lib/supabase/admin")>();
  return {
    ...actual,
    createAdminClient: () => {
      const c = actual.createAdminClient();
      const del = c.auth.admin.deleteUser.bind(c.auth.admin);
      c.auth.admin.deleteUser = async (...args: Parameters<typeof del>) => {
        const res = await del(...args);
        await adminHook.afterDeleteUser?.();
        return res;
      };
      return c;
    },
  };
});
vi.mock("@/lib/analytics/track", () => ({
  track: (_u: string, name: string, props: unknown) => void tracked.events.push({ name, props }),
  createTracker: () => ({ track: (_u: string, name: string, props: unknown) => void tracked.events.push({ name, props }) }),
}));

import { GET as cronRoute } from "@/app/api/cron/daily/route";
import { deleteSource, type DataClient } from "@/lib/account/data";
import { sweepStorageDeletions, type SweepClient } from "@/lib/account/sweep";
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

type User = { id: string; email: string; client: SupabaseClient };
const DB = process.env.LE_S11_DB_CONTAINER;
/** Set on an isolated stack only, with one worker: its test stops this container. */
const STORAGE = process.env.LE_S11_STORAGE_CONTAINER;
const psql = (sql: string) => execFileSync("docker", ["exec", DB!, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql], { encoding: "utf8" }).trim();
/** Every audit log entry that mentions this text anywhere: wider than the purge's own match, on purpose. */
const auditMentions = (text: string) => Number(psql(`select count(*) from auth.audit_log_entries where payload::text ilike '%${text}%'`));
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
    const u = { id: data.user.id, email, client };
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

  describe("cron/daily sweep (S11-D3)", () => {
    /** A user client whose Storage always fails: leaves a source's file stranded in the queue. */
    const brokenStorage = (client: SupabaseClient): DataClient => ({
      rpc: (fn, args) => client.rpc(fn, args) as unknown as PromiseLike<{ data: unknown; error: unknown }>,
      storage: { from: () => ({ remove: async () => ({ data: null, error: { code: "storage_down" } }) }) },
    });
    const strand = async (tag: string) => {
      const A = await makeUser(tag);
      const s = await seed(A);
      expect((await deleteSource(brokenStorage(A.client), s.sourceId, false, () => undefined)).ok).toBe(false);
      expect(await fileExists(s.path)).toBe(true);
      return { A, s };
    };
    const adminSweep = () => admin as unknown as SweepClient;

    it("with Storage failing, the file's entry stays queued", async () => {
      const { A, s } = await strand("s11s");
      const failing: SweepClient = {
        rpc: (fn, args) => admin.rpc(fn, args) as unknown as PromiseLike<{ data: unknown; error: unknown }>,
        storage: { from: () => ({ remove: async () => ({ data: null, error: { code: "storage_down" } }) }) },
      };
      const res = await sweepStorageDeletions(failing, () => undefined);
      expect(res.ok).toBe(false);
      expect(await fileExists(s.path)).toBe(true);
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([s.path]);
      // Tidy: the next test expects to drain what it stranded.
      expect((await sweepStorageDeletions(adminSweep(), () => undefined)).ok).toBe(true);
    });

    it("the route, with the secret, drains a stranded entry with no action from the user", async () => {
      const { A, s } = await strand("s11r");
      vi.stubEnv("CRON_SECRET", "live-test-secret");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", e.url);
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", e.service);
      try {
        expect((await cronRoute(new Request("http://x/api/cron/daily"))).status).toBe(401);
        expect(await fileExists(s.path)).toBe(true);
        const res = await cronRoute(new Request("http://x/api/cron/daily", { headers: { authorization: "Bearer live-test-secret" } }));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, files_remaining: 0 });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(await fileExists(s.path)).toBe(false);
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([]);
    });

    it("the service role can run the sweep; a signed-in user and the anon key cannot", async () => {
      const A = await makeUser("s11p");
      expect((await admin.rpc("storage_deletions_sweep")).error).toBeNull();
      expect((await A.client.rpc("storage_deletions_sweep")).error).not.toBeNull();
      expect((await createClient(e.url, e.anon, opts).rpc("storage_deletions_sweep")).error).not.toBeNull();
    });
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

  describe("auth audit log", () => {
    it("only the service role can run the purge, and it refuses what would match other users", async () => {
      const A = await makeUser("s11q");
      const anon = createClient(e.url, e.anon, opts);
      const args = { p_user_id: A.id, p_email: A.email };
      for (const c of [A.client, anon]) {
        expect((await c.rpc("auth_audit_purge_prepare", args)).error).not.toBeNull();
        expect((await c.rpc("auth_audit_purge", args)).error).not.toBeNull();
        expect((await c.rpc("auth_audit_purge_pending")).error).not.toBeNull();
      }
      expect((await admin.rpc("auth_audit_purge", args)).error?.message).toBe("user still exists");
      expect((await admin.rpc("auth_audit_purge", { p_user_id: "00000000-0000-0000-0000-000000000000", p_email: null })).error).not.toBeNull();
      expect((await admin.rpc("auth_audit_purge", { p_user_id: randomUUID(), p_email: "service_role" })).error).not.toBeNull();
      expect((await admin.rpc("auth_audit_purge", { p_user_id: randomUUID(), p_email: "" })).error).not.toBeNull();
    });

    it.skipIf(!DB)("account deletion leaves no entry with the user's id or email, including user_deleted; another user's stay", async () => {
      const A = await makeUser("s11r");
      const B = await makeUser("s11s");
      expect(auditMentions(A.id)).toBeGreaterThan(0);
      expect(auditMentions(A.email)).toBeGreaterThan(0);
      const others = { id: auditMentions(B.id), email: auditMentions(B.email) };
      expect(others.id).toBeGreaterThan(0);
      const token = (await A.client.auth.getSession()).data.session!.access_token;

      current.client = A.client;
      jar.set.length = 0;
      expect(await deleteAccountAction("delete")).toEqual({ ok: true });

      expect(auditMentions(A.id)).toBe(0);
      expect(auditMentions(A.email)).toBe(0);
      // Another device's old token, used afterwards, writes nothing back about the user.
      const auth = { apikey: e.anon, authorization: `Bearer ${token}` };
      await fetch(`${e.url}/auth/v1/user`, { headers: auth });
      await fetch(`${e.url}/auth/v1/logout`, { method: "POST", headers: auth });
      expect(auditMentions(A.id)).toBe(0);
      expect(auditMentions(A.email)).toBe(0);
      expect(jar.set).toEqual([{ name: "le_account_deleted", value: "1" }]);
      expect(psql(`select count(*) from private.auth_audit_purges where user_id='${A.id}'`)).toBe("0");
      expect(auditMentions(B.id)).toBe(others.id);
      expect(auditMentions(B.email)).toBe(others.email);
    });

    it.skipIf(!DB || !STORAGE)(
      "Storage down during the final sweep: the user is told the truth, cron keeps the row while it's down, then drains it, a race upload too",
      async () => {
        const A = await makeUser("s11v");
        const B = await makeUser("s11w");
        const s = await seed(A);
        const bFile = (await seed(B)).path;
        const objects = () => psql(`select count(*) from storage.objects where bucket_id='sources' and name like '${A.id}/%'`);
        const row = () => psql(`select count(*) from private.account_file_purges where user_id='${A.id}'`);
        const race = `${A.id}/${randomUUID()}`;
        const cron = async () => {
          vi.stubEnv("CRON_SECRET", "live-secret");
          vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", e.url);
          vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", e.service);
          try {
            return await cronRoute(new Request("http://x/api/cron/daily", { headers: { authorization: "Bearer live-secret" } }));
          } finally {
            vi.unstubAllEnvs();
          }
        };
        adminHook.afterDeleteUser = async () => {
          adminHook.afterDeleteUser = null;
          const up = await admin.storage.from("sources").upload(race, new Blob(["race"]), { contentType: "text/plain" });
          if (up.error) throw up.error;
          execFileSync("docker", ["stop", "-t", "1", STORAGE!], { encoding: "utf8" });
        };
        current.client = A.client;
        jar.set.length = 0;
        try {
          expect(await deleteAccountAction("delete")).toEqual({ ok: true });
          // The account is gone, and the notice says files remain instead of asking for a retry.
          expect((await admin.auth.admin.getUserById(A.id)).data.user).toBeNull();
          expect(jar.set).toEqual([{ name: "le_account_deleted", value: "3" }]);
          expect(objects()).toBe("1");
          expect(row()).toBe("1");
          expect(auditMentions(A.id)).toBe(0);

          const down = await cron();
          expect(down.status).toBe(500);
          expect(await down.json()).toMatchObject({ accounts_cleared: 0, accounts_pending: 1 });
          expect(row()).toBe("1");
          expect(objects()).toBe("1");
        } finally {
          adminHook.afterDeleteUser = null;
          execFileSync("docker", ["start", STORAGE!], { encoding: "utf8" });
          await vi.waitFor(async () => expect((await admin.storage.from("sources").list("x")).error).toBeNull(), { timeout: 60_000, interval: 1_000 });
        }

        const up = await cron();
        expect(await up.json()).toMatchObject({ accounts_pending: 0 });
        expect(up.status).toBe(200);
        expect(objects()).toBe("0");
        expect(row()).toBe("0");
        expect(await fileExists(race)).toBe(false);
        expect(await fileExists(s.path)).toBe(false);
        expect(await fileExists(bFile)).toBe(true);
      },
      180_000,
    );

    it("only the service role can read or clear the pending accounts", async () => {
      const A = await makeUser("s11x");
      const anon = createClient(e.url, e.anon, opts);
      for (const c of [A.client, anon]) {
        expect((await c.rpc("account_file_purges_pending")).error).not.toBeNull();
        expect((await c.rpc("account_file_purge_clear", { p_user_id: randomUUID() })).error).not.toBeNull();
      }
      expect((await admin.rpc("account_file_purges_pending")).error).toBeNull();
    });

    it.skipIf(!DB)("a purge that failed at deletion is finished by cron/daily, which then holds nothing about the user", async () => {
      const A = await makeUser("s11t");
      const B = await makeUser("s11u");
      const bBefore = auditMentions(B.id);
      expect((await admin.rpc("auth_audit_purge_prepare", { p_user_id: A.id, p_email: A.email })).error).toBeNull();
      expect((await admin.auth.admin.deleteUser(A.id)).error).toBeNull();
      // As if the purge had failed straight after the delete: the entries and the pending row are there.
      expect(auditMentions(A.id)).toBeGreaterThan(0);
      expect(psql(`select email from private.auth_audit_purges where user_id='${A.id}'`)).toBe(A.email);

      vi.stubEnv("CRON_SECRET", "live-secret");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", e.url);
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", e.service);
      const res = await cronRoute(new Request("http://x/api/cron/daily", { headers: { authorization: "Bearer live-secret" } }));
      vi.unstubAllEnvs();
      expect(await res.json()).toMatchObject({ audit_pending: 0 });

      expect(auditMentions(A.id)).toBe(0);
      expect(auditMentions(A.email)).toBe(0);
      expect(psql(`select count(*) from private.auth_audit_purges where user_id='${A.id}'`)).toBe("0");
      expect(auditMentions(B.id)).toBe(bBefore);
    });
  });
});
