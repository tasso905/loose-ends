/**
 * Lead-tester S6 (F3 upload) checks of the REAL server action `submitUpload` against REAL local
 * Supabase (Auth, Storage with RLS, PostgREST, definer functions). Skipped unless LE_SUPABASE_LIVE=1
 * (`pnpm test:supabase`). The user-scoped server client is replaced by a supabase-js client signed
 * in as a throwaway user (le-test-*@example.com), so storage RLS and RLS apply exactly as in the app.
 * `after()` is captured and never run (no model call at all). Synthetic files only. Never resets the
 * database.
 *
 * `it.fails` pins a defect: it asserts the SAFE behaviour and currently fails. When fixed it turns
 * red and must be flipped to `it`.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renewalPdf, scannedPdf } from "../fixtures/documents";
import { docxLike, encryptedPdf, pagesPdf } from "../fixtures/tester-documents";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
const afterCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("next/server", () => ({ after: () => void afterCalls.n++ }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("@/lib/analytics/track", () => ({
  track: () => {},
  createTracker: () => ({ track: () => {}, trackAwaited: async () => "disabled" }),
}));

import { submitUpload } from "@/app/add/actions";

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

describe.skipIf(!live)("tester: submitUpload on real local Supabase", () => {
  let e: ReturnType<typeof env>;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  const users: Array<{ id: string; client: SupabaseClient }> = [];
  let A: { id: string; client: SupabaseClient };
  let B: { id: string; client: SupabaseClient };

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

  const files = async (uid: string) => ((await admin.storage.from("sources").list(uid, { limit: 1000 })).data ?? []).map((o) => o.name);
  const rows = async (table: string, uid: string) =>
    (await admin.from(table).select("*", { count: "exact", head: true }).eq("user_id", uid)).count ?? 0;
  const usage = async (uid: string) =>
    ((await admin.from("usage_counters").select("extractions").eq("user_id", uid)).data ?? []).reduce((n, r) => n + (r.extractions as number), 0);

  async function upload(u: { id: string; client: SupabaseClient }, bytes: Uint8Array, id = randomUUID()) {
    const up = await u.client.storage.from("sources").upload(`${u.id}/${id}`, new Blob([new Uint8Array(bytes)]), {
      contentType: "application/octet-stream",
      upsert: false,
    });
    if (up.error) throw new Error(`upload: ${up.error.message}`);
    return id;
  }

  function form(sourceId: string, fileName: string, extra: Record<string, string> = {}) {
    const f = new FormData();
    f.set("source_id", sourceId);
    f.set("file_name", fileName);
    f.set("written_on", "2026-10-05");
    f.set("written_on_set", "1");
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  }

  async function as<T>(u: { client: SupabaseClient }, fn: () => Promise<T>) {
    current.client = u.client;
    return fn();
  }

  beforeAll(async () => {
    e = env();
    process.env.NEXT_PUBLIC_SUPABASE_URL = e.url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = e.anon;
    admin = createClient(e.url, e.service, opts);
    anon = createClient(e.url, e.anon, opts);
    A = await makeUser("upA");
    B = await makeUser("upB");
  });

  beforeEach(async () => {
    // Each test starts from an empty folder, no rows and no usage for both users.
    for (const u of users) {
      const names = await files(u.id);
      if (names.length) await admin.storage.from("sources").remove(names.map((n) => `${u.id}/${n}`));
      await admin.from("sources").delete().eq("user_id", u.id);
      await admin.from("usage_counters").delete().eq("user_id", u.id);
    }
    afterCalls.n = 0;
  });

  afterAll(async () => {
    for (const { id } of users) {
      const names = await files(id);
      if (names.length) await admin.storage.from("sources").remove(names.map((n) => `${id}/${n}`));
      await admin.auth.admin.deleteUser(id);
    }
  });

  it("happy path: a text-layer PDF becomes one upload source + running extraction; file kept at {uid}/{source_id}; one usage", async () => {
    const id = await upload(A, renewalPdf());
    const res = await as(A, () => submitUpload(form(id, "Renewal notice.pdf")));
    expect(res.ok).toBe(true);
    const { data: src } = await admin.from("sources").select("id, kind, title, storage_path, mime_type").eq("user_id", A.id);
    expect(src).toEqual([{ id, kind: "upload", title: "Renewal notice", storage_path: `${A.id}/${id}`, mime_type: "application/pdf" }]);
    expect(await files(A.id)).toEqual([id]);
    expect(await usage(A.id)).toBe(1);
    expect(afterCalls.n).toBe(1);
  });

  it.each([
    ["scan", () => scannedPdf(), "scan.pdf", "unsupported_scan"],
    ["encrypted", () => encryptedPdf(), "locked.pdf", "unsupported_type"],
    ["docx", () => docxLike(), "letter.docx", "unsupported_type"],
    ["31 pages", () => pagesPdf(31), "terms.pdf", "too_many_pages"],
    ["binary named .pdf", () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), "photo.pdf", "unsupported_type"],
    ["over 30,000 characters", () => new TextEncoder().encode("word ".repeat(6_001)), "long.txt", "input_too_long"],
  ] as const)("refusal (%s): its code, file removed, no source/extraction rows, nothing counted, no pipeline", async (_n, make, name, code) => {
    const id = await upload(A, make());
    const res = await as(A, () => submitUpload(form(id, name)));
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe(code);
    expect(!res.ok && res.error.retryable).toBe(false);
    expect(await files(A.id)).toEqual([]);
    expect(await rows("sources", A.id)).toBe(0);
    expect(await rows("extractions", A.id)).toBe(0);
    expect(await usage(A.id)).toBe(0);
    expect(afterCalls.n).toBe(0);
  });

  it("a missing file (nothing uploaded): save_failed, no rows, nothing counted", async () => {
    const res = await as(A, () => submitUpload(form(randomUUID(), "ghost.pdf")));
    expect(!res.ok && res.error.code).toBe("save_failed");
    expect(await rows("sources", A.id)).toBe(0);
    expect(await usage(A.id)).toBe(0);
  });

  it("A submits B's source id: A's own folder is read (missing), B's file and rows untouched", async () => {
    const idB = await upload(B, renewalPdf());
    const res = await as(A, () => submitUpload(form(idB, "Renewal notice.pdf")));
    expect(!res.ok && res.error.code).toBe("save_failed");
    expect(await files(B.id)).toEqual([idB]);
    expect(await rows("sources", A.id)).toBe(0);
    expect(await usage(A.id)).toBe(0);
  });

  it("A calls start_upload_extraction directly with B's uploaded file id: refused, nothing written or counted", async () => {
    const idB = await upload(B, renewalPdf());
    const { data, error } = await A.client.rpc("start_upload_extraction", {
      p_source_id: idB,
      p_text: "Policy renewal notice for policy HM-000-TEST",
      p_title: null,
      p_reference_date: "2026-10-05",
      p_now: new Date().toISOString(),
      p_mime_type: "text/plain",
      p_page_offsets: null,
      p_model: "x",
      p_prompt_version: "x",
      p_schema_version: "x",
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("P0002");
    expect(await rows("sources", A.id)).toBe(0);
    expect(await rows("sources", B.id)).toBe(0);
    expect(await usage(A.id)).toBe(0);
  });

  it("anon cannot call start_upload_extraction", async () => {
    const { error } = await anon.rpc("start_upload_extraction", {
      p_source_id: randomUUID(), p_text: "x", p_title: null, p_reference_date: null, p_now: new Date().toISOString(),
      p_mime_type: "text/plain", p_page_offsets: null, p_model: "x", p_prompt_version: "x", p_schema_version: "x",
    });
    expect(error).not.toBeNull();
  });

  it("storage: uploads into another user's folder, the bucket root or via ../ traversal never land outside the caller's folder", async () => {
    const blob = () => new Blob(["synthetic"]);
    expect((await A.client.storage.from("sources").upload(`${B.id}/${randomUUID()}`, blob())).error).not.toBeNull();
    expect((await A.client.storage.from("sources").upload(`${randomUUID()}`, blob())).error).not.toBeNull();
    const trav = await A.client.storage.from("sources").upload(`${A.id}/../${B.id}/${randomUUID()}`, blob());
    expect(await files(B.id)).toEqual([]);
    // Whatever the server did with the name, nothing appeared in B's folder, and the bucket root holds
    // only user-id folders (other live suites may have their own users' folders there).
    const top = ((await admin.storage.from("sources").list("", { limit: 1000 })).data ?? []).map((o) => o.name);
    expect(top.filter((n) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(n))).toEqual([]);
    if (!trav.error) expect(trav.data?.path.startsWith(`${A.id}/`)).toBe(true);
    expect(trav.error, "../ traversal is refused outright").not.toBeNull();
  });

  it("storage: an uploaded source file cannot be overwritten (no update policy), so the stored text and file stay in step", async () => {
    const id = await upload(A, renewalPdf());
    expect((await as(A, () => submitUpload(form(id, "Renewal notice.pdf")))).ok).toBe(true);
    const over = await A.client.storage.from("sources").upload(`${A.id}/${id}`, new Blob(["replaced"]), { upsert: true });
    expect(over.error).not.toBeNull();
  });

  it("at the daily limit: rate_limited (copy names UTC), the file is removed, no rows", async () => {
    await admin.from("usage_counters").insert({ user_id: A.id, day: new Date().toISOString().slice(0, 10), extractions: 30 });
    const id = await upload(A, renewalPdf());
    const res = await as(A, () => submitUpload(form(id, "Renewal notice.pdf")));
    expect(!res.ok && res.error.code).toBe("rate_limited");
    expect(!res.ok && res.error.message).toMatch(/midnight \(UTC\)/);
    expect(await files(A.id)).toEqual([]);
    expect(await rows("sources", A.id)).toBe(0);
    expect(await usage(A.id)).toBe(30);
  });

  // DEFECT (rule 8 / data integrity): when start_upload_extraction fails, submitUpload removes the
  // object at {uid}/{source_id} unconditionally. If that id already belongs to an existing source
  // (a replayed or duplicated submit of the same source_id), the start fails on the primary key and
  // the EXISTING source's file is deleted, leaving a sources row whose storage_path points at nothing.
  // Safe behaviour: a failed start never removes a file that a source row owns.
  it("a repeated submit with an existing source id never deletes that source's file", async () => {
    const id = await upload(A, renewalPdf());
    expect((await as(A, () => submitUpload(form(id, "Renewal notice.pdf")))).ok).toBe(true);
    const again = await as(A, () => submitUpload(form(id, "Renewal notice.pdf")));
    expect(again.ok).toBe(false);
    expect(await rows("sources", A.id)).toBe(1);
    expect(await files(A.id)).toEqual([id]);
  });

  // Skipped by the lead developer when the fix landed (fix/upload-hardening): this test asserts the
  // defective behaviour (file gone) and the pin above now covers the safe behaviour.
  it.skip("evidence for the DEFECT above: after the repeated submit the source row remains but its file is gone", async () => {
    const id = await upload(A, renewalPdf());
    expect((await as(A, () => submitUpload(form(id, "Renewal notice.pdf")))).ok).toBe(true);
    await as(A, () => submitUpload(form(id, "Renewal notice.pdf")));
    const { data } = await admin.from("sources").select("storage_path").eq("id", id).single();
    expect(data?.storage_path).toBe(`${A.id}/${id}`);
    expect(await files(A.id)).toEqual([]);
  });

  it("bad form fields: a non-UUID source id (path traversal attempt) is refused before storage is touched", async () => {
    const id = await upload(A, renewalPdf());
    for (const bad of [`../${B.id}/x`, `${id}/../${id}`, "", "not-a-uuid"]) {
      const res = await as(A, () => submitUpload(form(bad, "x.pdf")));
      expect(!res.ok && res.error.code, bad).toBe("save_failed");
    }
    expect(await files(A.id)).toEqual([id]); // untouched
    expect(await rows("sources", A.id)).toBe(0);
  });

  it("signed out: unauthenticated, nothing read or written", async () => {
    const res = await as({ client: anon }, () => submitUpload(form(randomUUID(), "x.pdf")));
    expect(res).toMatchObject({ ok: false, signedOut: true, error: { code: "unauthenticated" } });
  });
});
