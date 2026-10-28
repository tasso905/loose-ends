import { describe, expect, it, vi } from "vitest";
import { deleteSource, finishStorageDeletions, forgetThread, type DataClient } from "@/lib/account/data";
import { buildExport, EXPORT_TABLES, exportFileName, type ExportClient } from "@/lib/account/export";

const SRC = "10000000-0000-4000-8000-000000000001";
const THR = "20000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-00000000000a";

type Rpc = { data: unknown; error: unknown };

/** A fake user client: scripted rpc results in call order, and a Storage remove that can fail. */
function client(rpcs: Record<string, Rpc[]>, removeError: unknown = null) {
  const calls: string[] = [];
  const removed: string[][] = [];
  const c: DataClient = {
    rpc: (fn) => {
      calls.push(fn);
      const next = rpcs[fn]?.shift();
      if (!next) throw new Error(`unexpected rpc ${fn}`);
      return Promise.resolve(next);
    },
    storage: {
      from: () => ({
        remove: (paths) => {
          removed.push(paths);
          return Promise.resolve({ data: null, error: removeError });
        },
      }),
    },
  };
  return { c, calls, removed };
}

const ok = (data: unknown): Rpc => ({ data, error: null });
const deleted = (threads = 0) => ok({ ok: true, source_id: SRC, threads_forgotten: threads, file_queued: true });

describe("finishStorageDeletions", () => {
  it("removes the queued files, then settles; ok only when nothing is left", async () => {
    const { c, removed } = client({ storage_deletions_settle: [ok(["u/a.pdf", "u/b.txt"]), ok([])] });
    expect(await finishStorageDeletions(c, vi.fn())).toEqual({ ok: true, filesRemoved: 2 });
    expect(removed).toEqual([["u/a.pdf", "u/b.txt"]]);
  });

  it("nothing queued: no Storage call", async () => {
    const { c, removed } = client({ storage_deletions_settle: [ok([])] });
    expect(await finishStorageDeletions(c, vi.fn())).toEqual({ ok: true, filesRemoved: 0 });
    expect(removed).toEqual([]);
  });

  it("removes in batches of 100", async () => {
    const paths = Array.from({ length: 250 }, (_, i) => `u/${i}.txt`);
    const { c, removed } = client({ storage_deletions_settle: [ok(paths), ok([])] });
    await finishStorageDeletions(c, vi.fn());
    expect(removed.map((b) => b.length)).toEqual([100, 100, 50]);
  });

  it("a Storage failure is save_failed (retryable) and logs IDs only", async () => {
    const logger = vi.fn();
    const { c } = client({ storage_deletions_settle: [ok(["u/a.pdf"])] }, { code: "StorageError", message: "secret path u/a.pdf" });
    expect(await finishStorageDeletions(c, logger)).toMatchObject({ ok: false, code: "save_failed", error: { retryable: true } });
    expect(logger).toHaveBeenCalledWith("data_delete_failed", { step: "storage_remove", code: "StorageError" });
  });

  it("a file still present after removal is a failure, never success (rule 10)", async () => {
    const logger = vi.fn();
    const { c } = client({ storage_deletions_settle: [ok(["u/a.pdf"]), ok(["u/a.pdf"])] });
    expect(await finishStorageDeletions(c, logger)).toMatchObject({ ok: false, code: "save_failed" });
    expect(logger).toHaveBeenCalledWith("data_delete_failed", { step: "files_left", code: "files_left", files: 1 });
  });

  it("a settle error or a malformed result fails", async () => {
    expect((await finishStorageDeletions(client({ storage_deletions_settle: [{ data: null, error: { code: "42501" } }] }).c, vi.fn())).ok).toBe(false);
    expect((await finishStorageDeletions(client({ storage_deletions_settle: [ok([1, 2])] }).c, vi.fn())).ok).toBe(false);
  });
});

