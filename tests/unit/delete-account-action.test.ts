import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const s = vi.hoisted(() => ({
  cookies: [] as Array<{ name: string; value: string }>,
  deleteArgs: [] as unknown[][],
  result: { ok: true, objectsRemoved: 0 } as unknown,
  events: [] as string[],
}));
const user = { id: "00000000-0000-4000-8000-000000000001", email: "a@example.com" };
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string) => void s.cookies.push({ name, value }) }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }), signOut: async () => ({ error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { analytics_enabled: false }, error: null }) }) }) }),
  }),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn(), createTracker: () => ({ track: (_u: string, name: string) => void s.events.push(name) }) }));
vi.mock("@/lib/account/deleteAccount", () => ({
  deleteAccount: async (...args: unknown[]) => {
    s.deleteArgs.push(args);
    return s.result;
  },
}));

import { deleteAccountAction } from "@/app/settings/data-actions";

/** What the sign-in page is told after account deletion: never more than happened (rules 9, 10). */
describe("deleteAccountAction: the notice", () => {
  beforeEach(() => {
    s.cookies.length = 0;
    s.deleteArgs.length = 0;
    s.events.length = 0;
  });

  it("passes the session's id and email, never anything from the request", async () => {
    s.result = { ok: true, objectsRemoved: 0 };
    await deleteAccountAction("delete");
    expect(s.deleteArgs[0]?.[1]).toBe(user.id);
    expect(s.deleteArgs[0]?.[2]).toEqual({ email: user.email });
  });

  it("everything gone: the full notice", async () => {
    s.result = { ok: true, objectsRemoved: 0 };
    expect(await deleteAccountAction("delete")).toEqual({ ok: true });
    expect(s.cookies).toEqual([{ name: "le_account_deleted", value: "1" }]);
  });

  it("account gone, sign-in records not: the notice that says so, and the deletion still counts", async () => {
    s.result = { ok: true, objectsRemoved: 0, signInRecordsRemain: true };
    expect(await deleteAccountAction("delete")).toEqual({ ok: true });
    expect(s.cookies).toEqual([{ name: "le_account_deleted", value: "2" }]);
    expect(s.events).toEqual(["account_deleted"]);
  });

  it("a failed deletion sets no notice", async () => {
    s.result = { ok: false, error: { code: "save_failed", message: "That didn't save. Try again.", retryable: true } };
    expect(await deleteAccountAction("delete")).toMatchObject({ ok: false, error: { code: "save_failed" } });
    expect(s.cookies).toEqual([]);
    expect(s.events).toEqual([]);
  });
});
