/**
 * Lead-tester, S11 (F13, F9 Forget, D14; rules 8, 9, 10), independent of the developer's
 * delete-live.test.ts, against REAL local Supabase. Targets what that file does not cover: several
 * threads per source, pending proposals, decisions, raw model output, the queue's failure paths
 * (Storage down, retry), cross-user use of the new functions, old tokens after account deletion,
 * paging past 1,000 rows, and a whole-database scan for leftover content.
 *
 * Skipped unless LE_SUPABASE_LIVE=1. LE_S11_DB_CONTAINER (the stack's db container name) turns on the
 * pg_dump residue scan and the private-queue checks. Throwaway users; synthetic text; no model.
 */
import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => undefined, get: () => undefined }) }));
vi.mock("@/lib/analytics/track", () => ({ track: () => undefined, createTracker: () => ({ track: () => undefined }) }));

import { GET as exportRoute } from "@/app/api/export/route";
import { deleteAccountAction, deleteSourceAction } from "@/app/settings/data-actions";
import { forgetAction } from "@/app/threads/[id]/actions";
import { deleteSource, forgetThread, type DataClient } from "@/lib/account/data";
import { EXPORT_TABLES } from "@/lib/account/export";

const live = process.env.LE_SUPABASE_LIVE === "1";
const DB = process.env.LE_S11_DB_CONTAINER;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

