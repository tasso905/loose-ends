import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAccount, STORAGE_TIMEOUT_MS, type AccountAdminClient } from "@/lib/account/deleteAccount";

const UID = "00000000-0000-4000-8000-000000000001";

/** In-memory bucket: flat paths like `${UID}/a.txt` and `${UID}/sub/b.txt`. */
function fakeClient(
  files: string[],
  fail: {
    list?: boolean;
    remove?: boolean;
    removeNoop?: boolean;
    deleteUser?: boolean | "not_found" | "throws";
    getUser?: "exists" | "gone" | "error" | "throws";
    prepare?: boolean;
    purge?: "error" | "throws" | "left";
  } = {},
  onDeleteUser?: (store: Set<string>, fail: { list?: boolean }) => void,
) {
  const store = new Set(files);
  const calls: string[] = [];
  const rpcArgs: unknown[] = [];
  const deleteUser = vi.fn(async () => {
    calls.push("deleteUser");
    onDeleteUser?.(store, fail);
    if (fail.deleteUser === "throws") throw new Error("network");
    if (fail.deleteUser === "not_found") return { data: null, error: { message: "User not found", status: 404, code: "user_not_found" } };
    return { data: null, error: fail.deleteUser ? { message: "x" } : null };
  });
  const client: AccountAdminClient = {
    storage: {
      from: () => ({
        list: async (prefix, { limit, offset }) => {
          calls.push(`list:${prefix}:${offset}`);
          if (fail.list) return { data: null, error: { message: "x" } };
          const names = new Map<string, boolean>(); // name → isFolder
          for (const p of [...store].sort()) {
            if (!p.startsWith(`${prefix}/`)) continue;
            const rest = p.slice(prefix.length + 1);
            const [head, ...tail] = rest.split("/");
            names.set(head!, tail.length > 0 || names.get(head!) === true);
          }
          const all = [...names.entries()].map(([name, folder]) => ({ name, id: folder ? null : `id-${name}` }));
          return { data: all.slice(offset, offset + limit), error: null };
        },
        remove: async (paths) => {
          calls.push(`remove:${paths.length}`);
          if (fail.remove) return { data: null, error: { message: "x" } };
          if (!fail.removeNoop) for (const p of paths) store.delete(p);
          return { data: [], error: null };
        },
      }),
    },
    auth: {
      admin: {
        deleteUser,
        getUserById: async () => {
          calls.push("getUserById");
          if (fail.getUser === "throws") throw new Error("network");
          if (fail.getUser === "error") return { data: { user: null }, error: { message: "x", status: 500 } };
          if (fail.getUser === "gone") return { data: { user: null }, error: { message: "User not found", status: 404, code: "user_not_found" } };
          return { data: { user: { id: UID } }, error: null };
        },
      },
    },
    rpc: async (fn, args) => {
      calls.push(fn);
      rpcArgs.push(args);
      if (fn === "auth_audit_purge_prepare") return fail.prepare ? { data: null, error: { code: "42501" } } : { data: null, error: null };
      if (fn === "account_file_purge_clear") return { data: true, error: null };
      if (fail.purge === "throws") throw new Error("network");
      if (fail.purge === "error") return { data: null, error: { code: "XX000", message: "secret@example.com" } };
      return { data: { deleted: 3, remaining: fail.purge === "left" ? 2 : 0 }, error: null };
    },
  };
  return { client, store, calls, deleteUser, rpcArgs };
}

