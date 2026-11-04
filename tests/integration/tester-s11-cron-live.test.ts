/**
 * Lead-tester, S11 re-verification against REAL local Supabase: /api/cron/daily, account deletion
 * failing at every step, the audit log purge, pending rows on accounts that survive, and the private
 * hash table (rules 8, 9, 10). Failures are injected around the real service-role client.
 *
 * Skipped unless LE_SUPABASE_LIVE=1 AND LE_S11_DB_CONTAINER names the stack's db container, because
 * it reads private tables with psql. LE_S11_STORAGE_CONTAINER adds a real Storage outage: that stops
 * the container, so set it only on an isolated stack and run with --maxWorkers=1.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown, admin: null as unknown }));
const jar = vi.hoisted(() => ({ set: [] as Array<{ name: string; value: string; options: unknown }> }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("@/lib/supabase/admin", async (original) => {
  const real = await original<typeof import("@/lib/supabase/admin")>();
  return { ...real, createAdminClient: () => current.admin ?? real.createAdminClient() };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: (name: string, value: string, options: unknown) => void jar.set.push({ name, value, options }), get: () => undefined }),
}));
vi.mock("@/lib/analytics/track", () => ({ track: () => undefined, createTracker: () => ({ track: () => undefined }) }));

import { GET, POST } from "@/app/api/cron/daily/route";
import { deleteAccountAction } from "@/app/settings/data-actions";
import { deleteSource, type DataClient } from "@/lib/account/data";
import { deleteAccount, type AccountAdminClient } from "@/lib/account/deleteAccount";
import { EXPORT_TABLES } from "@/lib/account/export";
import { suppressionHash } from "@/lib/pipeline/verifyQuotes";

const DB = process.env.LE_S11_DB_CONTAINER;
const STORAGE = process.env.LE_S11_STORAGE_CONTAINER;
/** Stops or pauses the stack's Auth container: set only on an isolated stack. */
const AUTH = process.env.LE_S11_AUTH_CONTAINER;
const live = process.env.LE_SUPABASE_LIVE === "1" && Boolean(DB);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const SECRET = "s11-unit-cron-secret";

type User = { id: string; email: string; client: SupabaseClient };

const psql = (sql: string, user = "postgres") => execFileSync("docker", ["exec", DB!, "psql", "-U", user, "-d", "postgres", "-tAc", sql], { encoding: "utf8" }).trim();
const dump = (schemas: string[]) =>
  execFileSync("docker", ["exec", DB!, "pg_dump", "-U", "postgres", "-d", "postgres", "--data-only", "--inserts", ...schemas.flatMap((s) => ["-n", s])], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

const auditCount = (u: { id: string; email: string }) =>
  Number(psql(`select count(*) from auth.audit_log_entries where payload::text ilike '%${u.id}%' or payload::text ilike '%${u.email}%'`));
const pendingAudit = (id: string) => Number(psql(`select count(*) from private.auth_audit_purges where user_id='${id}'`));
const pendingFiles = (id: string) => Number(psql(`select count(*) from private.account_file_purges where user_id='${id}'`));

const cron = (method: "GET" | "POST" = "GET", auth: string | null = `Bearer ${SECRET}`) => {
  const req = new Request("http://127.0.0.1/api/cron/daily", { method, headers: auth === null ? {} : { authorization: auth } });
  return method === "GET" ? GET(req) : POST(req);
};

interface Faults {
  prepare?: boolean;
  firstList?: boolean;
  /** "refused": the user stays. "after": the user is deleted, then an error is reported. */
  deleteUser?: "refused" | "after";
  finalSweep?: boolean;
  purge?: boolean;
}

/** The real service-role client with the named steps failing. */
function faulty(admin: SupabaseClient, f: Faults): AccountAdminClient {
  let deleted = false;
  return {
    storage: {
      from: (bucket) => ({
        list: (prefix, o) => {
          if ((f.firstList && !deleted) || (f.finalSweep && deleted)) return Promise.resolve({ data: null, error: { code: "injected" } });
          return admin.storage.from(bucket).list(prefix, o) as never;
        },
        remove: (paths) => admin.storage.from(bucket).remove(paths) as never,
      }),
    },
    auth: {
      admin: {
        getUserById: (id) => admin.auth.admin.getUserById(id) as never,
        deleteUser: async (id) => {
          if (f.deleteUser === "refused") return { data: null, error: { status: 500, code: "injected" } };
          const res = await admin.auth.admin.deleteUser(id);
          deleted = true;
          if (f.deleteUser === "after") return { data: null, error: { status: 504, code: "injected" } };
          return res;
        },
      },
    },
    rpc: (fn, args) => {
      if (f.prepare && fn === "auth_audit_purge_prepare") return Promise.resolve({ data: null, error: { code: "42501" } });
      if (f.purge && fn === "auth_audit_purge") return Promise.resolve({ data: null, error: { code: "XX000" } });
      return admin.rpc(fn, args) as never;
    },
  };
}

/** Whether the object's bytes are still on the storage container's disk. */
const onDisk = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return Number(execFileSync("docker", ["exec", STORAGE!, "sh", "-c", `find /mnt -path '*${name}*' -type f | wc -l`], { encoding: "utf8" }).trim()) > 0;
};

function failingRemove(client: SupabaseClient): DataClient {
  return {
    rpc: (fn, args) => client.rpc(fn, args) as never,
    storage: { from: () => ({ remove: async () => ({ data: null, error: { code: "storage_down" } }) }) },
  };
}