describe("deleteSource", () => {
  it("calls delete_source with the option, then finishes the files", async () => {
    const { c, calls } = client({ delete_source: [deleted(2)], storage_deletions_settle: [ok(["u/a.pdf"]), ok([])] });
    expect(await deleteSource(c, SRC, true, vi.fn())).toEqual({ ok: true, threadsForgotten: 2 });
    expect(calls).toEqual(["delete_source", "storage_deletions_settle", "storage_deletions_settle"]);
  });

  it("not found (another user's or already gone) still finishes queued files, so a retry completes", async () => {
    const { c, removed } = client({ delete_source: [ok({ ok: false, error: "not_found" })], storage_deletions_settle: [ok(["u/a.pdf"]), ok([])] });
    expect(await deleteSource(c, SRC, false, vi.fn())).toMatchObject({ ok: false, code: "not_found" });
    expect(removed).toEqual([["u/a.pdf"]]);
  });

  it("rows deleted but the file failed: save_failed, not success", async () => {
    const { c } = client({ delete_source: [deleted()], storage_deletions_settle: [ok(["u/a.pdf"])] }, { code: "x" });
    expect(await deleteSource(c, SRC, false, vi.fn())).toMatchObject({ ok: false, code: "save_failed" });
  });

  it("an RPC error is save_failed and touches no file", async () => {
    const { c, calls } = client({ delete_source: [{ data: null, error: { code: "P0001" } }] });
    expect(await deleteSource(c, SRC, false, vi.fn())).toMatchObject({ ok: false, code: "save_failed" });
    expect(calls).toEqual(["delete_source"]);
  });
});

describe("forgetThread", () => {
  it("forgets, finishes files, and reports whether the source went", async () => {
    const { c } = client({ forget_thread: [ok({ threads: 1, sources: 1, evidence: 1, extraction_items: 1, storage_path: "u/a.pdf" })], storage_deletions_settle: [ok(["u/a.pdf"]), ok([])] });
    expect(await forgetThread(c, THR, true, vi.fn())).toEqual({ ok: true, sourceDeleted: true });
  });

  it("another user's thread (P0002) is not found", async () => {
    const { c } = client({ forget_thread: [{ data: null, error: { code: "P0002" } }] });
    expect(await forgetThread(c, THR, false, vi.fn())).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("buildExport", () => {
  function exportClient(rowsByTable: Record<string, unknown[]>, failOn?: string) {
    const seen: Array<{ table: string; eq: [string, string]; order: string[]; range: [number, number] }> = [];
    const c: ExportClient = {
      from: (table) => ({
        select: () => {
          const s = { table, eq: ["", ""] as [string, string], order: [] as string[] };
          const q = {
            eq: (col: string, v: string) => ((s.eq = [col, v]), q),
            order: (col: string) => (s.order.push(col), q),
            range: (from: number, to: number) => {
              seen.push({ ...s, order: [...s.order], range: [from, to] });
              if (table === failOn) return Promise.resolve({ data: null, error: { code: "x" } });
              return Promise.resolve({ data: (rowsByTable[table] ?? []).slice(from, to + 1), error: null });
            },
          };
          return q;
        },
      }),
    };
    return { c, seen };
  }

  it("reads every table filtered by the user, pages past the page size, and dates the file in UTC", async () => {
    const threads = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` }));
    const { c, seen } = exportClient({ threads, profiles: [{ id: USER }] });
    const now = new Date("2026-10-27T23:30:00Z");
    const res = await buildExport(c, USER, now, { pageSize: 2, logger: vi.fn() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(res.data.tables)).toEqual(EXPORT_TABLES.map((t) => t.table));
    expect(res.data.tables.threads).toEqual(threads);
    expect(res.data).toMatchObject({ format: "loose-ends-export", version: 1, user_id: USER, exported_at: "2026-10-27T23:30:00.000Z" });
    expect(seen.filter((s) => s.table === "threads").map((s) => s.range)).toEqual([[0, 1], [2, 3], [4, 5]]);
    for (const s of seen) expect(s.eq[1]).toBe(USER);
    expect(seen.find((s) => s.table === "profiles")!.eq[0]).toBe("id");
    expect(exportFileName(now)).toBe("loose-ends-export-2026-10-27.json");
  });

  it("any table failing fails the whole export (no partial file) and logs the table name only", async () => {
    const logger = vi.fn();
    const { c } = exportClient({}, "evidence");
    expect(await buildExport(c, USER, new Date(), { logger })).toEqual({ ok: false });
    expect(logger).toHaveBeenCalledWith("export_failed", { table: "evidence", step: "read" });
  });
});
