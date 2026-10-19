import { describe, expect, it, vi } from "vitest";
import { deleteAccount, type AccountAdminClient } from "@/lib/account/deleteAccount";

const UID = "00000000-0000-4000-8000-000000000001";

/** In-memory bucket: flat paths like `${UID}/a.txt` and `${UID}/sub/b.txt`. */
function fakeClient(
  files: string[],
  fail: { list?: boolean; remove?: boolean; removeNoop?: boolean; deleteUser?: boolean | "not_found" } = {},
  onDeleteUser?: (store: Set<string>, fail: { list?: boolean }) => void,
) {
  const store = new Set(files);
  const calls: string[] = [];
  const deleteUser = vi.fn(async () => {
    calls.push("deleteUser");
    onDeleteUser?.(store, fail);
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
    auth: { admin: { deleteUser } },
  };
  return { client, store, calls, deleteUser };
}

describe("deleteAccount(): storage first, then the auth user", () => {
  it("removes every object (paginated, with subfolders) and then deletes the user", async () => {
    const files = [...Array.from({ length: 5 }, (_, i) => `${UID}/f${i}.txt`), `${UID}/sub/x.pdf`, `${UID}/sub/y.pdf`];
    const f = fakeClient([...files, "someone-else/z.txt"]);
    const r = await deleteAccount(f.client, UID, { pageSize: 2 });
    expect(r).toEqual({ ok: true, objectsRemoved: 7 });
    expect([...f.store]).toEqual(["someone-else/z.txt"]);
    expect(f.calls.indexOf("deleteUser")).toBeGreaterThan(f.calls.findIndex((c) => c.startsWith("remove:")));
    expect(f.calls.filter((c) => c.startsWith(`list:${UID}:`)).length).toBeGreaterThan(2); // paginated
  });

  it.each([
    ["list fails", { list: true }],
    ["remove fails", { remove: true }],
    ["objects still there after remove", { removeNoop: true }],
  ])("%s → retryable error, user NOT deleted", async (_, fail) => {
    const f = fakeClient([`${UID}/a.txt`], fail);
    const r = await deleteAccount(f.client, UID);
    expect(r).toEqual({ ok: false, error: { code: "save_failed", message: "That didn't save. Try again.", retryable: true } });
    expect(f.deleteUser).not.toHaveBeenCalled();
  });

  it("auth delete failure is reported, not success", async () => {
    const f = fakeClient([], { deleteUser: true });
    const r = await deleteAccount(f.client, UID);
    expect(r.ok).toBe(false);
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

  it("sweeps again after deleting the user: a late upload is removed and logged (IDs only)", async () => {
    const logger = vi.fn();
    const f = fakeClient([`${UID}/a.txt`], {}, (store) => store.add(`${UID}/late.txt`));
    const r = await deleteAccount(f.client, UID, { logger });
    expect(r).toEqual({ ok: true, objectsRemoved: 2 });
    expect([...f.store]).toEqual([]);
    expect(logger).toHaveBeenCalledWith("account_delete_late_objects", { user_id: UID, objects: 1 });
  });

  it("final sweep failure after the user is gone: logged and reported as a failure, never success", async () => {
    const logger = vi.fn();
    const f = fakeClient([`${UID}/a.txt`], {}, (store, fail) => {
      store.add(`${UID}/late.txt`);
      fail.list = true;
    });
    const r = await deleteAccount(f.client, UID, { logger });
    expect(r).toMatchObject({ ok: false, error: { code: "save_failed", retryable: true } });
    expect(logger).toHaveBeenCalledWith("account_delete_sweep_failed", { user_id: UID });
  });

  it("a retry when the auth user is already gone treats it as deleted and sweeps", async () => {
    const f = fakeClient([`${UID}/late.txt`], { deleteUser: "not_found" });
    expect(await deleteAccount(f.client, UID)).toEqual({ ok: true, objectsRemoved: 1 });
  });
});