function env() {
  if (process.env.LE_SUPABASE_URL && process.env.LE_SUPABASE_ANON_KEY && process.env.LE_SUPABASE_SERVICE_ROLE_KEY) {
    return { url: process.env.LE_SUPABASE_URL, anon: process.env.LE_SUPABASE_ANON_KEY, service: process.env.LE_SUPABASE_SERVICE_ROLE_KEY };
  }
  const out = execSync("pnpm exec supabase status -o json", { stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).toString();
  const j = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string>;
  return { url: j.API_URL!, anon: j.ANON_KEY!, service: j.SERVICE_ROLE_KEY! };
}

type User = { id: string; email: string; client: SupabaseClient; token: string };
const nowIso = () => new Date().toISOString();

const psql = (sql: string) => execFileSync("docker", ["exec", DB!, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql], { encoding: "utf8" }).trim();
const dumpHas = (marker: string, schemas = ["public", "private", "storage"]) => {
  const out = execFileSync("docker", ["exec", DB!, "pg_dump", "-U", "postgres", "-d", "postgres", "--data-only", "--inserts", ...schemas.flatMap((s) => ["-n", s])], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  return out.split("\n").filter((l) => l.includes(marker));
};

/** Whether the object's bytes are still on the storage container's disk, not just its catalog row. */
const onDisk = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const out = execFileSync("docker", ["exec", DB!.replace("supabase_db_", "supabase_storage_"), "sh", "-c", `find /mnt -path '*${name}*' -type f | wc -l`], { encoding: "utf8" });
  return Number(out.trim()) > 0;
};

/** A real user client whose Storage `remove` fails `failures` times, as a Storage outage would. */
function failingStorage(client: SupabaseClient, failures: number): DataClient {
  let left = failures;
  return {
    rpc: (fn, args) => client.rpc(fn, args) as unknown as PromiseLike<{ data: unknown; error: unknown }>,
    storage: {
      from: (bucket) => ({
        remove: async (paths) => {
          if (left > 0) {
            left -= 1;
            return { data: null, error: { code: "storage_down" } };
          }
          return client.storage.from(bucket).remove(paths);
        },
      }),
    },
  };
}

describe.skipIf(!live)("lead-tester S11 on real local Supabase", () => {
  let e: ReturnType<typeof env>;
  let admin: SupabaseClient;
  const users: User[] = [];

  async function makeUser(tag: string): Promise<User> {
    const email = `le-test-t11${tag}-${randomUUID().slice(0, 6)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    const client = createClient(e.url, e.anon, opts);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
    const u = { id: data.user.id, email, client, token: signIn.data.session!.access_token };
    users.push(u);
    return u;
  }

  /** A source with a file, an extraction with raw output and two items per thread title given, plus one pending proposal. */
  async function seedSource(u: User, marker: string, titles: string[]) {
    const path = `${u.id}/${randomUUID()}`;
    const up = await u.client.storage.from("sources").upload(path, new Blob([`File ${marker}.`]), { contentType: "text/plain" });
    if (up.error) throw up.error;
    const lines = [...titles, "pending"].map((t) => `${marker} ${t} line.`);
    const text = lines.join("\n");
    const src = await admin
      .from("sources")
      .insert({ user_id: u.id, kind: "upload", title: `${marker} title`, text_content: text, storage_path: path, reference_date: "2026-10-20", reference_date_source: "user" })
      .select("id")
      .single();
    if (src.error) throw src.error;
    const ex = await admin
      .from("extractions")
      .insert({
        user_id: u.id,
        source_id: src.data.id,
        status: "succeeded",
        model: "fake:recorded",
        prompt_version: "extract.v1",
        schema_version: "extraction.v1",
        raw_output: { source_summary: marker, participants: [], items: lines.map((l) => ({ title: l, evidence: [{ quote: l }] })), brief: null },
      })
      .select("id")
      .single();
    if (ex.error) throw ex.error;
    const threads: string[] = [];
    for (const [i, t] of [...titles, null].entries()) {
      const quote = lines[i]!;
      let threadId: string | null = null;
      if (t) {
        const thr = await admin.from("threads").insert({ user_id: u.id, title: `${marker} ${t}`, kind: "decision", status: "open", primary_source_id: src.data.id }).select("id").single();
        if (thr.error) throw thr.error;
        threadId = thr.data.id as string;
        threads.push(threadId);
      }
      const item = await admin
        .from("extraction_items")
        .insert({
          user_id: u.id,
          extraction_id: ex.data.id,
          item_index: i,
          band: "high",
          confidence: 0.9,
          review_status: t ? "accepted" : "pending",
          thread_id: threadId,
          suppression_hash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
          payload: { item: { type: "decision", title: quote }, label: { word: "Likely", reason: "synthetic" } },
        })
        .select("id")
        .single();
      if (item.error) throw item.error;
      const start = text.indexOf(quote);
      const ev = await admin.from("evidence").insert({
        user_id: u.id,
        source_id: src.data.id,
        thread_id: threadId,
        extraction_item_id: item.data.id,
        quote,
        start_offset: start,
        end_offset: start + quote.length,
        match_kind: "exact",
      });
      if (ev.error) throw ev.error;
      if (threadId) {
        const r = await u.client.rpc("thread_resolve", {
          p_thread_id: threadId,
          p_from_status: "open",
          p_resolution: "decided",
          p_choice: `${marker} choice`,
          p_reason: `${marker} reason`,
          p_now: nowIso(),
        });
        if (r.error || !r.data?.ok) throw new Error(`resolve failed: ${JSON.stringify(r.error ?? r.data)}`);
      }
    }
    return { sourceId: src.data.id as string, extractionId: ex.data.id as string, threads, path };
  }

  const fileExists = async (path: string) => {
    const slash = path.lastIndexOf("/");
    const { data, error } = await admin.storage.from("sources").list(path.slice(0, slash), { search: path.slice(slash + 1) });
    if (error) throw error;
    return (data ?? []).some((o) => o.name === path.slice(slash + 1));
  };
  const count = async (table: string, column: string, value: string) => (await admin.from(table).select("*", { count: "exact", head: true }).eq(column, value)).count ?? 0;
  const threadRows = async (id: string) => ({
    threads: await count("threads", "id", id),
    evidence: await count("evidence", "thread_id", id),
    events: await count("thread_events", "thread_id", id),
    decisions: await count("decisions", "thread_id", id),
    items: await count("extraction_items", "thread_id", id),
  });
  const GONE = { threads: 0, evidence: 0, events: 0, decisions: 0, items: 0 };

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

  describe("Forget permanently", () => {
    it("hard-deletes thread, evidence, events, decision, its proposal; keeps source, sibling thread and only a hash", async () => {
      const A = await makeUser("fa");
      const m = `Fgt${randomUUID().slice(0, 8)}`;
      const s = await seedSource(A, m, ["one", "two"]);
      const [t1, t2] = s.threads as [string, string];
      expect((await threadRows(t1)).decisions).toBe(1);
      expect((await threadRows(t1)).events).toBeGreaterThan(0);
      current.client = A.client;
      expect(await forgetAction(t1, false)).toEqual({ ok: true });
      expect(await threadRows(t1)).toEqual(GONE);
      expect((await threadRows(t2)).threads).toBe(1);
      expect(await count("sources", "id", s.sourceId)).toBe(1);
      expect(await fileExists(s.path)).toBe(true);
      const supp = (await admin.from("suppressions").select("reason, thread_id").eq("user_id", A.id)).data;
      expect(supp).toEqual([{ reason: "forgotten", thread_id: null }]);
      const ex = (await admin.from("extractions").select("raw_output").eq("id", s.extractionId).single()).data as { raw_output: { items: unknown[] } };
      expect(ex.raw_output.items[0]).toBeNull();
      expect(JSON.stringify(ex.raw_output.items)).not.toContain(`${m} one`);
      // F9: "leaves no rows referencing the thread", in any column of any table.
      if (DB) expect(dumpHas(t1)).toEqual([]);
    });

    it("Also delete source: sibling thread survives with its quote and a null source; the file is gone; no decision of the forgotten thread stays", async () => {
      const A = await makeUser("fb");
      const m = `Fgs${randomUUID().slice(0, 8)}`;
      const s = await seedSource(A, m, ["one", "two"]);
      const [t1, t2] = s.threads as [string, string];
      current.client = A.client;
      expect(await forgetAction(t1, true)).toEqual({ ok: true });
      expect(await threadRows(t1)).toEqual(GONE);
      expect(await count("sources", "id", s.sourceId)).toBe(0);
      expect(await count("extractions", "source_id", s.sourceId)).toBe(0);
      expect(await fileExists(s.path)).toBe(false);
      const ev = (await admin.from("evidence").select("source_id, quote").eq("thread_id", t2)).data;
      expect(ev).toEqual([{ source_id: null, quote: `${m} two line.` }]);
      expect((await admin.from("threads").select("primary_source_id").eq("id", t2).single()).data).toEqual({ primary_source_id: null });
    });

    // OPEN DEFECT S11-D5 (low): the hash lives only on extraction_items, which Delete source only removes.
    it.fails("the dialog's promise holds after Delete source only: forgetting the surviving thread still leaves its one-way hash", async () => {
      const A = await makeUser("fd");
      const s = await seedSource(A, `Fgh${randomUUID().slice(0, 8)}`, ["one"]);
      current.client = A.client;
      expect(await deleteSourceAction(s.sourceId, false)).toMatchObject({ ok: true });
      expect(await forgetAction(s.threads[0]!, false)).toEqual({ ok: true });
      expect(await threadRows(s.threads[0]!)).toEqual(GONE);
      expect(await count("suppressions", "user_id", A.id)).toBe(1);
    });

    it("the file is removed even though another of the user's queue entries was left by an earlier failure", async () => {
      const A = await makeUser("fc");
      const m = `Fgq${randomUUID().slice(0, 8)}`;
      const s1 = await seedSource(A, m, ["one"]);
      const s2 = await seedSource(A, m, ["two"]);
      expect((await deleteSource(failingStorage(A.client, 1), s1.sourceId, false, () => undefined)).ok).toBe(false);
      expect(await fileExists(s1.path)).toBe(true);
      current.client = A.client;
      expect(await forgetAction(s2.threads[0]!, true)).toEqual({ ok: true });
      expect(await fileExists(s1.path)).toBe(false);
      expect(await fileExists(s2.path)).toBe(false);
    });
  });

  describe("delete_source", () => {
    it("everything: all its threads are forgotten, an unrelated source and thread stay, hashes only remain", async () => {
      const A = await makeUser("da");
      const m = `Dse${randomUUID().slice(0, 8)}`;
      const keep = `Keep${randomUUID().slice(0, 8)}`;
      const s = await seedSource(A, m, ["one", "two", "three"]);
      const other = await seedSource(A, keep, ["four"]);
      current.client = A.client;
      expect(await deleteSourceAction(s.sourceId, true)).toEqual({ ok: true, threadsForgotten: 3 });
      for (const t of s.threads) expect(await threadRows(t)).toEqual(GONE);
      expect(await count("sources", "id", s.sourceId)).toBe(0);
      expect(await count("extractions", "source_id", s.sourceId)).toBe(0);
      expect(await count("evidence", "source_id", s.sourceId)).toBe(0);
      expect(await fileExists(s.path)).toBe(false);
      expect((await threadRows(other.threads[0]!)).threads).toBe(1);
      expect(await fileExists(other.path)).toBe(true);
      expect(await count("suppressions", "user_id", A.id)).toBe(3);
      if (DB) {
        expect(onDisk(s.path)).toBe(false);
        expect(onDisk(other.path)).toBe(true);
        expect(dumpHas(m)).toEqual([]);
        expect(psql(`select count(*) from private.storage_deletions where user_id='${A.id}'`)).toBe("0");
      }
    });

    it("source only: pending proposal and its evidence go, accepted thread + decision + quote stay, source text gone", async () => {
      const A = await makeUser("db");
      const m = `Dso${randomUUID().slice(0, 8)}`;
      const s = await seedSource(A, m, ["one"]);
      const t = s.threads[0]!;
      current.client = A.client;
      expect(await deleteSourceAction(s.sourceId, false)).toEqual({ ok: true, threadsForgotten: 0 });
      expect(await count("sources", "id", s.sourceId)).toBe(0);
      expect(await count("extractions", "source_id", s.sourceId)).toBe(0);
      expect(await count("extraction_items", "user_id", A.id)).toBe(0);
      expect(await fileExists(s.path)).toBe(false);
      const rows = await threadRows(t);
      expect(rows).toMatchObject({ threads: 1, decisions: 1, evidence: 1 });
      expect(rows.events).toBeGreaterThan(0);
      expect((await admin.from("evidence").select("quote, source_id").eq("user_id", A.id)).data).toEqual([{ quote: `${m} one line.`, source_id: null }]);
      if (DB) {
        const left = dumpHas(`${m} pending`);
        expect(left).toEqual([]);
      }
    });

    it("a thread that only quotes the source (other primary) counts as coming from it; another source's file stays", async () => {
      const A = await makeUser("dc");
      const m = `Dsc${randomUUID().slice(0, 8)}`;
      const s1 = await seedSource(A, m, ["one"]);
      const s2 = await seedSource(A, m, ["two"]);
      const quote = `${m} pending line.`;
      const text = (await admin.from("sources").select("text_content").eq("id", s1.sourceId).single()).data!.text_content as string;
      const ins = await admin.from("evidence").insert({ user_id: A.id, source_id: s1.sourceId, thread_id: s2.threads[0], quote, start_offset: text.indexOf(quote), end_offset: text.indexOf(quote) + quote.length, match_kind: "exact" });
      expect(ins.error).toBeNull();
      current.client = A.client;
      expect(await deleteSourceAction(s1.sourceId, true)).toEqual({ ok: true, threadsForgotten: 2 });
      expect(await threadRows(s2.threads[0]!)).toEqual(GONE);
      expect(await count("sources", "id", s2.sourceId)).toBe(1);
      expect(await fileExists(s2.path)).toBe(true);
    });

    it("a source with no file succeeds and queues nothing", async () => {
      const A = await makeUser("dd");
      const src = await admin.from("sources").insert({ user_id: A.id, kind: "paste", title: null, text_content: "Plain paste.", reference_date: "2026-10-20", reference_date_source: "user" }).select("id").single();
      const r = await A.client.rpc("delete_source", { p_source_id: src.data!.id, p_everything: false });
      expect(r.data).toMatchObject({ ok: true, threads_forgotten: 0, file_queued: false });
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([]);
    });

    it("a direct DELETE on the owner's source also queues the file (the trigger, whoever deletes)", async () => {
      const A = await makeUser("de");
      const s = await seedSource(A, `Dsd${randomUUID().slice(0, 8)}`, []);
      const del = await A.client.from("sources").delete().eq("id", s.sourceId).select("id");
      expect(del.error).toBeNull();
      expect(del.data).toHaveLength(1);
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([s.path]);
    });

    it("rejects a null option and non-uuid input", async () => {
      const A = await makeUser("df");
      const s = await seedSource(A, `Dsn${randomUUID().slice(0, 8)}`, []);
      const r = await A.client.rpc("delete_source", { p_source_id: s.sourceId, p_everything: null });
      expect(r.error?.code).toBe("22023");
      expect(await count("sources", "id", s.sourceId)).toBe(1);
      current.client = A.client;
      expect(await deleteSourceAction("not-a-uuid", true)).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(await deleteSourceAction(s.sourceId, "true")).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(await count("sources", "id", s.sourceId)).toBe(1);
    });
  });

  describe("queue and rule 10", () => {
    it("Storage failure: not reported as success; the path stays queued; rows are already gone", async () => {
      const A = await makeUser("qa");
      const s = await seedSource(A, `Qaa${randomUUID().slice(0, 8)}`, []);
      const res = await deleteSource(failingStorage(A.client, 1), s.sourceId, false, () => undefined);
      expect(res).toMatchObject({ ok: false, code: "save_failed" });
      expect(await count("sources", "id", s.sourceId)).toBe(0);
      expect(await fileExists(s.path)).toBe(true);
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([s.path]);
    });

    it("forget also reports failure while its file is queued", async () => {
      const A = await makeUser("qb");
      const s = await seedSource(A, `Qab${randomUUID().slice(0, 8)}`, ["one"]);
      const res = await forgetThread(failingStorage(A.client, 1), s.threads[0]!, true, () => undefined);
      expect(res).toMatchObject({ ok: false, code: "save_failed" });
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([s.path]);
    });

    it("settle never clears an entry while the file exists, and clears it once it is gone", async () => {
      const A = await makeUser("qc");
      const s = await seedSource(A, `Qac${randomUUID().slice(0, 8)}`, []);
      await deleteSource(failingStorage(A.client, 1), s.sourceId, false, () => undefined);
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([s.path]);
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([s.path]);
      expect((await A.client.storage.from("sources").remove([s.path])).error).toBeNull();
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([]);
    });

    // OPEN DEFECT S11-D2: the file goes, but the retry returns not_found, so the dialog stays open with an error.
    it.fails("Try again after a Storage failure removes the file AND reports success (data.ts promises the retry completes)", async () => {
      const A = await makeUser("qd");
      const s = await seedSource(A, `Qad${randomUUID().slice(0, 8)}`, []);
      expect((await deleteSource(failingStorage(A.client, 1), s.sourceId, true, () => undefined)).ok).toBe(false);
      current.client = A.client;
      const retry = await deleteSourceAction(s.sourceId, true);
      expect(await fileExists(s.path)).toBe(false);
      expect(retry).toMatchObject({ ok: true });
    });

    // OPEN DEFECT S11-D1 (rule 8, rule 10): forgetThread returns not_found on P0002 before it finishes the
    // queue, so the retry leaves the file in Storage while the UI moves on to Threads with no error.
    it.fails("Try again after a Forget's Storage failure removes the file", async () => {
      const A = await makeUser("qf");
      const s = await seedSource(A, `Qaf${randomUUID().slice(0, 8)}`, ["one"]);
      expect((await forgetThread(failingStorage(A.client, 1), s.threads[0]!, true, () => undefined)).ok).toBe(false);
      current.client = A.client;
      await forgetAction(s.threads[0]!, true);
      expect(await fileExists(s.path)).toBe(false);
    });

    it("no row deleted by a failed attempt shows up in the export", async () => {
      const A = await makeUser("qg");
      const m = `Qag${randomUUID().slice(0, 8)}`;
      const s = await seedSource(A, m, ["one"]);
      await deleteSource(failingStorage(A.client, 1), s.sourceId, true, () => undefined);
      current.client = A.client;
      const body = await (await exportRoute()).text();
      expect(body).not.toContain(m);
    });

    // OPEN DEFECT S11-D3 (rule 8): the migration says cron/daily finishes queued files. There is no cron
    // route, and the service role has no usage on schema private, so nothing but the user's next delete does.
    it.runIf(DB).fails("the queue has an owner-independent finisher: the service role can reach it (the migration promises cron/daily)", async () => {
      const can = psql(`select has_schema_privilege('service_role','private','usage') and has_table_privilege('service_role','private.storage_deletions','select')`);
      expect(can).toBe("t");
    });
  });

  describe("cross-user", () => {
    it("B calling the RPCs on A's rows changes nothing and learns nothing", async () => {
      const A = await makeUser("xa");
      const B = await makeUser("xb");
      const s = await seedSource(A, `Xaa${randomUUID().slice(0, 8)}`, ["one"]);
      const d = await B.client.rpc("delete_source", { p_source_id: s.sourceId, p_everything: true });
      expect(d.data).toEqual({ ok: false, error: "not_found" });
      const missing = await B.client.rpc("delete_source", { p_source_id: randomUUID(), p_everything: true });
      expect(missing.data).toEqual(d.data);
      const f = await B.client.rpc("forget_thread", { p_thread_id: s.threads[0], p_delete_source: true });
      expect(f.error?.code).toBe("P0002");
      expect(await count("sources", "id", s.sourceId)).toBe(1);
      expect((await threadRows(s.threads[0]!)).threads).toBe(1);
      expect(await fileExists(s.path)).toBe(true);
    });

    it("B's settle neither lists nor clears A's queue; B cannot read the private queue", async () => {
      const A = await makeUser("xc");
      const B = await makeUser("xd");
      const s = await seedSource(A, `Xac${randomUUID().slice(0, 8)}`, []);
      await deleteSource(failingStorage(A.client, 1), s.sourceId, false, () => undefined);
      expect((await B.client.rpc("storage_deletions_settle")).data).toEqual([]);
      expect((await A.client.rpc("storage_deletions_settle")).data).toEqual([s.path]);
      const direct = await B.client.schema("private").from("storage_deletions").select("*");
      expect(direct.error).not.toBeNull();
      const helper = await B.client.schema("private").rpc("source_thread_ids", { p_source_id: s.sourceId, p_uid: A.id });
      expect(helper.error).not.toBeNull();
    });

    it("anon cannot run the new functions or read any user table's rows", async () => {
      const A = await makeUser("xe");
      const s = await seedSource(A, `Xae${randomUUID().slice(0, 8)}`, ["one"]);
      const anon = createClient(e.url, e.anon, opts);
      expect((await anon.rpc("delete_source", { p_source_id: s.sourceId, p_everything: true })).error?.code).toBe("42501");
      expect((await anon.rpc("storage_deletions_settle")).error?.code).toBe("42501");
      expect((await anon.rpc("forget_thread", { p_thread_id: s.threads[0], p_delete_source: true })).error?.code).toBe("42501");
      expect(await count("sources", "id", s.sourceId)).toBe(1);
    });

    it("the service role has no auth.uid(): the functions refuse rather than act on nobody's behalf", async () => {
      const A = await makeUser("xf");
      const s = await seedSource(A, `Xaf${randomUUID().slice(0, 8)}`, []);
      expect((await admin.rpc("delete_source", { p_source_id: s.sourceId, p_everything: true })).error?.message).toMatch(/not authenticated/);
      expect((await admin.rpc("storage_deletions_settle")).error?.message).toMatch(/not authenticated/);
      expect(await count("sources", "id", s.sourceId)).toBe(1);
    });

    it("B's direct DELETE of A's source affects no row; B's Storage remove of A's file (queued or not) does nothing", async () => {
      const A = await makeUser("xg");
      const B = await makeUser("xh");
      const s = await seedSource(A, `Xag${randomUUID().slice(0, 8)}`, []);
      const del = await B.client.from("sources").delete().eq("id", s.sourceId).select("id");
      expect(del.data ?? []).toEqual([]);
      expect(await count("sources", "id", s.sourceId)).toBe(1);
      await deleteSource(failingStorage(A.client, 1), s.sourceId, false, () => undefined);
      await B.client.storage.from("sources").remove([s.path]);
      expect(await fileExists(s.path)).toBe(true);
    });
  });

  describe("export", () => {
    it("EXPORT_TABLES equals every table in public with an owner, per the catalog", async () => {
      if (!DB) return;
      const tables = psql(`select string_agg(c.relname, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`);
      expect(tables.split(",")).toEqual(EXPORT_TABLES.map((t) => t.table).sort());
      expect(EXPORT_TABLES).toHaveLength(11);
    });

    it("A's file has all 11 tables with A's rows only, by row owner and by scanning for B's id, email and marker", async () => {
      const A = await makeUser("ea");
      const B = await makeUser("eb");
      const ma = `Exa${randomUUID().slice(0, 8)}`;
      const mb = `Exb${randomUUID().slice(0, 8)}`;
      await seedSource(A, ma, ["one"]);
      const sb = await seedSource(B, mb, ["two"]);
      await B.client.rpc("forget_thread", { p_thread_id: sb.threads[0], p_delete_source: false });
      await admin.from("usage_counters").insert([
        { user_id: A.id, day: "2026-10-20", extractions: 1, asks: 0 },
        { user_id: B.id, day: "2026-10-20", extractions: 2, asks: 0 },
      ]);
      current.client = A.client;
      const res = await exportRoute();
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const text = await res.text();
      const body = JSON.parse(text) as { user_id: string; tables: Record<string, Array<Record<string, unknown>>> };
      expect(Object.keys(body.tables).sort()).toEqual(EXPORT_TABLES.map((t) => t.table).sort());
      for (const { table, owner } of EXPORT_TABLES) {
        expect(body.tables[table]!.length, table).toBe(await count(table, owner, A.id));
        for (const row of body.tables[table]!) expect(row[owner], table).toBe(A.id);
      }
      expect(body.tables.decisions).toHaveLength(1);
      expect(body.tables.usage_counters).toHaveLength(1);
      expect(text).toContain(ma);
      expect(text).not.toContain(B.id);
      expect(text).not.toContain(B.email);
      expect(text).not.toContain(mb);
    });

    it("pages past 1,000 rows and returns each row exactly once", async () => {
      const A = await makeUser("ec");
      const s = await seedSource(A, `Exc${randomUUID().slice(0, 8)}`, ["one"]);
      const t = s.threads[0]!;
      const before = await count("thread_events", "user_id", A.id);
      for (let i = 0; i < 3; i++) {
        const batch = Array.from({ length: 500 }, (_, n) => ({ user_id: A.id, thread_id: t, actor: "user", type: "edited", after: { n: i * 500 + n } }));
        const ins = await admin.from("thread_events").insert(batch);
        expect(ins.error).toBeNull();
      }
      current.client = A.client;
      const body = (await (await exportRoute()).json()) as { tables: { thread_events: Array<{ id: number }> } };
      expect(body.tables.thread_events).toHaveLength(before + 1500);
      expect(new Set(body.tables.thread_events.map((r) => r.id)).size).toBe(before + 1500);
    });

    it("signed out gets the 401 error shape and no data", async () => {
      current.client = createClient(e.url, e.anon, opts);
      const res = await exportRoute();
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue.", retryable: false } });
    });
  });

  describe("delete account", () => {
    it("server refuses anything but the word; signed out refused", async () => {
      const A = await makeUser("aa");
      current.client = A.client;
      for (const bad of ["", "delet", "delete now", "yes", null, undefined, 1, {}, ["delete"]]) {
        expect(await deleteAccountAction(bad), String(bad)).toMatchObject({ ok: false, field: "confirm" });
      }
      expect(await count("profiles", "id", A.id)).toBe(1);
      current.client = createClient(e.url, e.anon, opts);
      expect(await deleteAccountAction("delete")).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
      expect(await count("profiles", "id", A.id)).toBe(1);
    });

    it("removes every row, every file, auth.users, sessions and identities; B is untouched; nothing with the marker remains", async () => {
      const A = await makeUser("ab");
      const B = await makeUser("ac");
      const m = `Acc${randomUUID().slice(0, 8)}`;
      const s = await seedSource(A, m, ["one", "two"]);
      const stuck = await seedSource(A, m, []);
      await deleteSource(failingStorage(A.client, 1), stuck.sourceId, false, () => undefined);
      expect(await fileExists(stuck.path)).toBe(true);
      await admin.from("usage_counters").insert({ user_id: A.id, day: "2026-10-20", extractions: 1, asks: 1 });
      await A.client.rpc("forget_thread", { p_thread_id: s.threads[1], p_delete_source: false });
      const keep = await seedSource(B, `AccB${randomUUID().slice(0, 8)}`, ["three"]);

      current.client = A.client;
      expect(await deleteAccountAction("delete")).toEqual({ ok: true });

      for (const { table, owner } of EXPORT_TABLES) expect(await count(table, owner, A.id), table).toBe(0);
      expect((await admin.storage.from("sources").list(A.id)).data ?? []).toEqual([]);
      expect(await fileExists(s.path)).toBe(false);
      expect(await fileExists(stuck.path)).toBe(false);
      expect((await admin.auth.admin.getUserById(A.id)).data.user).toBeNull();
      expect((await threadRows(keep.threads[0]!)).threads).toBe(1);
      expect(await fileExists(keep.path)).toBe(true);
      if (DB) {
        expect(onDisk(s.path)).toBe(false);
        expect(onDisk(stuck.path)).toBe(false);
        expect(onDisk(keep.path)).toBe(true);
        expect(dumpHas(m)).toEqual([]);
        expect(dumpHas(A.id, ["public", "private", "storage"])).toEqual([]);
        expect(psql(`select count(*) from auth.users where id='${A.id}'`)).toBe("0");
        expect(psql(`select count(*) from auth.identities where user_id='${A.id}'`)).toBe("0");
        expect(psql(`select count(*) from auth.sessions where user_id='${A.id}'`)).toBe("0");
        expect(psql(`select count(*) from auth.refresh_tokens where user_id='${A.id}'`)).toBe("0");
        expect(psql(`select count(*) from auth.users where email='${A.email}'`)).toBe("0");
      }
    });

    it("a still-valid access token after deletion reads nothing and can store nothing", async () => {
      const A = await makeUser("ad");
      const s = await seedSource(A, `Ace${randomUUID().slice(0, 8)}`, []);
      const old = createClient(e.url, e.anon, { ...opts, global: { headers: { Authorization: `Bearer ${A.token}` } } });
      current.client = A.client;
      expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      expect((await old.from("sources").select("id")).data ?? []).toEqual([]);
      expect((await old.rpc("delete_source", { p_source_id: s.sourceId, p_everything: true })).data).toEqual({ ok: false, error: "not_found" });
      const up = await old.storage.from("sources").upload(`${A.id}/${randomUUID()}`, new Blob(["late"]), { contentType: "text/plain" });
      expect(up.error).not.toBeNull();
      expect((await admin.storage.from("sources").list(A.id)).data ?? []).toEqual([]);
    });

    it("the user's deletion retried after it already succeeded does not fail or touch anyone else", async () => {
      const A = await makeUser("ae");
      current.client = A.client;
      expect(await deleteAccountAction("delete")).toEqual({ ok: true });
      const again = await deleteAccountAction("delete");
      expect(again).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    });
  });
});