describe.skipIf(!live)("lead-tester S11 cron, account deletion failures, purge", () => {
  let url = "";
  let anon = "";
  let service = "";
  let admin: SupabaseClient;
  const users: User[] = [];

  async function makeUser(tag: string, email = `le-test-u11${tag}-${randomUUID().slice(0, 6)}@example.com`): Promise<User> {
    const password = `pw-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    const client = createClient(url, anon, opts);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
    const u = { id: data.user.id, email, client };
    users.push(u);
    return u;
  }

  async function upload(u: User, body = "Synthetic file."): Promise<string> {
    const path = `${u.id}/${randomUUID()}`;
    const up = await u.client.storage.from("sources").upload(path, new Blob([body]), { contentType: "text/plain" });
    if (up.error) throw up.error;
    return path;
  }

  async function source(u: User) {
    const path = await upload(u);
    const src = await admin
      .from("sources")
      .insert({ user_id: u.id, kind: "upload", title: "Synthetic", text_content: "Order cedar posts Monday.", storage_path: path, reference_date: "2026-10-20", reference_date_source: "user" })
      .select("id")
      .single();
    if (src.error) throw src.error;
    return { sourceId: src.data.id as string, path };
  }

  const fileExists = async (path: string) => {
    const slash = path.lastIndexOf("/");
    const { data, error } = await admin.storage.from("sources").list(path.slice(0, slash), { search: path.slice(slash + 1) });
    if (error) throw error;
    return (data ?? []).some((o) => o.name === path.slice(slash + 1));
  };
  const userExists = async (id: string) => (await admin.auth.admin.getUserById(id)).data.user !== null;
  const rowsLeft = async (id: string) => {
    let n = 0;
    for (const { table, owner } of EXPORT_TABLES) n += (await admin.from(table).select("*", { count: "exact", head: true }).eq(owner, id)).count ?? 0;
    return n;
  };

  beforeAll(() => {
    url = process.env.LE_SUPABASE_URL!;
    anon = process.env.LE_SUPABASE_ANON_KEY!;
    service = process.env.LE_SUPABASE_SERVICE_ROLE_KEY!;
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon;
    process.env.SUPABASE_SERVICE_ROLE_KEY = service;
    process.env.CRON_SECRET = SECRET;
    admin = createClient(url, service, opts);
  });

  afterAll(async () => {
    current.admin = null;
    for (const u of users) await admin.auth.admin.deleteUser(u.id).catch(() => undefined);
    await cron().catch(() => undefined);
  });

  describe("cron auth", () => {
    it("every unauthorized request is a bare 401 that drains nothing and says nothing, GET and POST", async () => {
      const A = await makeUser("ca");
      const s = await source(A);
      await deleteSource(failingRemove(A.client), s.sourceId, false, () => undefined);
      expect(await fileExists(s.path)).toBe(true);
      const bad = [null, "", "Bearer", "Bearer ", "Bearer wrong", SECRET, `bearer ${SECRET}`, `Bearer ${SECRET}x`, `Basic ${SECRET}`, `Bearer ${service}`, `Bearer ${anon}`];
      for (const method of ["GET", "POST"] as const) {
        for (const auth of bad) {
          const res = await cron(method, auth);
          expect(res.status, `${method} ${auth}`).toBe(401);
          expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue.", retryable: false } });
        }
      }
      expect(await fileExists(s.path)).toBe(true);
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([s.path]);
    });

    it("a user's own valid session token is not a cron credential", async () => {
      const A = await makeUser("cb");
      const token = (await A.client.auth.getSession()).data.session!.access_token;
      expect((await cron("GET", `Bearer ${token}`)).status).toBe(401);
    });

    it.each([[undefined], [""], ["   "]])("CRON_SECRET %j: everything is refused, including an empty or matching-blank bearer", async (value) => {
      const saved = process.env.CRON_SECRET;
      if (value === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = value;
      try {
        for (const auth of [null, "", "Bearer", "Bearer ", "Bearer    ", "Bearer undefined", SECRET, `Bearer ${SECRET}`]) {
          expect((await cron("GET", auth)).status, String(auth)).toBe(401);
          expect((await cron("POST", auth)).status, String(auth)).toBe(401);
        }
      } finally {
        process.env.CRON_SECRET = saved;
      }
    });

    it("authorized, GET and POST: finishes the queue, answers counts only, and leaves live files alone", async () => {
      const A = await makeUser("cc");
      const B = await makeUser("cd");
      const gone = await source(A);
      const kept = await source(A);
      const other = await source(B);
      const orphanUpload = await upload(B);
      await deleteSource(failingRemove(A.client), gone.sourceId, false, () => undefined);
      expect(await fileExists(gone.path)).toBe(true);

      const res = await cron("GET");
      const text = await res.text();
      expect(res.status, text).toBe(200);
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["accounts_cleared", "accounts_pending", "audit_pending", "audit_purged", "files_found", "files_remaining", "ok"].sort());
      expect(text).not.toContain(A.id);
      expect(text).not.toContain(A.email);
      expect(await fileExists(gone.path)).toBe(false);
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([]);
      for (const p of [kept.path, other.path, orphanUpload]) expect(await fileExists(p), p).toBe(true);

      expect((await cron("POST")).status).toBe(200);
      for (const p of [kept.path, other.path, orphanUpload]) expect(await fileExists(p), p).toBe(true);
    });

    it("a queue entry whose path a live source owns is dropped, never removed", async () => {
      const A = await makeUser("ce");
      const s = await source(A);
      psql(`insert into private.storage_deletions (user_id, path) values ('${A.id}', '${s.path}')`);
      expect((await cron()).status).toBe(200);
      expect(await fileExists(s.path)).toBe(true);
      expect(psql(`select count(*) from private.storage_deletions where path='${s.path}'`)).toBe("0");
    });
  });

  describe("account deletion failing at each step", () => {
    it("prepare refused: nothing at all is deleted, no pending row, a retryable error", async () => {
      const A = await makeUser("pa");
      const s = await source(A);
      const res = await deleteAccount(faulty(admin, { prepare: true }), A.id, { email: A.email, logger: () => undefined });
      expect(res).toMatchObject({ ok: false, error: { code: "save_failed", retryable: true } });
      expect(await userExists(A.id)).toBe(true);
      expect(await fileExists(s.path)).toBe(true);
      expect(await rowsLeft(A.id)).toBeGreaterThan(0);
      expect(pendingAudit(A.id)).toBe(0);
      expect(pendingFiles(A.id)).toBe(0);
    });

    it("prepare refused for real (no delete privilege on the audit log): the action deletes nothing and sets no cookie", async () => {
      const A = await makeUser("pb");
      const s = await source(A);
      psql("revoke delete on auth.audit_log_entries from postgres", "supabase_admin");
      try {
        expect(psql("select has_table_privilege('postgres','auth.audit_log_entries','delete')")).toBe("f");
        current.client = A.client;
        current.admin = null;
        jar.set.length = 0;
        const res = await deleteAccountAction("delete");
        expect(res).toMatchObject({ ok: false, error: { code: "save_failed" } });
        expect(jar.set).toEqual([]);
        expect(await userExists(A.id)).toBe(true);
        expect(await fileExists(s.path)).toBe(true);
      } finally {
        psql("grant delete on auth.audit_log_entries to postgres", "supabase_admin");
      }
      expect(psql("select has_table_privilege('postgres','auth.audit_log_entries','delete')")).toBe("t");
    });

    it("first sweep fails: the account and its files stay, no success, no cookie", async () => {
      const A = await makeUser("pc");
      const s = await source(A);
      current.client = A.client;
      current.admin = faulty(admin, { firstList: true });
      jar.set.length = 0;
      try {
        expect(await deleteAccountAction("delete")).toMatchObject({ ok: false, error: { code: "save_failed" } });
      } finally {
        current.admin = null;
      }
      expect(jar.set).toEqual([]);
      expect(await userExists(A.id)).toBe(true);
      expect(await fileExists(s.path)).toBe(true);
    });

    it("deleteUser refused: the account stays and the result is a failure", async () => {
      const A = await makeUser("pd");
      await source(A);
      current.client = A.client;
      current.admin = faulty(admin, { deleteUser: "refused" });
      jar.set.length = 0;
      try {
        expect(await deleteAccountAction("delete")).toMatchObject({ ok: false, error: { code: "save_failed" } });
      } finally {
        current.admin = null;
      }
      expect(jar.set).toEqual([]);
      expect(await userExists(A.id)).toBe(true);
    });

    // OPEN DEFECT S11-D6 (blocker, rules 8 and 10): the first sweep removes every file before deleteUser runs.
    // If deleteUser then fails, the user is told "That didn't save. Try again." and keeps the account with
    // its files already gone and its sources still marked as having one.
    it("deleteUser refused: the surviving account keeps its files (it was told nothing was saved)", async () => {
      const A = await makeUser("pe");
      const s = await source(A);
      await deleteAccount(faulty(admin, { deleteUser: "refused" }), A.id, { email: A.email, logger: () => undefined });
      expect(await userExists(A.id)).toBe(true);
      expect(await fileExists(s.path)).toBe(true);
    });

    it("deleteUser reports an error though the user is gone: it carries on as a successful deletion", async () => {
      const A = await makeUser("pf");
      const s = await source(A);
      current.client = A.client;
      current.admin = faulty(admin, { deleteUser: "after" });
      jar.set.length = 0;
      try {
        expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      } finally {
        current.admin = null;
      }
      expect(jar.set.map((c) => c.value)).toEqual(["1"]);
      expect(await userExists(A.id)).toBe(false);
      expect(await rowsLeft(A.id)).toBe(0);
      expect(await fileExists(s.path)).toBe(false);
      expect(auditCount(A)).toBe(0);
      expect(pendingAudit(A.id)).toBe(0);

      // A repeat from the dead session: not a success, not a second deletion.
      expect(await deleteAccountAction("delete")).toMatchObject({ ok: false, error: { code: "unauthenticated" } });

      expect(pendingAudit(A.id)).toBe(0);
      expect(pendingFiles(A.id)).toBe(0);
    });

    it("final sweep fails: account gone, cookie 3, the file stays until cron removes it", async () => {
      const A = await makeUser("pg");
      const s = await source(A);
      current.client = A.client;
      current.admin = faulty(admin, { finalSweep: true });
      jar.set.length = 0;
      try {
        expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      } finally {
        current.admin = null;
      }
      expect(jar.set.map((c) => c.value)).toEqual(["3"]);
      expect(await userExists(A.id)).toBe(false);
      expect(auditCount(A)).toBe(0);
      expect(pendingFiles(A.id)).toBe(1);
      const late = `${A.id}/${randomUUID()}`;
      expect((await admin.storage.from("sources").upload(late, new Blob(["late race"]), { contentType: "text/plain" })).error).toBeNull();
      expect(await fileExists(s.path)).toBe(true);

      const res = await cron();
      const body = (await res.json()) as { accounts_cleared: number };
      expect(res.status).toBe(200);
      expect(body.accounts_cleared).toBeGreaterThanOrEqual(1);
      expect(await fileExists(late)).toBe(false);
      expect(await fileExists(s.path)).toBe(false);
      expect(pendingFiles(A.id)).toBe(0);
    });

    it("purge fails: account gone, cookie 2, pending row holds the email until cron purges", async () => {
      const A = await makeUser("ph");
      await source(A);
      current.client = A.client;
      current.admin = faulty(admin, { purge: true });
      jar.set.length = 0;
      try {
        expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      } finally {
        current.admin = null;
      }
      expect(jar.set.map((c) => c.value)).toEqual(["2"]);
      expect(auditCount(A)).toBeGreaterThan(0);
      expect(pendingAudit(A.id)).toBe(1);
      expect((await cron()).status).toBe(200);
      expect(auditCount(A)).toBe(0);
      expect(pendingAudit(A.id)).toBe(0);
    });

    it("both fail: cookie 4; a cron run that still can't finish answers 500 with counts and keeps both pending", async () => {
      const A = await makeUser("pi");
      const s = await source(A);
      const extra = `${A.id}/${randomUUID()}`;
      current.client = A.client;
      current.admin = faulty(admin, { purge: true, finalSweep: true });
      jar.set.length = 0;
      try {
        expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      } finally {
        current.admin = null;
      }
      expect(jar.set.map((c) => c.value)).toEqual(["4"]);
      expect((await admin.storage.from("sources").upload(extra, new Blob(["late"]), { contentType: "text/plain" })).error).toBeNull();
      expect(await fileExists(s.path)).toBe(true);

      // Cron with Storage's remove failing: the account stays pending, the purge still finishes.
      const broken = createClient(url, service, opts);
      broken.storage.from = (() => ({
        list: () => Promise.resolve({ data: null, error: { code: "injected" } }),
        remove: () => Promise.resolve({ data: null, error: { code: "injected" } }),
      })) as never;
      current.admin = broken;
      try {
        const res = await cron();
        const text = await res.text();
        expect(res.status, text).toBe(500);
        const body = JSON.parse(text) as Record<string, unknown>;
        expect(body).toMatchObject({ error: { code: "save_failed" }, accounts_cleared: 0 });
        expect(Number(body.accounts_pending)).toBeGreaterThanOrEqual(1);
        expect(text).not.toContain(A.id);
        expect(text).not.toContain(A.email);
      } finally {
        current.admin = null;
      }
      expect(pendingFiles(A.id)).toBe(1);
      expect(await fileExists(extra)).toBe(true);

      expect((await cron()).status).toBe(200);
      expect(await fileExists(extra)).toBe(false);
      expect(await fileExists(s.path)).toBe(false);
      expect(auditCount(A)).toBe(0);
      expect(pendingAudit(A.id)).toBe(0);
      expect(pendingFiles(A.id)).toBe(0);
    });
  });

  describe("pending rows on an account that survives", () => {
    it("cron never touches the live account's files, new or old, at any age of the pending row", async () => {
      const A = await makeUser("sa");
      const s = await source(A);
      current.client = A.client;
      current.admin = faulty(admin, { firstList: true });
      try {
        expect((await deleteAccountAction("delete")).ok).toBe(false);
      } finally {
        current.admin = null;
      }
      expect(pendingFiles(A.id)).toBe(1);
      expect(pendingAudit(A.id)).toBe(1);

      // The user carries on using the account.
      const later = await source(A);
      const before = auditCount(A);
      expect((await cron()).status).toBe(200);
      expect(await fileExists(s.path)).toBe(true);
      expect(await fileExists(later.path)).toBe(true);
      expect(auditCount(A)).toBe(before);

      // A day later the rows go, with the email, and the files stay.
      psql(`update private.auth_audit_purges set created_at = now() - interval '25 hours' where user_id='${A.id}'`);
      psql(`update private.account_file_purges set created_at = now() - interval '25 hours' where user_id='${A.id}'`);
      expect((await cron()).status).toBe(200);
      expect(pendingAudit(A.id)).toBe(0);
      expect(pendingFiles(A.id)).toBe(0);
      expect(await fileExists(s.path)).toBe(true);
      expect(await fileExists(later.path)).toBe(true);
      expect(auditCount(A)).toBe(before);
    });

    it("the direct purge functions refuse a live user, so nothing can take its files or sign-in history", async () => {
      const A = await makeUser("sb");
      const before = auditCount(A);
      expect((await admin.rpc("auth_audit_purge", { p_user_id: A.id, p_email: A.email })).error?.code).toBe("22023");
      expect((await admin.rpc("account_file_purge_clear", { p_user_id: A.id })).error?.code).toBe("22023");
      expect(auditCount(A)).toBe(before);
    });

    it("a failed attempt followed by a successful one leaves nothing pending", async () => {
      const A = await makeUser("sc");
      await source(A);
      current.client = A.client;
      current.admin = faulty(admin, { firstList: true });
      try {
        expect((await deleteAccountAction("delete")).ok).toBe(false);
      } finally {
        current.admin = null;
      }
      expect(pendingAudit(A.id)).toBe(1);
      jar.set.length = 0;
      expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      expect(jar.set.map((c) => c.value)).toEqual(["1"]);
      expect(pendingAudit(A.id)).toBe(0);
      expect(pendingFiles(A.id)).toBe(0);
      expect(auditCount(A)).toBe(0);
    });
  });

  describe("audit log purge", () => {
    it("no trace anywhere in the database: user_deleted included; another user's entries and service-role entries stay", async () => {
      const A = await makeUser("aa");
      const B = await makeUser("ab");
      await source(A);
      const bBefore = auditCount(B);
      expect(bBefore).toBeGreaterThan(0);
      expect(auditCount(A)).toBeGreaterThan(0);
      current.client = A.client;
      jar.set.length = 0;
      expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      expect(jar.set.map((c) => c.value)).toEqual(["1"]);
      expect(auditCount(A)).toBe(0);
      expect(auditCount(B)).toBe(bBefore);
      expect(pendingAudit(A.id)).toBe(0);
      expect(pendingFiles(A.id)).toBe(0);
      const all = dump(["public", "private", "storage", "auth"]);
      expect(all.split("\n").filter((l) => l.includes(A.id))).toEqual([]);
      expect(all.split("\n").filter((l) => l.toLowerCase().includes(A.email.toLowerCase()))).toEqual([]);
    });

    it("a similar address and an address that merely contains the email are not touched", async () => {
      const local = `le-test-u11sim${randomUUID().slice(0, 6)}`;
      const A = await makeUser("ac", `${local}@example.com`);
      const near = await makeUser("ad", `x${local}@example.com`);
      const nearBefore = auditCount(near);
      current.client = A.client;
      expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      expect(Number(psql(`select count(*) from auth.audit_log_entries where payload::text ilike '%${near.id}%'`))).toBeGreaterThan(0);
      expect(auditCount(near)).toBe(nearBefore);
    });

    it("re-registered with the same email while the purge is pending: the new user's entries stay, the old user's go, the pending row goes", async () => {
      const email = `le-test-u11re-${randomUUID().slice(0, 6)}@example.com`;
      const A = await makeUser("ae", email);
      current.client = A.client;
      current.admin = faulty(admin, { purge: true });
      try {
        expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      } finally {
        current.admin = null;
      }
      expect(pendingAudit(A.id)).toBe(1);
      const Y = await makeUser("af", email);
      expect(Y.id).not.toBe(A.id);
      const yEntries = () => Number(psql(`select count(*) from auth.audit_log_entries where payload::text ilike '%${Y.id}%'`));
      const before = yEntries();
      expect(before).toBeGreaterThan(0);

      expect((await cron()).status).toBe(200);
      expect(Number(psql(`select count(*) from auth.audit_log_entries where payload::text ilike '%${A.id}%'`))).toBe(0);
      expect(yEntries()).toBe(before);
      expect(pendingAudit(A.id)).toBe(0);
    });

    it("the same email deleted and registered again, no purge pending: the new account deletes cleanly too", async () => {
      const email = `le-test-u11twice-${randomUUID().slice(0, 6)}@example.com`;
      const A = await makeUser("ag", email);
      current.client = A.client;
      expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      const Y = await makeUser("ah", email);
      const yBefore = auditCount(Y);
      expect(yBefore).toBeGreaterThan(0);
      current.client = Y.client;
      expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      expect(auditCount(Y)).toBe(0);
    });

    it("the pending rows leak to nobody: no grants, no RPC, nothing through PostgREST", async () => {
      const A = await makeUser("ai");
      const anonClient = createClient(url, anon, opts);
      for (const c of [anonClient, A.client, admin]) {
        for (const t of ["auth_audit_purges", "account_file_purges", "thread_suppression_hashes", "storage_deletions"]) {
          const r = await c.schema("private").from(t).select("*");
          expect(r.data, t).toBeNull();
          expect(r.error, t).not.toBeNull();
          const p = await c.from(t).select("*");
          expect(p.data, t).toBeNull();
        }
      }
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const t of ["auth_audit_purges", "account_file_purges", "thread_suppression_hashes", "storage_deletions"]) {
          expect(psql(`select has_table_privilege('${role}','private.${t}','select')`), `${role} ${t}`).toBe("f");
        }
      }
      const uid = randomUUID();
      for (const c of [anonClient, A.client]) {
        for (const [fn, args] of [
          ["auth_audit_purge_prepare", { p_user_id: A.id, p_email: A.email }],
          ["auth_audit_purge", { p_user_id: uid, p_email: null }],
          ["auth_audit_purge_pending", {}],
          ["account_file_purges_pending", {}],
          ["account_file_purge_clear", { p_user_id: uid }],
          ["storage_deletions_sweep", {}],
        ] as const) {
          expect((await c.rpc(fn, args)).error?.code, fn).toBe("42501");
        }
      }
      expect(pendingAudit(A.id)).toBe(0);
    });
  });

  describe("D5 hash table", () => {
    async function threadWithHash(u: User) {
      const text = `Order cedar posts ${randomUUID().slice(0, 8)} Monday.`;
      const quote = text.slice(0, -1);
      const src = await admin.from("sources").insert({ user_id: u.id, kind: "paste", title: "Synthetic", text_content: text, reference_date: "2026-10-20", reference_date_source: "user" }).select("id").single();
      const ex = await admin.from("extractions").insert({ user_id: u.id, source_id: src.data!.id, status: "succeeded", model: "fake:recorded", prompt_version: "extract.v1", schema_version: "extraction.v1" }).select("id").single();
      const thr = await admin.from("threads").insert({ user_id: u.id, title: "Cedar", kind: "commitment", status: "open", primary_source_id: src.data!.id }).select("id").single();
      const hash = suppressionHash(text, quote);
      const it = await admin.from("extraction_items").insert({ user_id: u.id, extraction_id: ex.data!.id, item_index: 0, band: "high", confidence: 0.9, review_status: "accepted", thread_id: thr.data!.id, suppression_hash: hash, payload: { item: { type: "commitment", title: quote }, label: { word: "Likely", reason: "synthetic" } } }).select("id").single();
      expect(it.error).toBeNull();
      return { sourceId: src.data!.id as string, threadId: thr.data!.id as string, hash, quote };
    }

    it("the table has only thread id, user id and hash; after source-only delete it holds the hash and no text; forget moves it to a suppression", async () => {
      const A = await makeUser("ha");
      expect(psql("select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='private' and table_name='thread_suppression_hashes'")).toBe("thread_id,user_id,suppression_hash");
      const t = await threadWithHash(A);
      expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
      expect((await A.client.rpc("delete_source", { p_source_id: t.sourceId, p_everything: false })).data).toMatchObject({ ok: true });
      expect(psql(`select suppression_hash from private.thread_suppression_hashes where thread_id='${t.threadId}'`)).toBe(t.hash);
      expect(psql(`select count(*) from private.thread_suppression_hashes where suppression_hash !~ '^[0-9a-f]{64}$' and user_id='${A.id}'`)).toBe("0");
      expect((await admin.from("suppressions").select("suppression_hash").eq("user_id", A.id)).data).toEqual([]);
      expect((await A.client.rpc("forget_thread", { p_thread_id: t.threadId, p_delete_source: false })).error).toBeNull();
      expect((await admin.from("suppressions").select("suppression_hash, reason, thread_id").eq("user_id", A.id)).data).toEqual([{ suppression_hash: t.hash, reason: "forgotten", thread_id: null }]);
      expect(psql(`select count(*) from private.thread_suppression_hashes where thread_id='${t.threadId}'`)).toBe("0");
    });

    it("a plain forget and delete-everything give one hash each; account deletion leaves none in either table", async () => {
      const A = await makeUser("hb");
      const a = await threadWithHash(A);
      const b = await threadWithHash(A);
      const c = await threadWithHash(A);
      expect((await A.client.rpc("forget_thread", { p_thread_id: a.threadId, p_delete_source: false })).error).toBeNull();
      expect((await A.client.rpc("delete_source", { p_source_id: b.sourceId, p_everything: true })).data).toMatchObject({ ok: true, threads_forgotten: 1 });
      expect(((await admin.from("suppressions").select("suppression_hash").eq("user_id", A.id)).data ?? []).map((r) => r.suppression_hash).sort()).toEqual([a.hash, b.hash].sort());
      expect((await A.client.rpc("delete_source", { p_source_id: c.sourceId, p_everything: false })).data).toMatchObject({ ok: true });
      expect(psql(`select count(*) from private.thread_suppression_hashes where user_id='${A.id}'`)).toBe("1");
      current.client = A.client;
      expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      expect(psql(`select count(*) from private.thread_suppression_hashes where user_id='${A.id}'`)).toBe("0");
      expect((await admin.from("suppressions").select("suppression_hash").eq("user_id", A.id)).data).toEqual([]);
    });

    it("no other user's thread is touched by the keep and suppress triggers", async () => {
      const A = await makeUser("hc");
      const B = await makeUser("hd");
      const a = await threadWithHash(A);
      const b = await threadWithHash(B);
      await A.client.rpc("delete_source", { p_source_id: a.sourceId, p_everything: true });
      expect((await admin.from("suppressions").select("suppression_hash").eq("user_id", B.id)).data).toEqual([]);
      expect((await admin.from("threads").select("id").eq("id", b.threadId)).data).toHaveLength(1);
    });
  });

  describe("S11-D6: the order and what a refused deletion leaves", () => {
    /** The real client, recording each step and what the database and Storage held at that moment. */
    function traced(u: User, s: { path: string }, seen: string[], hooks: { removeFailAfter?: number } = {}): AccountAdminClient {
      let removes = 0;
      return {
        storage: {
          from: (bucket) => ({
            list: async (prefix, o) => {
              seen.push(`list pending=${pendingFiles(u.id)}/${pendingAudit(u.id)} user=${await userExists(u.id)}`);
              return admin.storage.from(bucket).list(prefix, o) as never;
            },
            remove: async (paths) => {
              removes += 1;
              seen.push(`remove user=${await userExists(u.id)}`);
              if (hooks.removeFailAfter !== undefined && removes > hooks.removeFailAfter) return { data: null, error: { code: "injected" } };
              return admin.storage.from(bucket).remove(paths) as never;
            },
          }),
        },
        auth: {
          admin: {
            getUserById: (id) => admin.auth.admin.getUserById(id) as never,
            deleteUser: async (id) => {
              seen.push(`deleteUser file=${await fileExists(s.path)} pending=${pendingFiles(u.id)}/${pendingAudit(u.id)}`);
              return admin.auth.admin.deleteUser(id) as never;
            },
          },
        },
        rpc: async (fn, args) => {
          seen.push(`rpc ${fn}`);
          return admin.rpc(fn, args) as never;
        },
      };
    }

    it("pending rows, Storage answers, deleteUser, purge, sweep: no file goes while the user exists", async () => {
      const A = await makeUser("oa");
      const s = await source(A);
      const seen: string[] = [];
      const res = await deleteAccount(traced(A, s, seen), A.id, { email: A.email, logger: () => undefined });
      expect(res).toMatchObject({ ok: true, objectsRemoved: 1 });
      expect(seen[0]).toBe("rpc auth_audit_purge_prepare");
      expect(seen[1]).toBe("list pending=1/1 user=true");
      expect(seen[2]).toBe("deleteUser file=true pending=1/1");
      expect(seen[3]).toBe("rpc auth_audit_purge");
      // The sweep: list, remove, list to prove it empty, then the row clears.
      expect(seen[4]).toMatch(/^list pending=1\/0 user=false$/);
      expect(seen[5]).toBe("remove user=false");
      expect(seen.at(-1)).toBe("rpc account_file_purge_clear");
      expect(seen.filter((x) => x.startsWith("remove") && x.includes("user=true"))).toEqual([]);
      expect(pendingFiles(A.id)).toBe(0);
      expect(pendingAudit(A.id)).toBe(0);
    });

    it("deleteUser refused and the user is there: account, every file, every row and the sign-in history stay; a retry then succeeds", async () => {
      const A = await makeUser("ob");
      const one = await source(A);
      const two = await source(A);
      const unowned = await upload(A);
      const rows = await rowsLeft(A.id);
      const audit = auditCount(A);
      current.client = A.client;
      current.admin = faulty(admin, { deleteUser: "refused" });
      jar.set.length = 0;
      try {
        expect(await deleteAccountAction("delete")).toEqual({ ok: false, error: { code: "save_failed", message: "That didn't save. Try again.", retryable: true } });
      } finally {
        current.admin = null;
      }
      expect(jar.set).toEqual([]);
      expect(await userExists(A.id)).toBe(true);
      for (const p of [one.path, two.path, unowned]) expect(await fileExists(p), p).toBe(true);
      if (STORAGE) for (const p of [one.path, two.path, unowned]) expect(onDisk(p), p).toBe(true);
      expect(await rowsLeft(A.id)).toBe(rows);
      expect(auditCount(A)).toBe(audit);

      expect((await cron()).status).toBe(200);
      for (const p of [one.path, two.path, unowned]) expect(await fileExists(p), p).toBe(true);

      expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      for (const p of [one.path, two.path, unowned]) expect(await fileExists(p), p).toBe(false);
      expect(auditCount(A)).toBe(0);
    });

    it("Storage fails partway through the sweep: the account goes, some files wait for cron, cookie 3 and nothing else", async () => {
      const A = await makeUser("oc");
      const one = await source(A);
      const two = await source(A);
      const seen: string[] = [];
      const res = await deleteAccount(traced(A, one, seen, { removeFailAfter: 1 }), A.id, { email: A.email, pageSize: 1, logger: () => undefined });
      expect(res).toMatchObject({ ok: true, filesRemain: true });
      expect(res).not.toHaveProperty("signInRecordsRemain");
      expect(await userExists(A.id)).toBe(false);
      expect(await rowsLeft(A.id)).toBe(0);
      expect([await fileExists(one.path), await fileExists(two.path)].filter(Boolean)).toHaveLength(1);
      expect(auditCount(A)).toBe(0);
      expect(pendingFiles(A.id)).toBe(1);
      expect((await cron()).status).toBe(200);
      expect(await fileExists(one.path)).toBe(false);
      expect(await fileExists(two.path)).toBe(false);
      expect(pendingFiles(A.id)).toBe(0);
    });

    it("the same through the action: cookie 3", async () => {
      const A = await makeUser("od");
      await source(A);
      current.client = A.client;
      const seen: string[] = [];
      current.admin = traced(A, { path: `${A.id}/none` }, seen, { removeFailAfter: 0 });
      jar.set.length = 0;
      try {
        expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      } finally {
        current.admin = null;
      }
      expect(jar.set.map((c) => c.value)).toEqual(["3"]);
      expect((await cron()).status).toBe(200);
      expect(pendingFiles(A.id)).toBe(0);
    });

    it("late upload after the sweep: the session's token is refused once the profile is gone, so nothing is stranded", async () => {
      const A = await makeUser("oe");
      await source(A);
      current.client = A.client;
      expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      const token = createClient(url, anon, { ...opts, global: { headers: { Authorization: `Bearer ${(await A.client.auth.getSession()).data.session?.access_token ?? anon}` } } });
      const late = await token.storage.from("sources").upload(`${A.id}/${randomUUID()}`, new Blob(["late"]), { contentType: "text/plain" });
      expect(late.error).not.toBeNull();
      expect(Number(psql(`select count(*) from storage.objects where name like '${A.id}/%'`))).toBe(0);
    });
  });

  describe.runIf(AUTH)("deleteUser error, then the check, against a really stopped Auth", () => {
    const startAuth = async () => {
      execFileSync("docker", ["start", AUTH!], { encoding: "utf8" });
      await vi.waitFor(
        async () => {
          const r = await admin.auth.admin.listUsers({ perPage: 1 });
          expect(r.error).toBeNull();
        },
        { timeout: 90_000, interval: 1_000 },
      );
    };
    /** The real client. `beforeDelete` / `afterDelete` run around a real or skipped deleteUser. */
    const withAuth = (mode: "down-first" | "gone-then-down"): AccountAdminClient => ({
      storage: { from: (b) => admin.storage.from(b) as never },
      auth: {
        admin: {
          getUserById: (id) => admin.auth.admin.getUserById(id) as never,
          deleteUser: async (id) => {
            if (mode === "down-first") {
              execFileSync("docker", ["stop", "-t", "1", AUTH!], { encoding: "utf8" });
              return admin.auth.admin.deleteUser(id) as never;
            }
            const res = await admin.auth.admin.deleteUser(id);
            if (res.error) return res as never;
            execFileSync("docker", ["stop", "-t", "1", AUTH!], { encoding: "utf8" });
            return { data: null, error: { status: 504, code: "injected" } };
          },
        },
      },
      rpc: (fn, args) => admin.rpc(fn, args) as never,
    });

    it(
      "Auth down before the delete: says it couldn't confirm, deletes nothing; a retry after Auth returns succeeds",
      async () => {
        const A = await makeUser("ua");
        const s = await source(A);
        const audit = auditCount(A);
        current.client = A.client;
        current.admin = withAuth("down-first");
        jar.set.length = 0;
        let res;
        const t0 = Date.now();
        try {
          res = await deleteAccountAction("delete");
        } finally {
          current.admin = null;
          await startAuth();
        }
        console.log(`auth down: answered in ${Date.now() - t0} ms including the restart`);
        expect(res).toMatchObject({ ok: false, error: { code: "save_failed", message: expect.stringContaining("I couldn't confirm whether your account was deleted") } });
        expect(jar.set).toEqual([]);
        expect(await userExists(A.id)).toBe(true);
        expect(await fileExists(s.path)).toBe(true);
        expect(auditCount(A)).toBeGreaterThanOrEqual(audit);
        expect((await cron()).status).toBe(200);
        expect(await fileExists(s.path)).toBe(true);
        expect(await deleteAccountAction("delete")).toEqual({ ok: true });
        expect(await fileExists(s.path)).toBe(false);
      },
      240_000,
    );

    it(
      "the user went and the check fails: couldn't confirm, no cookie; cron finishes the audit log and every file",
      async () => {
        const A = await makeUser("ub");
        const s = await source(A);
        current.client = A.client;
        current.admin = withAuth("gone-then-down");
        jar.set.length = 0;
        let res;
        try {
          res = await deleteAccountAction("delete");
        } finally {
          current.admin = null;
          await startAuth();
        }
        expect(res).toMatchObject({ ok: false, error: { message: expect.stringContaining("I couldn't confirm whether your account was deleted") } });
        expect(jar.set).toEqual([]);
        expect(await userExists(A.id)).toBe(false);
        expect(await rowsLeft(A.id)).toBe(0);
        expect(await fileExists(s.path)).toBe(true);
        expect(pendingFiles(A.id)).toBe(1);
        expect(pendingAudit(A.id)).toBe(1);
        expect((await cron()).status).toBe(200);
        expect(await fileExists(s.path)).toBe(false);
        expect(auditCount(A)).toBe(0);
        expect(pendingFiles(A.id)).toBe(0);
        expect(pendingAudit(A.id)).toBe(0);
      },
      240_000,
    );

    it(
      "a hung Auth call: answered within two 15 s limits, says it couldn't confirm; whichever way the delete lands, the outcome is consistent",
      async () => {
        const A = await makeUser("uc");
        const s = await source(A);
        current.client = A.client;
        const hung: AccountAdminClient = {
          ...withAuth("down-first"),
          auth: {
            admin: {
              getUserById: (id) => admin.auth.admin.getUserById(id) as never,
              deleteUser: async (id) => {
                execFileSync("docker", ["pause", AUTH!], { encoding: "utf8" });
                return admin.auth.admin.deleteUser(id) as never;
              },
            },
          },
        };
        current.admin = hung;
        const t0 = Date.now();
        let res;
        try {
          res = await deleteAccountAction("delete");
        } finally {
          current.admin = null;
          execFileSync("docker", ["unpause", AUTH!], { encoding: "utf8" });
        }
        const ms = Date.now() - t0;
        process.stderr.write(`HUNG AUTH: action answered after ${ms} ms: ${JSON.stringify(res)}\n`);
        await startAuth();
        expect(ms).toBeLessThan(40_000);
        expect(res).toMatchObject({ ok: false, error: { message: expect.stringContaining("I couldn't confirm whether your account was deleted") } });
        // The request held by the paused container can still land once it resumes, which is why the
        // message can't say either way. So: nothing else was deleted, and cron finishes if it did land.
        expect((await cron()).status).toBe(200);
        if (await userExists(A.id)) expect(await fileExists(s.path)).toBe(true);
        else expect(await fileExists(s.path)).toBe(false);
      },
      420_000,
    );
  });

  describe.runIf(STORAGE)("a real Storage outage", () => {
    const start = async () => {
      execFileSync("docker", ["start", STORAGE!], { encoding: "utf8" });
      await vi.waitFor(
        async () => {
          const r = await admin.storage.from("sources").list("x");
          expect(r.error).toBeNull();
        },
        { timeout: 90_000, interval: 1_000 },
      );
    };

    it(
      "cron with Storage down: 500 with counts inside the time limit; entries stay queued; the next run finishes",
      async () => {
        const A = await makeUser("oa");
        const s = await source(A);
        await deleteSource(failingRemove(A.client), s.sourceId, false, () => undefined);
        execFileSync("docker", ["stop", "-t", "1", STORAGE!], { encoding: "utf8" });
        try {
          const t0 = Date.now();
          const res = await cron();
          const ms = Date.now() - t0;
          const text = await res.text();
          console.log(`cron outage: ${res.status} in ${ms} ms: ${text}`);
          expect(res.status, text).toBe(500);
          expect(JSON.parse(text)).toMatchObject({ error: { code: "save_failed" } });
          expect(Number((JSON.parse(text) as { files_found: number }).files_found)).toBeGreaterThanOrEqual(1);
          expect(ms).toBeLessThan(40_000);
          expect(psql(`select count(*) from private.storage_deletions where path='${s.path}'`)).toBe("1");
        } finally {
          await start();
        }
        expect((await cron()).status).toBe(200);
        expect(await fileExists(s.path)).toBe(false);
      },
      240_000,
    );

    it(
      "account deletion with Storage down: refused in time, nothing deleted, cron leaves the live account alone",
      async () => {
        const A = await makeUser("ob");
        const s = await source(A);
        current.client = A.client;
        jar.set.length = 0;
        execFileSync("docker", ["stop", "-t", "1", STORAGE!], { encoding: "utf8" });
        try {
          const t0 = Date.now();
          const res = await deleteAccountAction("delete");
          console.log(`account outage: ${JSON.stringify(res)} in ${Date.now() - t0} ms`);
          expect(res).toMatchObject({ ok: false, error: { code: "save_failed" } });
          expect(Date.now() - t0).toBeLessThan(40_000);
          expect(jar.set).toEqual([]);
        } finally {
          await start();
        }
        expect(await userExists(A.id)).toBe(true);
        expect(await fileExists(s.path)).toBe(true);
        expect(onDisk(s.path)).toBe(true);
        expect(auditCount(A)).toBeGreaterThan(0);
        expect(await rowsLeft(A.id)).toBeGreaterThan(0);
        expect((await cron()).status).toBe(200);
        expect(await fileExists(s.path)).toBe(true);
      },
      240_000,
    );
  });
});
