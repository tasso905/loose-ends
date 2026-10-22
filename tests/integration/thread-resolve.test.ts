import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import type { RpcDb } from "@/lib/extraction/service";
import type { Resolution, ThreadKind, ThreadStatus } from "@/lib/schemas";
import { resolveThread, undoEvent } from "@/lib/threads/service";
import { transition, type ThreadState } from "@/lib/threads/transition";
import { asUser, migratedDb, rpcAs } from "./pglite";

/**
 * S8 (F11 Resolve + decisions write model) against the real migrations in PGlite:
 * public.thread_resolve(), Undo of a resolution, the decisions RLS and grants, and parity with
 * transition() {type: "resolve"}.
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

async function seedThread(user: string, status: ThreadStatus, kind: ThreadKind = "commitment"): Promise<string> {
  const [row] = await q<{ id: string }>(
    `insert into threads (user_id, title, kind, next_action, counterparty, due_at, due_certainty, status, resolution,
                          waiting_on, expected_by, snoozed_until, resolved_at, confidence, created_at, updated_at)
     values ($1, 'Renew home insurance', $2, 'Choose whether to renew', 'Provider A', '2026-10-31T03:59:00.000Z', 'explicit', $3,
             $4, $5, $6, $7, $8, 0.95, '2026-10-05T14:59:00Z', '2026-10-05T14:59:00Z')
     returning id`,
    [
      user,
      kind,
      status,
      status === "resolved" ? "done" : null,
      status === "waiting" ? "Provider A" : null,
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

async function state(id: string): Promise<ThreadState> {
  const [r] = await q<{ s: ThreadState }>(`select private.thread_state(t) as s from threads t where id = $1`, [id]);
  return r!.s;
}

const events = (id: string) =>
  q<{ id: number; type: string; actor: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; created_at: string }>(
    `select id, type, actor, before, after, created_at from thread_events where thread_id = $1 order by id`,
    [id],
  );

const decisions = (id: string) =>
  q<{ id: string; user_id: string; choice: string; reason_user: string | null; reason_ai_summary: string | null; context_facts: unknown; decided_at: string; resolution_event_id: number }>(
    `select id, user_id, choice, reason_user, reason_ai_summary, context_facts, decided_at, resolution_event_id from decisions where thread_id = $1 order by decided_at`,
    [id],
  );

async function snapshot() {
  return {
    threads: await q(`select * from threads order by id`),
    events: await q(`select * from thread_events order by id`),
    decisions: await q(`select id, thread_id, choice, reason_user from decisions order by id`),
  };
}

const REASON = "  The alternatives were more expensive,\nand this one covers the windshield. 🚗  ";

describe("Resolve (thread_resolve)", () => {
  it("Decided: resolves, appends a 'resolved' event, and writes the decision exactly as typed, linked to that event", async () => {
    const id = await seedThread(A, "open");
    const res = await resolveThread(dbA, id, "open", "decided", { choice: "Renewed with Provider A", reason: REASON }, { now: NOW });
    expect(res).toMatchObject({ ok: true, thread_id: id, resolution: "decided", from_status: "open", to_status: "resolved" });
    expect(await state(id)).toMatchObject({ status: "resolved", resolution: "decided", resolved_at: NOW.toISOString() });
    const ev = await events(id);
    expect(ev.map((e) => e.type)).toEqual(["created", "resolved"]);
    expect(ev[1]).toMatchObject({ actor: "user", before: { status: "open", resolution: null }, after: { status: "resolved", resolution: "decided" } });
    const [d] = await decisions(id);
    expect(d).toMatchObject({ user_id: A, choice: "Renewed with Provider A", reason_user: REASON, reason_ai_summary: null, context_facts: [], resolution_event_id: ev[1]!.id });
    expect(new Date(d!.decided_at).toISOString()).toBe(NOW.toISOString());
    expect(res.ok && res.decision_id).toBe(d!.id);
    expect(res.ok && res.event_id).toBe(ev[1]!.id);
  });

  it("Skip: Decided with no reason saves the decision with reason_user null; a blank reason is no reason", async () => {
    const a = await seedThread(A, "open");
    const b = await seedThread(A, "open");
    await resolveThread(dbA, a, "open", "decided", { choice: "Renew", reason: null }, { now: NOW });
    await resolveThread(dbA, b, "open", "decided", { choice: "Renew", reason: " \n\t " }, { now: NOW });
    expect((await decisions(a))[0]).toMatchObject({ choice: "Renew", reason_user: null });
    expect((await decisions(b))[0]).toMatchObject({ choice: "Renew", reason_user: null });
  });

  it.each(["done", "not_needed"] as const)("%s: resolves with no decision row", async (resolution) => {
    const id = await seedThread(A, "open");
    expect(await resolveThread(dbA, id, "open", resolution, null, { now: NOW })).toMatchObject({ ok: true, decision_id: null, resolution });
    expect((await state(id)).resolution).toBe(resolution);
    expect(await decisions(id)).toEqual([]);
  });

  it.each(["waiting", "snoozed"] as const)("from %s it resolves directly (D6)", async (from) => {
    const id = await seedThread(A, from);
    expect(await resolveThread(dbA, id, from, "not_needed", null, { now: NOW })).toMatchObject({ ok: true, from_status: from });
    expect(await state(id)).toMatchObject({ status: "resolved", snoozed_until: null });
  });

  it("refusals write nothing: stale page, closed thread, Done on a decision thread", async () => {
    const stale = await seedThread(A, "waiting");
    const closed = await seedThread(A, "dismissed");
    const decision = await seedThread(A, "open", "decision");
    const before = await snapshot();
    expect(await resolveThread(dbA, stale, "open", "not_needed", null, { now: NOW })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await resolveThread(dbA, closed, "dismissed", "not_needed", null, { now: NOW })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await resolveThread(dbA, decision, "open", "done", null, { now: NOW })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await snapshot()).toEqual(before);
    expect(await resolveThread(dbA, decision, "open", "decided", { choice: "Renew", reason: null }, { now: NOW })).toMatchObject({ ok: true });
  });

  it("bad input is refused by the database too (a direct RPC): blank or over-long decision, over-long reason, a decision on Not needed", async () => {
    const id = await seedThread(A, "open");
    const before = await snapshot();
    const bad: Array<[Resolution, { choice: string; reason: string | null } | null]> = [
      ["decided", null],
      ["decided", { choice: " ", reason: null }],
      ["decided", { choice: "x".repeat(301), reason: null }],
      ["decided", { choice: "Renew", reason: "y".repeat(2001) }],
      ["not_needed", { choice: "Renew", reason: null }],
    ];
    for (const [resolution, decision] of bad) {
      expect(await resolveThread(dbA, id, "open", resolution, decision, { now: NOW, logger: () => {} }), JSON.stringify(decision)).toMatchObject({ ok: false, code: "save_failed" });
    }
    expect(await snapshot()).toEqual(before);
    // The limits are inclusive and count characters, as typed.
    expect(await resolveThread(dbA, id, "open", "decided", { choice: "x".repeat(300), reason: "😀".repeat(2000) }, { now: NOW })).toMatchObject({ ok: true });
  });
});

describe("Undo of a resolution (D44, 12 s server window)", () => {
  it("undoing Decided restores the thread, appends 'undone' and deletes only that resolution's decision", async () => {
    const id = await seedThread(A, "open");
    const original = await state(id);
    // An earlier decision on the same thread (resolved, reopened in the past) is kept.
    const r1 = await resolveThread(dbA, id, "open", "decided", { choice: "First choice", reason: null }, { now: at(-60_000) });
    if (!r1.ok) throw new Error("resolve failed");
    await pg.query(`update threads set status = 'open', resolution = null, resolved_at = null where id = $1`, [id]);
    await pg.query(`insert into thread_events (user_id, thread_id, actor, type, before, after, created_at) values ($1, $2, 'user', 'reopened', '{}', '{}', $3)`, [A, id, at(-30_000).toISOString()]);

    const r2 = await resolveThread(dbA, id, "open", "decided", { choice: "Renewed with Provider A", reason: REASON }, { now: NOW });
    if (!r2.ok) throw new Error("resolve failed");
    expect((await decisions(id)).map((d) => d.choice)).toEqual(["First choice", "Renewed with Provider A"]);

    const u = await undoEvent(dbA, id, r2.event_id, { now: at(11_999) });
    expect(u).toMatchObject({ ok: true, undone_event_id: r2.event_id, undone_action: "resolve", to_status: "open" });
    expect(await state(id)).toEqual(original);
    expect((await decisions(id)).map((d) => d.choice)).toEqual(["First choice"]);
    expect((await events(id)).map((e) => e.type)).toEqual(["created", "resolved", "reopened", "resolved", "undone"]);
  });

  it("after 12 s Undo is refused and the decision stays", async () => {
    const id = await seedThread(A, "open");
    const r = await resolveThread(dbA, id, "open", "decided", { choice: "Renew", reason: null }, { now: NOW });
    if (!r.ok) throw new Error("resolve failed");
    expect(await undoEvent(dbA, id, r.event_id, { now: at(12_001) })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await decisions(id)).toHaveLength(1);
    expect(await undoEvent(dbA, id, r.event_id, { now: at(12_000) })).toMatchObject({ ok: true });
    expect(await decisions(id)).toEqual([]);
  });

  it("forgetting the thread removes its decisions (cascade)", async () => {
    const id = await seedThread(A, "open");
    await resolveThread(dbA, id, "open", "decided", { choice: "Renew", reason: "price" }, { now: NOW });
    await asUser(pg, A, () => pg.query(`select public.forget_thread($1, false)`, [id]));
    expect(await q(`select id from decisions`)).toEqual([]);
  });
});

describe("decisions write model: own-row reads only; writes only through thread_resolve", () => {
  it("B cannot resolve A's thread: not_found and nothing written", async () => {
    const id = await seedThread(A, "open");
    const before = await snapshot();
    expect(await resolveThread(dbB, id, "open", "decided", { choice: "forged", reason: null }, { now: NOW })).toMatchObject({ ok: false, code: "not_found" });
    expect(await snapshot()).toEqual(before);
  });

  it("the owner cannot insert, update or delete decisions directly", async () => {
    const id = await seedThread(A, "open");
    await resolveThread(dbA, id, "open", "decided", { choice: "Renew", reason: "price" }, { now: NOW });
    const [d] = await decisions(id);
    for (const sql of [
      `insert into decisions (user_id, thread_id, choice) values ('${A}', '${id}', 'forged')`,
      `update decisions set reason_user = 'rewritten' where id = '${d!.id}'`,
      `update decisions set reason_ai_summary = 'forged' where id = '${d!.id}'`,
      `delete from decisions where id = '${d!.id}'`,
    ]) {
      await expect(asUser(pg, A, () => pg.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
    expect((await decisions(id))[0]).toMatchObject({ choice: "Renew", reason_user: "price", reason_ai_summary: null });
  });

  it("RLS: the owner reads their decision; B reads none", async () => {
    const id = await seedThread(A, "open");
    await resolveThread(dbA, id, "open", "decided", { choice: "Renew", reason: null }, { now: NOW });
    expect((await asUser(pg, A, () => pg.query(`select choice from decisions`))).rows).toEqual([{ choice: "Renew" }]);
    expect((await asUser(pg, B, () => pg.query(`select choice from decisions`))).rows).toEqual([]);
  });

  it("thread_resolve: SECURITY DEFINER, search_path '', executable by authenticated only", async () => {
    const [r] = await q<{ definer: boolean; config: string[]; auth: boolean; anon: boolean }>(
      `select p.prosecdef as definer, p.proconfig as config,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('anon', p.oid, 'execute') as anon
       from pg_proc p where p.oid = 'public.thread_resolve(uuid, text, text, text, text, timestamptz)'::regprocedure`,
    );
    expect(r).toEqual({ definer: true, config: ['search_path=""'], auth: true, anon: false });
  });
});

describe("SQL thread_resolve agrees with TS transition()", () => {
  const kinds: ThreadKind[] = ["commitment", "request", "waiting_on", "admin", "decision"];
  const statuses: ThreadStatus[] = ["open", "waiting", "snoozed", "resolved", "dismissed"];
  const resolutions: Resolution[] = ["done", "decided", "not_needed"];

  it("for every status, kind and resolution: same validity, same state, same event, same decision; and the same Undo", async () => {
    let checked = 0;
    for (const kind of kinds)
      for (const status of statuses)
        for (const resolution of resolutions) {
          const id = await seedThread(A, status, kind);
          const s0 = await state(id);
          const decision = resolution === "decided" ? { choice: "Renew", reason: "price" } : undefined;
          const ts = transition(s0, { type: "resolve", resolution, decision }, { now: NOW });
          const sql = await resolveThread(dbA, id, status, resolution, decision ?? null, { now: NOW });
          const name = `${kind}/${status}/${resolution}`;
          expect(sql.ok, name).toBe(ts.ok);
          if (!ts.ok || !sql.ok) {
            expect(await state(id), name).toEqual(s0);
            continue;
          }
          expect(await state(id), name).toEqual(ts.thread);
          const ev = (await events(id)).at(-1)!;
          expect({ type: ev.type, actor: ev.actor, before: ev.before, after: ev.after }, name).toEqual(ts.event);
          const written = (await decisions(id)).map((d) => ({ type: "write_decision", choice: d.choice, reason: d.reason_user }));
          expect(written, name).toEqual(ts.effects);

          const tsUndo = transition(
            await state(id),
            { type: "undo", target: { id: ev.id, type: "resolved", actor: "user", before: ev.before, after: ev.after, created_at: new Date(ev.created_at).toISOString(), latest: true } },
            { now: at(5000) },
          );
          expect(await undoEvent(dbA, id, ev.id, { now: at(5000) }), name).toMatchObject({ ok: true });
          if (!tsUndo.ok) throw new Error(name);
          expect(await state(id), name).toEqual(s0);
          expect(tsUndo.effects.length > 0, name).toBe(resolution === "decided");
          expect(await decisions(id), name).toEqual([]);
          checked++;
        }
    // 4 kinds × 3 statuses × 3 resolutions, plus decision × 3 statuses × (decided, not_needed).
    expect(checked).toBe(36 + 6);
  });
});
