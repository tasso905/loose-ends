import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import type { RpcDb } from "@/lib/extraction/service";
import type { ThreadKind, ThreadStatus } from "@/lib/schemas";
import { markDone, undoEvent } from "@/lib/threads/service";
import { transition, type ThreadState } from "@/lib/threads/transition";
import { asUser, migratedDb, rpcAs } from "./pglite";

/**
 * S4 (F9 Done + D44 undo) against the real migrations in PGlite: public.thread_done() and
 * public.thread_undo(), their refusals, ownership, and parity with transition() in TypeScript.
 */

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const NOW = new Date("2026-10-05T15:00:00.123Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const SNOOZE = "2026-10-07T13:00:00.000Z";

let pg: PGlite;
let dbA: RpcDb;
let dbB: RpcDb;

beforeEach(async () => {
  pg = await migratedDb();
  await pg.exec(`insert into auth.users values ('${A}', 'sam@example.com', '{"full_name":"Sam"}'), ('${B}', 'b@example.com', '{}')`);
  dbA = rpcAs(pg, A);
  dbB = rpcAs(pg, B);
});

const q = async <T,>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;

/** A thread of `user` in `status`, with its 'created' event a minute before NOW. */
async function seedThread(user: string, status: ThreadStatus, kind: ThreadKind = "commitment"): Promise<string> {
  const [row] = await q<{ id: string }>(
    `insert into threads (user_id, title, kind, next_action, counterparty, due_at, due_certainty, status, resolution,
                          waiting_on, expected_by, snoozed_until, resolved_at, confidence, created_at, updated_at)
     values ($1, 'Send revised proposal to Mike', $2, 'Send the revised proposal', 'Mike', '2026-10-10T03:59:00.000Z', 'explicit', $3,
             $4, $5, $6, $7, $8, 0.95, '2026-10-05T14:59:00Z', '2026-10-05T14:59:00Z')
     returning id`,
    [
      user,
      kind,
      status,
      status === "resolved" ? "done" : null,
      status === "waiting" ? "Mike" : null,
      status === "waiting" ? "2026-10-08T16:00:00.000Z" : null,
      status === "snoozed" ? SNOOZE : null,
      status === "resolved" ? "2026-10-05T14:00:00.000Z" : null,
    ],
  );
  await pg.query(`insert into thread_events (user_id, thread_id, actor, type, before, after, created_at) values ($1, $2, 'user', 'created', null, '{}', '2026-10-05T14:59:00Z')`, [
    user,
    row!.id,
  ]);
  return row!.id;
}

/** The thread as ThreadState (same formatter the SQL functions compare with). */
async function state(id: string): Promise<ThreadState> {
  const [r] = await q<{ s: ThreadState }>(`select private.thread_state(t) as s from threads t where id = $1`, [id]);
  return r!.s;
}

async function events(id: string) {
  return q<{ id: number; type: string; actor: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; created_at: string }>(
    `select id, type, actor, before, after, created_at from thread_events where thread_id = $1 order by id`,
    [id],
  );
}

async function snapshot() {
  return {
    threads: await q(`select * from threads order by id`),
    events: await q(`select * from thread_events order by id`),
  };
}

describe("Done (thread_done)", () => {
  it("resolves with resolution done and appends a 'resolved' event with before/after", async () => {
    const id = await seedThread(A, "open");
    const res = await markDone(dbA, id, "open", { now: NOW });
    expect(res).toMatchObject({ ok: true, thread_id: id, from_status: "open", to_status: "resolved" });
    expect(await state(id)).toMatchObject({ status: "resolved", resolution: "done", resolved_at: NOW.toISOString() });
    const ev = await events(id);
    expect(ev).toHaveLength(2);
    expect(ev[1]).toMatchObject({
      type: "resolved",
      actor: "user",
      before: { status: "open", resolution: null, resolved_at: null },
      after: { status: "resolved", resolution: "done", resolved_at: NOW.toISOString() },
    });
    expect(res.ok && res.event_id).toBe(ev[1]!.id);
    expect(new Date(ev[1]!.created_at).toISOString()).toBe(NOW.toISOString());
  });

  it("a stale Done (the page showed another status) is invalid_transition and writes nothing", async () => {
    const id = await seedThread(A, "waiting");
    const before = await snapshot();
    const res = await markDone(dbA, id, "open", { now: NOW });
    expect(res).toMatchObject({ ok: false, code: "invalid_transition", error: { error: { code: "invalid_transition", message: "That change isn't possible any more. Refresh to see the latest." } } });
    expect(await snapshot()).toEqual(before);
  });

  it("a second Done on an already-resolved thread is invalid_transition", async () => {
    const id = await seedThread(A, "open");
    await markDone(dbA, id, "open", { now: NOW });
    const before = await snapshot();
    expect(await markDone(dbA, id, "open", { now: at(1000) })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await markDone(dbA, id, "resolved", { now: at(1000) })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await snapshot()).toEqual(before);
  });

  it("decision threads cannot be Done (D6) and dismissed threads cannot either", async () => {
    const d = await seedThread(A, "open", "decision");
    const x = await seedThread(A, "dismissed");
    expect(await markDone(dbA, d, "open", { now: NOW })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await markDone(dbA, x, "dismissed", { now: NOW })).toMatchObject({ ok: false, code: "invalid_transition" });
  });
});

describe("Undo (thread_undo, D44 a)", () => {
  it.each(["open", "waiting", "snoozed"] as const)("within 8 s restores the exact prior %s state and appends an 'undone' event", async (from) => {
    const id = await seedThread(A, from);
    const original = await state(id);
    const done = await markDone(dbA, id, from, { now: NOW });
    if (!done.ok) throw new Error("done failed");
    const res = await undoEvent(dbA, id, done.event_id, { now: at(7999) });
    expect(res).toMatchObject({ ok: true, undone_event_id: done.event_id, undone_action: "done", from_status: "resolved", to_status: from });
    expect(await state(id)).toEqual(original);

    const ev = await events(id);
    expect(ev.map((e) => e.type)).toEqual(["created", "resolved", "undone"]);
    // History is never rewritten: the resolved event is still there unchanged.
    expect(ev[1]!.after).toMatchObject({ status: "resolved" });
    expect(ev[2]).toMatchObject({ actor: "user", before: ev[1]!.after, after: { ...ev[1]!.before, undone_event_id: done.event_id } });
  });

  it("at exactly 12 s (8 s + 4 s grace) it still works; after 12 s it is invalid_transition and writes nothing", async () => {
    const id = await seedThread(A, "open");
    const done = await markDone(dbA, id, "open", { now: NOW });
    if (!done.ok) throw new Error("done failed");
    const before = await snapshot();
    expect(await undoEvent(dbA, id, done.event_id, { now: at(12_001) })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await undoEvent(dbA, id, done.event_id, { now: at(-1) })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await snapshot()).toEqual(before);
    expect(await undoEvent(dbA, id, done.event_id, { now: at(12_000) })).toMatchObject({ ok: true });
  });

  it("inside the grace period (8 s < t ≤ 12 s) Undo works: a toast paused past 8 s is not refused", async () => {
    const id = await seedThread(A, "open");
    const done = await markDone(dbA, id, "open", { now: NOW });
    if (!done.ok) throw new Error("done failed");
    expect(await undoEvent(dbA, id, done.event_id, { now: at(9_500) })).toMatchObject({ ok: true });
  });

  it("only the latest event: a non-latest event, the created event and a repeat undo are refused", async () => {
    const id = await seedThread(A, "open");
    const [created] = await events(id);
    const done = await markDone(dbA, id, "open", { now: NOW });
    if (!done.ok) throw new Error("done failed");
    expect(await undoEvent(dbA, id, created!.id, { now: at(100) })).toMatchObject({ ok: false, code: "invalid_transition" });

    const undo = await undoEvent(dbA, id, done.event_id, { now: at(100) });
    if (!undo.ok) throw new Error("undo failed");
    const before = await snapshot();
    // The resolved event is no longer the latest, and the 'undone' event is not undoable.
    expect(await undoEvent(dbA, id, done.event_id, { now: at(200) })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await undoEvent(dbA, id, undo.event_id, { now: at(200) })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await snapshot()).toEqual(before);
  });

  it("a later event (e.g. a system event) makes the Done non-latest", async () => {
    const id = await seedThread(A, "open");
    const done = await markDone(dbA, id, "open", { now: NOW });
    if (!done.ok) throw new Error("done failed");
    await pg.query(`insert into thread_events (user_id, thread_id, actor, type, before, after, created_at) values ($1, $2, 'system', 'digest_sent', null, null, $3)`, [A, id, at(10).toISOString()]);
    expect(await undoEvent(dbA, id, done.event_id, { now: at(100) })).toMatchObject({ ok: false, code: "invalid_transition" });
  });

  it("Done again after an undo works and can itself be undone", async () => {
    const id = await seedThread(A, "open");
    const d1 = await markDone(dbA, id, "open", { now: NOW });
    if (!d1.ok) throw new Error("done failed");
    await undoEvent(dbA, id, d1.event_id, { now: at(100) });
    const d2 = await markDone(dbA, id, "open", { now: at(200) });
    if (!d2.ok) throw new Error("second done failed");
    expect(await undoEvent(dbA, id, d2.event_id, { now: at(300) })).toMatchObject({ ok: true });
    expect((await events(id)).map((e) => e.type)).toEqual(["created", "resolved", "undone", "resolved", "undone"]);
  });
});

describe("another user's thread is refused (function and RLS)", () => {
  it("B cannot Done or undo A's thread: not_found and nothing written", async () => {
    const id = await seedThread(A, "open");
    const done = await markDone(dbA, id, "open", { now: NOW });
    if (!done.ok) throw new Error("done failed");
    const before = await snapshot();
    expect(await markDone(dbB, id, "resolved", { now: at(10) })).toMatchObject({ ok: false, code: "not_found" });
    expect(await undoEvent(dbB, id, done.event_id, { now: at(10) })).toMatchObject({ ok: false, code: "not_found" });
    expect(await snapshot()).toEqual(before);
  });

  it("the functions check ownership themselves even when RLS does not apply (security definer)", async () => {
    const id = await seedThread(A, "open");
    await pg.exec(`select set_config('request.jwt.claim.sub', '${B}', false)`);
    const [r] = await q<{ r: unknown }>(`select public.thread_done($1, 'open', now()) as r`, [id]);
    expect(r!.r).toEqual({ ok: false, error: "not_found" });
    expect((await state(id)).status).toBe("open");
  });

  it("RLS: B sees none of A's threads or events", async () => {
    const id = await seedThread(A, "open");
    const rows = await asUser(pg, B, async () => ({
      threads: (await pg.query(`select id from threads where id = $1`, [id])).rows,
      events: (await pg.query(`select id from thread_events where thread_id = $1`, [id])).rows,
    }));
    expect(rows).toEqual({ threads: [], events: [] });
  });

  it("no direct UPDATE of threads, even of one's own: status changes only through the functions", async () => {
    const id = await seedThread(A, "open");
    await expect(asUser(pg, A, () => pg.query(`update threads set status = 'resolved' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    expect((await state(id)).status).toBe("open");
  });

  it("anon cannot call the functions", async () => {
    const [r] = await q<{ a: boolean; b: boolean }>(
      `select has_function_privilege('anon', 'public.thread_done(uuid, text, timestamptz)', 'execute') as a,
              has_function_privilege('anon', 'public.thread_undo(uuid, bigint, timestamptz)', 'execute') as b`,
    );
    expect(r).toEqual({ a: false, b: false });
  });
});

describe("SQL thread_done / thread_undo agree with TS transition()", () => {
  const kinds: ThreadKind[] = ["commitment", "request", "waiting_on", "admin", "decision"];
  const statuses: ThreadStatus[] = ["open", "waiting", "snoozed", "resolved", "dismissed"];

  it("for every status and kind: same validity, same thread state, same event before/after", async () => {
    let checked = 0;
    for (const kind of kinds)
      for (const status of statuses) {
        const id = await seedThread(A, status, kind);
        const s0 = await state(id);
        const ts = transition(s0, { type: "done" }, { now: NOW });
        const sql = await markDone(dbA, id, status, { now: NOW });
        const name = `${kind}/${status}`;
        expect(sql.ok, name).toBe(ts.ok);
        if (!ts.ok || !sql.ok) {
          expect(await state(id), name).toEqual(s0);
          continue;
        }
        expect(await state(id), name).toEqual(ts.thread);
        const ev = (await events(id)).at(-1)!;
        expect({ type: ev.type, actor: ev.actor, before: ev.before, after: ev.after }, name).toEqual(ts.event);

        const s1 = await state(id);
        const tsUndo = transition(
          s1,
          { type: "undo", target: { id: ev.id, type: "resolved", actor: "user", before: ev.before, after: ev.after, created_at: new Date(ev.created_at).toISOString(), latest: true } },
          { now: at(5000) },
        );
        const sqlUndo = await undoEvent(dbA, id, ev.id, { now: at(5000) });
        expect(sqlUndo.ok && tsUndo.ok, name).toBe(true);
        if (!tsUndo.ok) continue;
        expect(await state(id), name).toEqual(tsUndo.thread);
        expect(await state(id), name).toEqual(s0);
        const ev2 = (await events(id)).at(-1)!;
        expect({ type: ev2.type, actor: ev2.actor, before: ev2.before, after: ev2.after }, name).toEqual(tsUndo.event);
        checked++;
      }
    // commitment/request/waiting_on/admin × open/waiting/snoozed.
    expect(checked).toBe(12);
  });
});

describe("clock guard (migration 20261021131140): p_now must be within 5 s of the database clock", () => {
  let g: PGlite;
  let gA: RpcDb;
  const dbNow = async () => new Date((await g.query<{ t: string }>(`select now()::text as t`)).rows[0]!.t);
  const shift = (d: Date, ms: number) => new Date(d.getTime() + ms);

  beforeEach(async () => {
    g = await migratedDb({ clockGuard: true });
    await g.exec(`insert into auth.users values ('${A}', 'sam@example.com', '{}')`);
    gA = rpcAs(g, A);
  });

  async function seed(): Promise<string> {
    const [row] = (await g.query<{ id: string }>(`insert into threads (user_id, title, kind) values ($1, 'Synthetic guard thread', 'commitment') returning id`, [A])).rows;
    await g.query(`insert into thread_events (user_id, thread_id, actor, type) values ($1, $2, 'user', 'created')`, [A, row!.id]);
    return row!.id;
  }
  const typesOf = async (id: string) =>
    (await g.query<{ type: string }>(`select type from thread_events where thread_id = $1 order by id`, [id])).rows.map((r) => r.type);

  it("Done with the real clock works; Done with p_now 10 s or 1 h off is refused (save_failed) and writes nothing", async () => {
    const id = await seed();
    for (const off of [-10_000, 10_000, -3_600_000]) {
      const res = await markDone(gA, id, "open", { now: shift(await dbNow(), off), logger: () => {} });
      expect(res, String(off)).toMatchObject({ ok: false, code: "save_failed" });
    }
    expect(await typesOf(id)).toEqual(["created"]);
    expect(await markDone(gA, id, "open", { now: await dbNow() })).toMatchObject({ ok: true });
  });

  it("Undo claiming an instant outside the tolerance is invalid_transition and writes nothing", async () => {
    const id = await seed();
    const done = await markDone(gA, id, "open", { now: shift(await dbNow(), -4_000) });
    if (!done.ok) throw new Error("done failed");
    // Inside the 8 s window of the Done, but 6 s behind the database clock.
    const r = await gA.rpc("thread_undo", { p_thread_id: id, p_event_id: done.event_id, p_now: shift(await dbNow(), -6_000).toISOString() });
    expect(r.data).toEqual({ ok: false, error: "invalid_transition" });
    expect(await typesOf(id)).toEqual(["created", "resolved"]);
    expect(await undoEvent(gA, id, done.event_id, { now: await dbNow() })).toMatchObject({ ok: true });
  });

  it("accept_proposals, reject_proposals and get_extraction refuse a skewed p_now before anything else (22023)", async () => {
    const x = "30000000-0000-0000-0000-000000000001";
    const late = shift(await dbNow(), -60_000).toISOString();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["accept_proposals", { p_extraction_id: x, p_item_ids: [], p_now: late }],
      ["reject_proposals", { p_extraction_id: x, p_item_ids: [], p_now: late }],
      ["get_extraction", { p_extraction_id: x, p_now: late }],
      ["thread_done", { p_thread_id: x, p_from_status: "open", p_now: null }],
    ];
    for (const [fn, args] of calls) expect(await gA.rpc(fn, args), fn).toMatchObject({ data: null, error: { code: "22023" } });
    expect((await gA.rpc("get_extraction", { p_extraction_id: x, p_now: (await dbNow()).toISOString() })).error).toBeNull();
  });

  it("the unguarded bodies, the helpers and the tolerance table are out of reach of authenticated and anon", async () => {
    const fns = [
      "private.thread_done_unguarded(uuid, text, timestamptz)",
      "private.thread_undo_unguarded(uuid, bigint, timestamptz)",
      "private.accept_proposals_unguarded(uuid, uuid[], timestamptz)",
      "private.reject_proposals_unguarded(uuid, uuid[], timestamptz)",
      "private.get_extraction_unguarded(uuid, timestamptz)",
      "private.now_within_skew(timestamptz)",
      "private.assert_now(timestamptz)",
    ];
    for (const role of ["authenticated", "anon"]) {
      for (const sig of fns) {
        const [r] = (await g.query<{ ok: boolean }>(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, sig])).rows;
        expect(r!.ok, `${role} ${sig}`).toBe(false);
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const [r] = (await g.query<{ ok: boolean }>(`select has_table_privilege($1, 'private.clock_guard', $2) as ok`, [role, p])).rows;
        expect(r!.ok, `${role} clock_guard ${p}`).toBe(false);
      }
    }
  });
});
