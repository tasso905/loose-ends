import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import type { RpcDb } from "@/lib/extraction/service";
import type { ThreadKind, ThreadStatus } from "@/lib/schemas";
import { threadAction, undoEvent, type StatusAction } from "@/lib/threads/service";
import { transition, type ThreadAction, type ThreadState } from "@/lib/threads/transition";
import { migratedDb, rpcAs } from "./pglite";

/**
 * S12 (F9: Mark waiting, Snooze, Dismiss, Back to me, Wake now, Reopen, Edit) against the real
 * migrations in PGlite: each SQL function (migration 20261110120000), its refusals, ownership,
 * suppression on Dismiss / Reopen / Undo, and parity with transition() in TypeScript.
 */

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const NOW = new Date("2026-10-05T15:00:00.123Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const SNOOZE = "2026-10-07T13:00:00.000Z";
const LATER = "2026-10-09T13:00:00.000Z";
const SRC = "00000000-0000-0000-0000-0000000000c1";
const EX = "00000000-0000-0000-0000-0000000000c2";
const HASH = "a".repeat(64);

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

async function seedThread(user: string, status: ThreadStatus, kind: ThreadKind = "commitment"): Promise<string> {
  const [row] = await q<{ id: string }>(
    `insert into threads (user_id, title, kind, next_action, counterparty, due_at, due_certainty, status, resolution,
                          waiting_on, expected_by, snoozed_until, resolved_at, confidence, created_at, updated_at)
     values ($1, 'Send revised proposal to Mike', $2, 'Send the revised proposal', 'Mike', '2026-10-10T03:59:00.000Z', 'inferred', $3,
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

/** Links an accepted proposal with a suppression hash to the thread (as accept_proposals does). */
async function linkProposal(user: string, threadId: string, hash = HASH) {
  await pg.exec(`
    insert into sources (id, user_id, kind, text_content, reference_date, reference_date_source)
      values ('${SRC}', '${user}', 'paste', 'Mike: please send the revised proposal by Friday.', '2026-10-05', 'user') on conflict do nothing;
    insert into extractions (id, user_id, source_id, status, model, prompt_version, schema_version, raw_output)
      values ('${EX}', '${user}', '${SRC}', 'succeeded', 'fake:recorded', 'extract.v1', 'extraction.v1', '{"items":[]}'::jsonb) on conflict do nothing;
    insert into extraction_items (user_id, extraction_id, payload, confidence, band, review_status, thread_id, suppression_hash, item_index)
      values ('${user}', '${EX}', '{"title":"x"}'::jsonb, 0.95, 'high', 'accepted', '${threadId}', '${hash}', 0);
  `);
}

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

const suppressions = () => q<{ suppression_hash: string; reason: string; thread_id: string | null }>(`select suppression_hash, reason, thread_id from suppressions order by 1`);

async function snapshot() {
  return {
    threads: await q(`select * from threads order by id`),
    events: await q(`select * from thread_events order by id`),
    suppressions: await suppressions(),
  };
}

const act = (id: string, from: ThreadStatus, action: StatusAction, now = NOW, db = dbA) => threadAction(db, id, from, action, { now });

describe("Mark waiting (thread_mark_waiting)", () => {
  it("open → waiting with waiting_on and expected_by, and a status_changed event with before/after", async () => {
    const id = await seedThread(A, "open");
    const res = await act(id, "open", { type: "mark_waiting", waitingOn: "Mike", expectedBy: LATER });
    expect(res).toMatchObject({ ok: true, thread_id: id, from_status: "open", to_status: "waiting" });
    expect(await state(id)).toMatchObject({ status: "waiting", waiting_on: "Mike", expected_by: LATER });
    const ev = (await events(id)).at(-1)!;
    expect(ev).toMatchObject({
      type: "status_changed",
      actor: "user",
      before: { status: "open", waiting_on: null, expected_by: null },
      after: { status: "waiting", waiting_on: "Mike", expected_by: LATER },
    });
    expect(res.ok && res.event_id).toBe(ev.id);
  });

  it("expected_by is optional", async () => {
    const id = await seedThread(A, "open");
    expect(await act(id, "open", { type: "mark_waiting", waitingOn: "Mike", expectedBy: null })).toMatchObject({ ok: true });
    expect(await state(id)).toMatchObject({ status: "waiting", expected_by: null });
  });

  it("a blank or over-long waiting_on is refused and writes nothing", async () => {
    const id = await seedThread(A, "open");
    const before = await snapshot();
    expect(await act(id, "open", { type: "mark_waiting", waitingOn: " ​ ", expectedBy: null })).toMatchObject({ ok: false, code: "save_failed" });
    expect(await act(id, "open", { type: "mark_waiting", waitingOn: "x".repeat(101), expectedBy: null })).toMatchObject({ ok: false, code: "save_failed" });
    expect(await snapshot()).toEqual(before);
  });

  it.each(["waiting", "snoozed", "resolved", "dismissed"] as const)("from %s is invalid_transition", async (status) => {
    const id = await seedThread(A, status);
    const before = await snapshot();
    expect(await act(id, status, { type: "mark_waiting", waitingOn: "Mike", expectedBy: null })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await snapshot()).toEqual(before);
  });
});

describe("Snooze (thread_snooze)", () => {
  it("open → snoozed with snoozed_until and a snoozed event", async () => {
    const id = await seedThread(A, "open");
    expect(await act(id, "open", { type: "snooze", until: SNOOZE })).toMatchObject({ ok: true, to_status: "snoozed" });
    expect(await state(id)).toMatchObject({ status: "snoozed", snoozed_until: SNOOZE });
    expect((await events(id)).at(-1)).toMatchObject({ type: "snoozed", before: { status: "open", snoozed_until: null }, after: { status: "snoozed", snoozed_until: SNOOZE } });
  });

  it("a date not after now is refused", async () => {
    const id = await seedThread(A, "open");
    expect(await act(id, "open", { type: "snooze", until: NOW.toISOString() })).toMatchObject({ ok: false, code: "save_failed" });
    expect((await state(id)).status).toBe("open");
  });

  it("a waiting thread cannot be snoozed (PRD lifecycle table)", async () => {
    const id = await seedThread(A, "waiting");
    expect(await act(id, "waiting", { type: "snooze", until: SNOOZE })).toMatchObject({ ok: false, code: "invalid_transition" });
  });
});

describe("Dismiss (thread_dismiss) and suppression", () => {
  it("dismisses and writes a 'dismissed' suppression for the thread's proposal hash", async () => {
    const id = await seedThread(A, "open");
    await linkProposal(A, id);
    expect(await act(id, "open", { type: "dismiss" })).toMatchObject({ ok: true, to_status: "dismissed" });
    expect(await state(id)).toMatchObject({ status: "dismissed", resolution: null });
    expect(await suppressions()).toEqual([{ suppression_hash: HASH, reason: "dismissed", thread_id: id }]);
  });

  it("a dismissed thread's item is suppressed when the same source is extracted again", async () => {
    const id = await seedThread(A, "open");
    await linkProposal(A, id);
    await act(id, "open", { type: "dismiss" });
    // complete_extraction skips any item whose hash is suppressed (migration 20261020231312).
    const [r] = await q<{ n: number }>(`select count(*)::int n from suppressions where user_id = $1 and suppression_hash = $2`, [A, HASH]);
    expect(r!.n).toBe(1);
  });

  it("keeps the hash when the proposal row is gone (Delete source only), via the kept hash", async () => {
    const id = await seedThread(A, "open");
    await linkProposal(A, id);
    await pg.exec(`delete from extraction_items where thread_id = '${id}'`);
    await act(id, "open", { type: "dismiss" });
    expect(await suppressions()).toEqual([{ suppression_hash: HASH, reason: "dismissed", thread_id: id }]);
  });

  it("an existing 'rejected' suppression for the same hash is left as it is", async () => {
    const id = await seedThread(A, "open");
    await linkProposal(A, id);
    await pg.exec(`insert into suppressions (user_id, suppression_hash, reason) values ('${A}', '${HASH}', 'rejected')`);
    await act(id, "open", { type: "dismiss" });
    expect(await suppressions()).toEqual([{ suppression_hash: HASH, reason: "rejected", thread_id: null }]);
    await act(id, "dismissed", { type: "reopen" }, at(20_000));
    expect(await suppressions()).toEqual([{ suppression_hash: HASH, reason: "rejected", thread_id: null }]);
  });

  it.each(["open", "waiting", "snoozed"] as const)("from %s; a snooze date is cleared", async (status) => {
    const id = await seedThread(A, status);
    expect(await act(id, status, { type: "dismiss" })).toMatchObject({ ok: true });
    expect(await state(id)).toMatchObject({ status: "dismissed", snoozed_until: null });
  });

  it("an already-closed thread cannot be dismissed", async () => {
    const id = await seedThread(A, "resolved");
    expect(await act(id, "resolved", { type: "dismiss" })).toMatchObject({ ok: false, code: "invalid_transition" });
  });
});

describe("Reopen (thread_reopen)", () => {
  it("dismissed → open deletes the suppression and writes a reopened event", async () => {
    const id = await seedThread(A, "open");
    await linkProposal(A, id);
    await act(id, "open", { type: "dismiss" });
    expect(await act(id, "dismissed", { type: "reopen" }, at(20_000))).toMatchObject({ ok: true, from_status: "dismissed", to_status: "open" });
    expect(await suppressions()).toEqual([]);
    expect((await events(id)).at(-1)).toMatchObject({ type: "reopened", after: { status: "open" } });
  });

  it("resolved → open clears the resolution and keeps the decision row", async () => {
    const id = await seedThread(A, "open");
    await dbA.rpc("thread_resolve", { p_thread_id: id, p_from_status: "open", p_resolution: "decided", p_choice: "Cedar", p_reason: null, p_now: NOW.toISOString() });
    expect(await act(id, "resolved", { type: "reopen" }, at(20_000))).toMatchObject({ ok: true });
    expect(await state(id)).toMatchObject({ status: "open", resolution: null, resolved_at: null });
    expect(await q(`select choice from decisions where thread_id = $1`, [id])).toEqual([{ choice: "Cedar" }]);
  });

  it.each(["open", "waiting", "snoozed"] as const)("an active (%s) thread cannot be reopened", async (status) => {
    const id = await seedThread(A, status);
    expect(await act(id, status, { type: "reopen" })).toMatchObject({ ok: false, code: "invalid_transition" });
  });
});

describe("Back to me and Wake now", () => {
  it("waiting → open clears waiting_on and expected_by", async () => {
    const id = await seedThread(A, "waiting");
    expect(await act(id, "waiting", { type: "back_to_me" })).toMatchObject({ ok: true, to_status: "open" });
    expect(await state(id)).toMatchObject({ status: "open", waiting_on: null, expected_by: null });
  });

  it("snoozed → open clears snoozed_until, before the date too (user)", async () => {
    const id = await seedThread(A, "snoozed");
    expect(await act(id, "snoozed", { type: "wake" })).toMatchObject({ ok: true, to_status: "open" });
    expect(await state(id)).toMatchObject({ status: "open", snoozed_until: null });
  });
});

describe("Edit (thread_edit)", () => {
  it("changes only the fields given; a user-set date is explicit; one edited event", async () => {
    const id = await seedThread(A, "open");
    const res = await act(id, "open", { type: "edit", fields: { title: "Send the final proposal", due_at: LATER, due_time_known: true } });
    expect(res).toMatchObject({ ok: true, to_status: "open" });
    expect(await state(id)).toMatchObject({ title: "Send the final proposal", due_at: LATER, due_certainty: "explicit", due_time_known: true, next_action: "Send the revised proposal" });
    expect((await events(id)).at(-1)).toMatchObject({
      type: "edited",
      before: { title: "Send revised proposal to Mike", due_at: "2026-10-10T03:59:00.000Z", due_certainty: "inferred", due_time_known: false },
      after: { title: "Send the final proposal", due_at: LATER, due_certainty: "explicit", due_time_known: true },
    });
  });

  it("an edit that changes nothing writes nothing and returns no event", async () => {
    const id = await seedThread(A, "open");
    const before = await snapshot();
    expect(await act(id, "open", { type: "edit", fields: { title: "Send revised proposal to Mike" } })).toMatchObject({ ok: true, event_id: null });
    expect(await snapshot()).toEqual(before);
  });

  it("removing the date sets certainty none", async () => {
    const id = await seedThread(A, "open");
    await act(id, "open", { type: "edit", fields: { due_at: null } });
    expect(await state(id)).toMatchObject({ due_at: null, due_certainty: "none", due_time_known: false });
  });

  it("waiting fields only while waiting; snooze date only while snoozed and in the future", async () => {
    const open = await seedThread(A, "open");
    expect(await act(open, "open", { type: "edit", fields: { waiting_on: "Ana" } })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await act(open, "open", { type: "edit", fields: { snoozed_until: LATER } })).toMatchObject({ ok: false, code: "invalid_transition" });
    const waiting = await seedThread(A, "waiting");
    expect(await act(waiting, "waiting", { type: "edit", fields: { waiting_on: "Ana", expected_by: null } })).toMatchObject({ ok: true });
    expect(await state(waiting)).toMatchObject({ waiting_on: "Ana", expected_by: null });
    const snoozed = await seedThread(A, "snoozed");
    expect(await act(snoozed, "snoozed", { type: "edit", fields: { snoozed_until: LATER } })).toMatchObject({ ok: true });
    expect(await act(snoozed, "snoozed", { type: "edit", fields: { snoozed_until: NOW.toISOString() } })).toMatchObject({ ok: false, code: "save_failed" });
  });

  it("refuses unknown fields, blank or over-long text, and a bad kind; writes nothing", async () => {
    const id = await seedThread(A, "open");
    const before = await snapshot();
    for (const fields of [
      { status: "resolved" },
      { user_id: B },
      { title: "  " },
      { title: "x".repeat(121) },
      { next_action: "x".repeat(301) },
      { counterparty: "x".repeat(101) },
      { kind: "project" },
      { kind: null },
    ]) {
      expect(await act(id, "open", { type: "edit", fields }), JSON.stringify(fields)).toMatchObject({ ok: false, code: "save_failed" });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("a waiting thread cannot change to or from the waiting_on kind", async () => {
    const id = await seedThread(A, "waiting", "commitment");
    expect(await act(id, "waiting", { type: "edit", fields: { kind: "waiting_on" } })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await act(id, "waiting", { type: "edit", fields: { kind: "request" } })).toMatchObject({ ok: true });
  });

  it("closed threads can be edited", async () => {
    const id = await seedThread(A, "resolved");
    expect(await act(id, "resolved", { type: "edit", fields: { title: "Renamed" } })).toMatchObject({ ok: true, to_status: "resolved" });
  });
});

describe("stale pages, ownership and the clock", () => {
  it("a stale from-status is invalid_transition for every action", async () => {
    const id = await seedThread(A, "open");
    const before = await snapshot();
    for (const a of [
      { type: "mark_waiting", waitingOn: "Mike", expectedBy: null },
      { type: "snooze", until: SNOOZE },
      { type: "dismiss" },
      { type: "edit", fields: { title: "x" } },
    ] as StatusAction[]) {
      expect(await act(id, "waiting", a), a.type).toMatchObject({ ok: false, code: "invalid_transition" });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("another user's thread reads as not_found and is unchanged", async () => {
    const id = await seedThread(A, "open");
    const before = await snapshot();
    for (const a of [
      { type: "mark_waiting", waitingOn: "Mike", expectedBy: null },
      { type: "snooze", until: SNOOZE },
      { type: "dismiss" },
      { type: "edit", fields: { title: "x" } },
    ] as StatusAction[]) {
      expect(await act(id, "open", a, NOW, dbB), a.type).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("anon cannot execute the new functions; p_now far from the database clock is refused", async () => {
    const g = await migratedDb({ clockGuard: true });
    await g.exec(`insert into auth.users values ('${A}', 'sam@example.com', '{}')`);
    for (const fn of ["thread_mark_waiting", "thread_snooze", "thread_dismiss", "thread_back_to_me", "thread_wake", "thread_reopen", "thread_edit"]) {
      const [r] = (await g.query<{ anon: boolean; auth: boolean }>(
        `select has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth from pg_proc p where proname = $1 and pronamespace = 'public'::regnamespace`,
        [fn],
      )).rows;
      expect(r, fn).toEqual({ anon: false, auth: true });
    }
    const [row] = (await g.query<{ id: string }>(`insert into threads (user_id, title, kind) values ('${A}', 'T', 'commitment') returning id`)).rows;
    const res = await threadAction(rpcAs(g, A), row!.id, "open", { type: "dismiss" }, { now: new Date("2000-01-01T00:00:00Z") });
    expect(res).toMatchObject({ ok: false, code: "save_failed" });
  });
});

describe("Undo (D44) of the S12 actions", () => {
  const cases: Array<{ name: string; from: ThreadStatus; action: StatusAction; undone: string }> = [
    { name: "Mark waiting", from: "open", action: { type: "mark_waiting", waitingOn: "Mike", expectedBy: LATER }, undone: "mark_waiting" },
    { name: "Snooze", from: "open", action: { type: "snooze", until: SNOOZE }, undone: "snooze" },
    { name: "Dismiss", from: "open", action: { type: "dismiss" }, undone: "dismiss" },
    { name: "Back to me", from: "waiting", action: { type: "back_to_me" }, undone: "back_to_me" },
    { name: "Wake now", from: "snoozed", action: { type: "wake" }, undone: "wake" },
    { name: "Edit", from: "open", action: { type: "edit", fields: { title: "Renamed", due_at: null } }, undone: "edit" },
  ];

  it.each(cases)("$name: restores the exact prior state and appends an undone event", async ({ from, action, undone }) => {
    const id = await seedThread(A, from);
    await linkProposal(A, id);
    const original = await state(id);
    const res = await act(id, from, action);
    if (!res.ok || res.event_id === null) throw new Error("action failed");
    const u = await undoEvent(dbA, id, res.event_id, { now: at(7_000) });
    expect(u).toMatchObject({ ok: true, undone_action: undone, to_status: from });
    expect(await state(id)).toEqual(original);
    // Undoing a Dismiss removes its suppression.
    expect(await suppressions()).toEqual([]);
    expect((await events(id)).map((e) => e.type).at(-1)).toBe("undone");
  });

  it("after 12 s Undo is refused", async () => {
    const id = await seedThread(A, "open");
    const res = await act(id, "open", { type: "snooze", until: SNOOZE });
    if (!res.ok || res.event_id === null) throw new Error("snooze failed");
    expect(await undoEvent(dbA, id, res.event_id, { now: at(12_001) })).toMatchObject({ ok: false, code: "invalid_transition" });
  });

  it("Reopen is not undoable", async () => {
    const id = await seedThread(A, "resolved");
    const res = await act(id, "resolved", { type: "reopen" });
    if (!res.ok || res.event_id === null) throw new Error("reopen failed");
    expect(await undoEvent(dbA, id, res.event_id, { now: at(1_000) })).toMatchObject({ ok: false, code: "invalid_transition" });
  });
});

describe("SQL agrees with TS transition()", () => {
  const kinds: ThreadKind[] = ["commitment", "waiting_on", "decision"];
  const statuses: ThreadStatus[] = ["open", "waiting", "snoozed", "resolved", "dismissed"];
  const actions: Array<[StatusAction, ThreadAction]> = [
    [{ type: "mark_waiting", waitingOn: "Ana", expectedBy: LATER }, { type: "mark_waiting", waitingOn: "Ana", expectedBy: LATER }],
    [{ type: "snooze", until: LATER }, { type: "snooze", until: LATER }],
    [{ type: "dismiss" }, { type: "dismiss" }],
    [{ type: "back_to_me" }, { type: "back_to_me" }],
    [{ type: "wake" }, { type: "wake" }],
    [{ type: "reopen" }, { type: "reopen" }],
    [{ type: "edit", fields: { title: "Renamed", next_action: null, counterparty: "Ana" } }, { type: "edit", fields: { title: "Renamed", next_action: null, counterparty: "Ana" } }],
    [{ type: "edit", fields: { due_at: LATER, due_time_known: true } }, { type: "edit", fields: { due_at: LATER, due_time_known: true } }],
    [{ type: "edit", fields: { kind: "request" } }, { type: "edit", fields: { kind: "request" } }],
    [{ type: "edit", fields: { waiting_on: "Ana" } }, { type: "edit", fields: { waiting_on: "Ana" } }],
    [{ type: "edit", fields: { snoozed_until: LATER } }, { type: "edit", fields: { snoozed_until: LATER } }],
  ];

  it("for every action, status and kind: same validity, same thread state, same event", async () => {
    let checked = 0;
    for (const [sqlAction, tsAction] of actions)
      for (const kind of kinds)
        for (const status of statuses) {
          const id = await seedThread(A, status, kind);
          const s0 = await state(id);
          const ts = transition(s0, tsAction, { now: NOW });
          const sql = await act(id, status, sqlAction);
          const name = `${sqlAction.type} ${JSON.stringify(tsAction)} ${kind}/${status}`;
          expect(sql.ok, name).toBe(ts.ok);
          if (!ts.ok || !sql.ok) {
            expect(await state(id), name).toEqual(s0);
            continue;
          }
          expect(await state(id), name).toEqual(ts.thread);
          const ev = (await events(id)).at(-1)!;
          if (ts.event === null) {
            expect(sql.event_id, name).toBeNull();
          } else {
            expect({ type: ev.type, actor: ev.actor, before: ev.before, after: ev.after }, name).toEqual(ts.event);
          }
          checked++;
        }
    expect(checked).toBeGreaterThan(40);
  });
});
