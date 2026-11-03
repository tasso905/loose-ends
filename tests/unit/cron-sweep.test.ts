import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const admin = vi.hoisted(() => ({ client: null as unknown, throws: false }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (admin.throws) throw new Error("config");
    return admin.client;
  },
}));

import { GET, POST } from "@/app/api/cron/daily/route";
import { storageCall, STORAGE_TIMEOUT_CODE } from "@/lib/account/deleteAccount";
import { sweepStorageDeletions, type SweepClient } from "@/lib/account/sweep";

/** cron/daily's Storage sweep (S11-D3, rule 8) and the Storage time limit. No network. */

function client(
  sweeps: unknown[][],
  remove: (paths: string[]) => { error: unknown } = () => ({ error: null }),
  audit: { data: unknown; error: unknown } = { data: { purged: 0, pending: 0 }, error: null },
) {
  const removed: string[][] = [];
  const c: SweepClient = {
    rpc: async (fn) => {
      if (fn === "auth_audit_purge_pending") return audit;
      expect(fn).toBe("storage_deletions_sweep");
      return { data: sweeps.shift() ?? [], error: null };
    },
    storage: {
      from: () => ({
        remove: async (paths) => {
          removed.push(paths);
          return { data: null, ...remove(paths) };
        },
      }),
    },
  };
  return { c, removed };
}

describe("sweepStorageDeletions()", () => {
  it("nothing queued: no Storage call", async () => {
    const { c, removed } = client([[]]);
    expect(await sweepStorageDeletions(c, vi.fn())).toEqual({ ok: true, found: 0, remaining: 0 });
    expect(removed).toEqual([]);
  });

  it("removes in batches of 100, and is ok only when the database says none is left", async () => {
    const paths = Array.from({ length: 150 }, (_, i) => `u/${i}`);
    const { c, removed } = client([paths, []]);
    expect(await sweepStorageDeletions(c, vi.fn())).toEqual({ ok: true, found: 150, remaining: 0 });
    expect(removed.map((b) => b.length)).toEqual([100, 50]);
  });

  it("a failing batch doesn't stop the others; what is left stays queued; logs carry counts, no paths", async () => {
    const paths = Array.from({ length: 150 }, (_, i) => `secret-user/${i}`);
    const { c, removed } = client([paths, paths.slice(0, 100)], (b) => ({ error: b.length === 100 ? { code: "storage_down" } : null }));
    const logger = vi.fn();
    expect(await sweepStorageDeletions(c, logger)).toEqual({ ok: false, found: 150, remaining: 100 });
    expect(removed.length).toBe(2);
    expect(logger).toHaveBeenCalledWith("cron_sweep_failed", { step: "files_left", found: 150, remaining: 100 });
    expect(JSON.stringify(logger.mock.calls)).not.toContain("secret-user");
  });

  it("Storage says it worked but the file is still there: not ok", async () => {
    const { c } = client([["u/1"], ["u/1"]]);
    expect(await sweepStorageDeletions(c, vi.fn())).toEqual({ ok: false, found: 1, remaining: 1 });
  });

  it("a failing database call is reported", async () => {
    const c: SweepClient = { rpc: async () => ({ data: null, error: { code: "XX" } }), storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) } };
    const logger = vi.fn();
    expect(await sweepStorageDeletions(c, logger)).toEqual({ ok: false, found: 0, remaining: null });
    expect(logger).toHaveBeenCalledWith("cron_sweep_failed", expect.objectContaining({ step: "settle" }));
  });
});

describe("storageCall()", () => {
  it("passes a result through", async () => {
    expect(await storageCall(Promise.resolve({ data: 1, error: null }), 50)).toEqual({ data: 1, error: null });
  });
  it("a call that hangs becomes an error result", async () => {
    expect(await storageCall(new Promise<{ data: null; error: null }>(() => undefined), 5)).toEqual({ data: null, error: { code: STORAGE_TIMEOUT_CODE } });
  });
  it("a call that rejects becomes an error result", async () => {
    const err = new Error("network");
    expect(await storageCall(Promise.reject(err), 50)).toEqual({ data: null, error: err });
  });
});

describe("/api/cron/daily", () => {
  const req = (auth?: string) => new Request("http://x/api/cron/daily", { headers: auth ? { authorization: auth } : {} });
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    admin.throws = false;
    admin.client = client([[]]).c;
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([[undefined], ["Bearer wrong"], ["s3cret"], ["Bearer s3cret2"], ["Bearer "]])("refuses authorization %j with the 401 envelope", async (auth) => {
    const res = await GET(req(auth));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("with no CRON_SECRET configured, refuses everything, including an empty bearer", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(req("Bearer "))).status).toBe(401);
    expect((await GET(req("Bearer undefined"))).status).toBe(401);
  });

  it("GET (Vercel Cron) and POST (PRD) both run the sweep and answer counts", async () => {
    for (const h of [GET, POST]) {
      admin.client = client([["u/1"], []]).c;
      const res = await h(req("Bearer s3cret"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, files_found: 1, files_remaining: 0, audit_purged: 0, audit_pending: 0 });
    }
  });

  it("finishes audit log purges and reports the count", async () => {
    admin.client = client([[]], undefined, { data: { purged: 2, pending: 0 }, error: null }).c;
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ audit_purged: 2, audit_pending: 0 });
  });

  it.each([
    ["some stay pending", { data: { purged: 1, pending: 1 }, error: null }, 1],
    ["the call fails", { data: null, error: { code: "XX" } }, null],
  ])("audit log purge: %s answers 500, even with no files to sweep", async (_, audit, pending) => {
    admin.client = client([[]], undefined, audit).c;
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "save_failed" }, audit_pending: pending });
  });

  it("a partial failure answers 500 with the counts and the error envelope", async () => {
    admin.client = client([["u/1"], ["u/1"]], () => ({ error: { code: "storage_down" } })).c;
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "save_failed" }, files_found: 1, files_remaining: 1 });
  });

  it("no service role configured: 500, not a crash", async () => {
    admin.throws = true;
    expect((await GET(req("Bearer s3cret"))).status).toBe(500);
  });
});
