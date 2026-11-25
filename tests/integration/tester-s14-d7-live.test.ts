/**
 * Lead-tester S14 D7 on REAL local Supabase, recorded model only: the form's user id is only compared
 * with the session and never acts as an identity; anything but the session's own id is refused
 * before any write. Needs LE_SUPABASE_LIVE=1 and the LE_SUPABASE_* variables of an isolated stack.
 */
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ client: null as unknown }));
const tracked = vi.hoisted(() => [] as unknown[]);
const model = vi.hoisted(() => ({ runs: 0 }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void Promise.resolve().then(fn) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("@/lib/analytics/track", () => ({
  track: (...x: unknown[]) => void tracked.push(x),
  createTracker: () => ({ track: () => {}, trackAndWait: async (...x: unknown[]) => void tracked.push(x) }),
}));
vi.mock("@/lib/ai/extract", async (original) => {
  const m = (await original()) as Record<string, unknown>;
  return { ...m, extract: (...x: unknown[]) => ((model.runs += 1), (m.extract as (...y: unknown[]) => unknown)(...x)) };
});
import { submitQuickAdd, undoQuickAddAction } from "@/app/add/actions";

const live = process.env.LE_SUPABASE_LIVE === "1" && Boolean(process.env.LE_SUPABASE_URL);
const PLUMBER = "Call the plumber about the leaking tap";
const REFUSED = { ok: false, signedOut: true, error: { code: "unauthenticated", message: "Sign in to continue.", retryable: false } };
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const TABLES = ["sources", "extractions", "extraction_items", "threads", "thread_events", "evidence", "usage_counters"];

describe.skipIf(!live)("tester S14: D7", () => {
  let admin: SupabaseClient;
  const ids: string[] = [];
  const saved = { ...process.env };
  type U = { id: string; client: SupabaseClient };
  async function user(): Promise<U> {
    const email = `le-test-d7-${randomUUID().slice(0, 8)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { data } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    const client = createClient(process.env.LE_SUPABASE_URL!, process.env.LE_SUPABASE_ANON_KEY!, opts);
    await client.auth.signInWithPassword({ email, password });
    ids.push(data.user!.id);
    return { id: data.user!.id, client };
  }
  const rows = async (...us: U[]) =>
    Promise.all(us.flatMap((u) => TABLES.map(async (t) => (await admin.from(t).select("*").eq("user_id", u.id).throwOnError()).data!.map((r) => JSON.stringify(r)).sort())));
  function form(id: FormDataEntryValue[], key = randomUUID() as string, text = PLUMBER) {
    const f = new FormData();
    f.set("text", text);
    f.set("key", key);
    for (const i of id) f.append("user_id", i);
    return f;
  }
  const pairsOf = (r: Awaited<ReturnType<typeof submitQuickAdd>>) => {
    if (!r.ok) throw new Error("refused");
    return r.created.map((x) => ({ threadId: x.threadId, eventId: x.eventId }));
  };

  beforeAll(() => {
    admin = createClient(process.env.LE_SUPABASE_URL!, process.env.LE_SUPABASE_SERVICE_ROLE_KEY!, opts);
    Object.assign(process.env, { AI_PROVIDER: "fake", AI_MODEL: "recorded", NEXT_PUBLIC_SUPABASE_URL: process.env.LE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.LE_SUPABASE_SERVICE_ROLE_KEY });
    delete process.env.DAILY_AI_BUDGET_USD;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    for (const id of ids) await admin.auth.admin.deleteUser(id).catch(() => undefined);
    process.env = saved;
  });

  it("every id but the session's own is refused: no rows, no count, no model call, no analytics, no database request", async () => {
    const [a, b] = [await user(), await user()];
    current.client = b.client;
    const key = randomUUID();
    const before = await rows(a, b);
    tracked.length = 0;
    model.runs = 0;
    const cases: [string, FormDataEntryValue[]][] = [
      ["A's id", [a.id]],
      ["missing", []],
      ["empty", [""]],
      ["junk", ["junk"]],
      ["null", ["null"]],
      ["undefined", ["undefined"]],
      ["nil uuid", ["00000000-0000-0000-0000-000000000000"]],
      ["own id in capitals", [b.id.toUpperCase()]],
      ["own id with a space", [`${b.id} `]],
      ["own id with a suffix", [`${b.id},${a.id}`]],
      ["a file named as the id", [new File([b.id], b.id)]],
      ["A's id first, own second", [a.id, b.id]],
      ["SQL", [`${b.id}' or '1'='1`]],
    ];
    const fetched = vi.spyOn(globalThis, "fetch");
    for (const [name, id] of cases) expect(await submitQuickAdd(form(id, key)), name).toEqual(REFUSED);
    const paths = new Set(fetched.mock.calls.map(([u]) => new URL(u instanceof Request ? u.url : String(u)).pathname));
    expect([...paths]).toEqual(["/auth/v1/user"]);
    expect(model.runs).toBe(0);
    expect(tracked).toEqual([]);
    expect(await rows(a, b)).toEqual(before);
    // The counter does see the model path when the form is right, and the key was never consumed.
    expect(await submitQuickAdd(form([b.id], key))).toMatchObject({ ok: true, created: [{ title: PLUMBER }] });
    expect(model.runs).toBe(1);
  });

  it("identity is the session's: own id first with A's appended acts as the session user only", async () => {
    const [a, b] = [await user(), await user()];
    current.client = b.client;
    const before = await rows(a);
    expect(await submitQuickAdd(form([b.id, a.id]))).toMatchObject({ ok: true });
    expect(await rows(a)).toEqual(before);
    expect((await admin.from("threads").select("id").eq("user_id", b.id)).data).toHaveLength(1);
  });

  it("no session: refused with a right, wrong or missing id", async () => {
    const a = await user();
    current.client = createClient(process.env.LE_SUPABASE_URL!, process.env.LE_SUPABASE_ANON_KEY!, opts);
    const before = await rows(a);
    for (const id of [[a.id], [randomUUID()], []]) expect(await submitQuickAdd(form(id))).toEqual(REFUSED);
    expect(await rows(a)).toEqual(before);
  });

  it("A's key and line replayed in B's session with B's id: B's own add, never A's result", async () => {
    const [a, b] = [await user(), await user()];
    const key = randomUUID();
    current.client = a.client;
    const first = await submitQuickAdd(form([a.id], key));
    const before = await rows(a);
    current.client = b.client;
    const second = await submitQuickAdd(form([b.id], key));
    expect(pairsOf(second)[0]!.threadId).not.toBe(pairsOf(first)[0]!.threadId);
    expect(await rows(a)).toEqual(before);
  });

  it("Undo: another user's toast is refused for every shownTo, and one's own threads can't be undone with another's id", async () => {
    const [a, b] = [await user(), await user()];
    current.client = a.client;
    const pairsA = pairsOf(await submitQuickAdd(form([a.id])));
    current.client = b.client;
    const pairsB = pairsOf(await submitQuickAdd(form([b.id])));
    const before = await rows(a, b);
    // A's threads in B's session: nothing changes whatever the id says, including none.
    for (const shownTo of [a.id, b.id, undefined, "", "junk", null, {}, [b.id]]) {
      expect((await undoQuickAddAction(pairsA, shownTo as string)).ok, String(shownTo)).toBe(false);
    }
    // B's own threads with an id that is not B's.
    for (const shownTo of [a.id, "", "junk", null, {}, [b.id], b.id.toUpperCase()]) {
      expect(await undoQuickAddAction(pairsB, shownTo as string), String(shownTo)).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    }
    // Mixed: all or nothing.
    expect((await undoQuickAddAction([...pairsB, ...pairsA], b.id)).ok).toBe(false);
    expect(await rows(a, b)).toEqual(before);
    expect(await undoQuickAddAction(pairsB, b.id)).toEqual({ ok: true });
  });
});