describe("deleteAccount(): Storage has to answer, then the auth user goes, then the files", () => {
  it("removes every object (paginated, with subfolders) and then deletes the user", async () => {
    const files = [...Array.from({ length: 5 }, (_, i) => `${UID}/f${i}.txt`), `${UID}/sub/x.pdf`, `${UID}/sub/y.pdf`];
    const f = fakeClient([...files, "someone-else/z.txt"]);
    const r = await deleteAccount(f.client, UID, { pageSize: 2 });
    expect(r).toEqual({ ok: true, objectsRemoved: 7 });
    expect([...f.store]).toEqual(["someone-else/z.txt"]);
    expect(f.calls.indexOf("deleteUser")).toBeLessThan(f.calls.findIndex((c) => c.startsWith("remove:")));
    expect(f.calls.filter((c) => c.startsWith(`list:${UID}:`)).length).toBeGreaterThan(2); // paginated
  });

  it("Storage not answering → retryable error, nothing deleted", async () => {
    const f = fakeClient([`${UID}/a.txt`], { list: true });
    const r = await deleteAccount(f.client, UID, { logger: vi.fn() });
    expect(r).toEqual({ ok: false, error: { code: "save_failed", message: "That didn't save. Try again.", retryable: true } });
    expect(f.deleteUser).not.toHaveBeenCalled();
    expect([...f.store]).toEqual([`${UID}/a.txt`]);
  });

  it.each([
    ["remove fails", { remove: true }],
    ["objects still there after remove", { removeNoop: true }],
  ])("%s after the user is gone → the result says files remain", async (_, fail) => {
    const f = fakeClient([`${UID}/a.txt`], fail);
    expect(await deleteAccount(f.client, UID, { logger: vi.fn() })).toEqual({ ok: true, objectsRemoved: 0, filesRemain: true });
    expect(f.deleteUser).toHaveBeenCalled();
    expect(f.calls).not.toContain("account_file_purge_clear");
  });

  it.each([
    ["an error", true],
    ["a throw", "throws"],
  ] as const)("S11-D6: deleteUser refused with %s and the user is still there → failure, every file stays, nothing purged", async (_, deleteUser) => {
    const f = fakeClient([`${UID}/a.txt`], { deleteUser, getUser: "exists" });
    const r = await deleteAccount(f.client, UID, { logger: vi.fn() });
    expect(r).toEqual({ ok: false, error: { code: "save_failed", message: "That didn't save. Try again.", retryable: true } });
    expect([...f.store]).toEqual([`${UID}/a.txt`]);
    expect(f.calls.some((c) => c.startsWith("remove:"))).toBe(false);
    expect(f.calls).not.toContain("auth_audit_purge");
  });

  it("deleteUser reports an error but the user is gone → carries on: files, purge, success", async () => {
    const f = fakeClient([`${UID}/a.txt`], { deleteUser: true, getUser: "gone" });
    expect(await deleteAccount(f.client, UID, { logger: vi.fn() })).toEqual({ ok: true, objectsRemoved: 1 });
    expect([...f.store]).toEqual([]);
    expect(f.calls).toContain("auth_audit_purge");
  });

  it.each(["error", "throws"] as const)("deleteUser errors and the check %s too → says it can't tell, deletes nothing more", async (getUser) => {
    const logger = vi.fn();
    const f = fakeClient([`${UID}/a.txt`], { deleteUser: true, getUser });
    const r = await deleteAccount(f.client, UID, { logger });
    expect(r).toEqual({ ok: false, error: { code: "save_failed", message: "I couldn't confirm whether your account was deleted. Try again in a few minutes.", retryable: true } });
    expect([...f.store]).toEqual([`${UID}/a.txt`]);
    expect(f.calls).not.toContain("auth_audit_purge");
    expect(logger).toHaveBeenCalledWith("account_delete_sweep_failed", { user_id: UID, step: "user_unconfirmed" });
  });

  describe("a hung Auth call hits the same limit as Storage", () => {
    const hang = () => new Promise<never>(() => undefined);
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    async function run(c: AccountAdminClient, logger = vi.fn()) {
      const p = deleteAccount(c, UID, { logger });
      await vi.advanceTimersByTimeAsync(STORAGE_TIMEOUT_MS * 3);
      return p;
    }
    const UNCONFIRMED = { ok: false, error: { code: "save_failed", message: "I couldn't confirm whether your account was deleted. Try again in a few minutes.", retryable: true } };

    it("deleteUser hangs and the check hangs: unconfirmed, within two limits, no file touched", async () => {
      const f = fakeClient([`${UID}/a.txt`]);
      f.client.auth.admin.deleteUser = hang;
      f.client.auth.admin.getUserById = hang;
      const t0 = Date.now();
      expect(await run(f.client)).toEqual(UNCONFIRMED);
      expect(Date.now() - t0).toBeLessThanOrEqual(STORAGE_TIMEOUT_MS * 3);
      expect([...f.store]).toEqual([`${UID}/a.txt`]);
      expect(f.calls).not.toContain("auth_audit_purge");
    });

    it("deleteUser hangs and the user is still there: unconfirmed, because the delete may still land", async () => {
      const f = fakeClient([`${UID}/a.txt`], { getUser: "exists" });
      f.client.auth.admin.deleteUser = hang;
      expect(await run(f.client)).toEqual(UNCONFIRMED);
      expect([...f.store]).toEqual([`${UID}/a.txt`]);
    });

    it("deleteUser hangs and the user is gone: carries on as a deletion", async () => {
      const f = fakeClient([`${UID}/a.txt`], { getUser: "gone" });
      f.client.auth.admin.deleteUser = hang;
      expect(await run(f.client)).toEqual({ ok: true, objectsRemoved: 1 });
    });

    it("deleteUser refuses and the check hangs: unconfirmed", async () => {
      const f = fakeClient([`${UID}/a.txt`], { deleteUser: true });
      f.client.auth.admin.getUserById = hang;
      expect(await run(f.client)).toEqual(UNCONFIRMED);
    });
  });

  it("deleteUser saying not found needs no check", async () => {
    const f = fakeClient([], { deleteUser: "not_found" });
    await deleteAccount(f.client, UID);
    expect(f.calls).not.toContain("getUserById");
  });

  it("refuses a user id that is not a UUID (no prefix tricks like '' or '../')", async () => {
    const f = fakeClient([`${UID}/a.txt`]);
    expect((await deleteAccount(f.client, "")).ok).toBe(false);
    expect((await deleteAccount(f.client, "../x")).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("works with no objects", async () => {
    const f = fakeClient([]);
    expect(await deleteAccount(f.client, UID)).toEqual({ ok: true, objectsRemoved: 0 });
    expect(f.deleteUser).toHaveBeenCalledWith(UID);
  });

  it("the sweep runs after deleting the user, so an upload that raced the delete goes too", async () => {
    const f = fakeClient([`${UID}/a.txt`], {}, (store) => store.add(`${UID}/late.txt`));
    expect(await deleteAccount(f.client, UID)).toEqual({ ok: true, objectsRemoved: 2 });
    expect([...f.store]).toEqual([]);
  });

  it("final sweep failure after the user is gone: no retry is possible, so the result says files remain; the row stays for cron", async () => {
    const logger = vi.fn();
    const f = fakeClient([`${UID}/a.txt`], {}, (store, fail) => {
      store.add(`${UID}/late.txt`);
      fail.list = true;
    });
    const r = await deleteAccount(f.client, UID, { logger });
    expect(r).toEqual({ ok: true, objectsRemoved: 0, filesRemain: true });
    expect(logger).toHaveBeenCalledWith("account_delete_sweep_failed", { user_id: UID, step: "sweep" });
    expect(f.calls).not.toContain("account_file_purge_clear");
  });

  it("a clean final sweep clears the pending row, and a failure to clear it isn't a failure to delete", async () => {
    const f = fakeClient([]);
    await deleteAccount(f.client, UID);
    expect(f.calls.at(-1)).toBe("account_file_purge_clear");
    const rpc = f.client.rpc;
    f.client.rpc = async (fn, args) => {
      if (fn === "account_file_purge_clear") throw new Error("network");
      return rpc(fn, args);
    };
    expect(await deleteAccount(f.client, UID)).toEqual({ ok: true, objectsRemoved: 0 });
  });

  it("a retry when the auth user is already gone treats it as deleted and sweeps", async () => {
    const f = fakeClient([`${UID}/late.txt`], { deleteUser: "not_found" });
    expect(await deleteAccount(f.client, UID)).toEqual({ ok: true, objectsRemoved: 1 });
  });
});

describe("deleteAccount(): the auth audit log", () => {
  const EMAIL = "a@example.com";

  it("records the purge before anything is deleted and runs it after the auth user is gone, with the id and email", async () => {
    const f = fakeClient([`${UID}/a.txt`]);
    expect(await deleteAccount(f.client, UID, { email: EMAIL })).toEqual({ ok: true, objectsRemoved: 1 });
    expect(f.calls[0]).toBe("auth_audit_purge_prepare");
    expect(f.calls.indexOf("auth_audit_purge")).toBeGreaterThan(f.calls.indexOf("deleteUser"));
    expect(f.rpcArgs).toEqual([
      { p_user_id: UID, p_email: EMAIL },
      { p_user_id: UID, p_email: EMAIL },
      { p_user_id: UID },
    ]);
  });

  it("if the purge can't be recorded, nothing is deleted: no file, no user", async () => {
    const logger = vi.fn();
    const f = fakeClient([`${UID}/a.txt`], { prepare: true });
    expect(await deleteAccount(f.client, UID, { email: EMAIL, logger })).toMatchObject({ ok: false, error: { code: "save_failed", retryable: true } });
    expect([...f.store]).toEqual([`${UID}/a.txt`]);
    expect(f.deleteUser).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith("account_delete_audit_failed", { user_id: UID, step: "prepare", remaining: null });
  });

  it("a failed deletion never purges: a surviving account keeps its history", async () => {
    const f = fakeClient([], { deleteUser: true });
    expect((await deleteAccount(f.client, UID, { email: EMAIL })).ok).toBe(false);
    expect(f.calls).not.toContain("auth_audit_purge");
  });

  it.each([
    ["the call fails", "error", null],
    ["the call throws", "throws", null],
    ["entries are left", "left", 2],
  ] as const)("%s: the result says the records remain, and the log carries IDs only", async (_, purge, remaining) => {
    const logger = vi.fn();
    const f = fakeClient([], { purge });
    expect(await deleteAccount(f.client, UID, { email: EMAIL, logger })).toEqual({ ok: true, objectsRemoved: 0, signInRecordsRemain: true });
    expect(logger).toHaveBeenCalledWith("account_delete_audit_failed", { user_id: UID, step: "purge", remaining });
    expect(JSON.stringify(logger.mock.calls)).not.toContain("example.com");
  });

  it("the purge still runs when the final sweep fails", async () => {
    const f = fakeClient([], {}, (_store, fail) => {
      fail.list = true;
    });
    expect(await deleteAccount(f.client, UID, { email: EMAIL, logger: vi.fn() })).toEqual({ ok: true, objectsRemoved: 0, filesRemain: true });
    expect(f.calls).toContain("auth_audit_purge");
  });
});
