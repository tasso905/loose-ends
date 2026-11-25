/**
 * Lead-tester: deleteAccountAction's `renderedFor` on REAL local Supabase. The id is only compared with
 * the session: no value but the session's own gets past the session check, and none can name
 * another account. Needs LE_SUPABASE_LIVE=1 and the LE_SUPABASE_* variables of an isolated stack.
 */
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
const jar = vi.hoisted(() => [] as unknown[]);
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void Promise.resolve().then(fn) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (...x: unknown[]) => void jar.push(x), get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("@/lib/analytics/track", () => ({ track: () => {}, createTracker: () => ({ track: () => {} }) }));
import { deleteAccountAction } from "@/app/settings/data-actions";

const live = process.env.LE_SUPABASE_LIVE === "1" && Boolean(process.env.LE_SUPABASE_URL);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

describe.skipIf(!live)("tester: Delete account from a page rendered for someone else", () => {
  let admin: SupabaseClient;
  const ids: string[] = [];
  const saved = { ...process.env };
  async function user() {
    const email = `le-test-stale-${randomUUID().slice(0, 8)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    const client = createClient(process.env.LE_SUPABASE_URL!, process.env.LE_SUPABASE_ANON_KEY!, opts);
    await client.auth.signInWithPassword({ email, password });
    ids.push(data.user!.id);
    return { id: data.user!.id, client };
  }
  const exists = async (id: string) => Boolean((await admin.auth.admin.getUserById(id)).data.user);

  beforeAll(() => {
    Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: process.env.LE_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.LE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: process.env.LE_SUPABASE_SERVICE_ROLE_KEY });
    admin = createClient(process.env.LE_SUPABASE_URL!, process.env.LE_SUPABASE_SERVICE_ROLE_KEY!, opts);
  });
  afterAll(async () => {
    for (const id of ids) await admin.auth.admin.deleteUser(id).catch(() => undefined);
    process.env = saved;
  });

  it("every wrong id: the only request made is the session check; no service-role request, cookie or sign-out", async () => {
    const [a, b] = [await user(), await user()];
    current.client = b.client;
    jar.length = 0;
    const values: unknown[] = [a.id, undefined, null, "", " ", "junk", 0, 1, true, NaN, [], [b.id], [a.id, b.id], {}, { id: b.id }, { toString: () => b.id }, new String(b.id), Symbol.iterator, b.id.toUpperCase(), `${b.id} `, `${b.id}\n`, "00000000-0000-0000-0000-000000000000"];
    const fetched = vi.spyOn(globalThis, "fetch");
    for (const v of values) {
      expect(await deleteAccountAction("delete", v), String(v)).toEqual({ ok: false, error: { code: "unauthenticated", message: "Sign in to continue.", retryable: false } });
    }
    expect(await (deleteAccountAction as (c: unknown) => Promise<unknown>)("delete")).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    const calls = fetched.mock.calls.map(([u, i]) => ({ path: new URL(u instanceof Request ? u.url : String(u)).pathname, auth: new Headers(i?.headers).get("authorization") ?? "" }));
    fetched.mockRestore();
    expect(calls).toHaveLength(values.length + 1);
    for (const x of calls) {
      expect(x.path).toBe("/auth/v1/user");
      expect(x.auth).not.toContain(process.env.SUPABASE_SERVICE_ROLE_KEY!);
    }
    expect(jar).toEqual([]);
    expect([await exists(a.id), await exists(b.id)]).toEqual([true, true]);
    expect((await b.client.auth.getUser()).data.user?.id).toBe(b.id);
  });

  it("the right id without the word is refused; with it, the session's user goes and no one else", async () => {
    const [a, b] = [await user(), await user()];
    current.client = b.client;
    for (const w of ["", "delet", "yes", null, undefined, ["delete"], b.id]) expect(await deleteAccountAction(w, b.id)).toMatchObject({ ok: false, field: "confirm" });
    expect(await exists(b.id)).toBe(true);
    expect(await deleteAccountAction("delete", b.id)).toEqual({ ok: true });
    expect([await exists(a.id), await exists(b.id)]).toEqual([true, false]);
    // A's session naming the deleted B: refused, A stays.
    current.client = a.client;
    expect(await deleteAccountAction("delete", b.id)).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(await exists(a.id)).toBe(true);
  });
});
