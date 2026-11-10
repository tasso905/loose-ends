import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordedModel, Recording } from "@/lib/ai/fake";
import { readExtraction, runExtraction, startExtraction, type RpcDb } from "@/lib/extraction/service";
import type { LogEvent, LogProps } from "@/lib/log";
import { acceptProposals } from "@/lib/review/service";
import type { ThreadStatus } from "@/lib/schemas";
import { threadAction, undoEvent, type StatusAction } from "@/lib/threads/service";
import { ALLOWED_FROM, transition, type ThreadState } from "@/lib/threads/transition";
import { asUser, migratedDb, rpcAs } from "./pglite";

/**
 * Lead-tester, S12 (F9): independent checks of Mark waiting, Snooze, Dismiss, Back to me, Wake now,
 * Reopen, Edit and their Undo against the real migrations in PGlite, with the recorded (synthetic)
 * Mike email. No network, no live model.
 *
 * The F9 acceptance criterion "Dismissed threads never reappear from re-extraction of the same
 * source" is checked end to end here: paste → accept → Dismiss → paste the same text again through
 * the real extraction service, not just by counting suppression rows.
 */

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const NOW = new Date("2026-10-05T15:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const LATER = "2026-10-09T13:00:00.000Z";

const MIKE = Recording.parse(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "llm", "mike-email.extract.json"), "utf8")));

let pg: PGlite;
let dbA: RpcDb;
let dbB: RpcDb;
const logger = vi.fn<(event: LogEvent, props: LogProps) => void>();

beforeEach(async () => {
  pg = await migratedDb();
  await pg.exec(`insert into auth.users values ('${A}', 'sam@example.com', '{"full_name":"Sam"}'), ('${B}', 'b@example.com', '{}')`);
  dbA = rpcAs(pg, A);
  dbB = rpcAs(pg, B);
  logger.mockReset();
});

const q = async <T,>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;

/** Paste the Mike email as A and run the recorded extraction; returns the proposals' titles by band. */
async function paste(now = NOW) {
  const start = await startExtraction(dbA, { text: MIKE.input!, title: null, writtenOn: "2026-10-05" }, { now, logger });
  if (!start.ok) throw new Error(`start failed: ${start.error.error.code}`);
  expect(await runExtraction(dbA, start.extractionId, { model: createRecordedModel({ recordings: [MIKE] }), logger })).toBe("succeeded");
  const view = (await readExtraction(dbA, start.extractionId, { now }))!;
  return { extractionId: start.extractionId, sourceId: start.sourceId, proposals: view.proposals };
}

/** Paste, accept the High proposal, return its thread id and title. */
async function acceptHigh() {
  const p = await paste();
  const high = p.proposals.find((x) => x.band === "high")!;
  const res = await acceptProposals(dbA, p.extractionId, [high.id], { now: NOW });
  expect(res).toMatchObject({ ok: true });
  const [row] = await q<{ thread_id: string }>(`select thread_id from extraction_items where id = $1`, [high.id]);
  return { threadId: row!.thread_id, title: high.payload.item.title, sourceId: p.sourceId };
}

const act = (id: string, from: ThreadStatus, action: StatusAction, now = NOW, db = dbA) => threadAction(db, id, from, action, { now });
const titles = (ps: Array<{ payload: { item: { title: string } } }>) => ps.map((p) => p.payload.item.title);

describe("F9: a dismissed thread never reappears from re-extraction of the same source (end to end)", () => {
  it("paste → accept → Dismiss → paste again: the dismissed item is not proposed", async () => {
    const { threadId, title } = await acceptHigh();
    expect(await act(threadId, "open", { type: "dismiss" })).toMatchObject({ ok: true, to_status: "dismissed" });
    const again = await paste(at(60_000));
    expect(titles(again.proposals)).not.toContain(title);
    // The other proposal (Lunch with Mike) is unaffected.
    expect(titles(again.proposals)).toContain("Lunch with Mike");
  });

  it("from waiting and from snoozed too", async () => {
    for (const [from, prep] of [
      ["waiting", { type: "mark_waiting", waitingOn: "Mike", expectedBy: null }],
      ["snoozed", { type: "snooze", until: LATER }],
    ] as const) {
      pg = await migratedDb();
      await pg.exec(`insert into auth.users values ('${A}', 'sam@example.com', '{}')`);
      dbA = rpcAs(pg, A);
      const { threadId, title } = await acceptHigh();
      expect(await act(threadId, "open", prep)).toMatchObject({ ok: true, to_status: from });
      expect(await act(threadId, from, { type: "dismiss" }, at(20_000))).toMatchObject({ ok: true });
      expect(titles((await paste(at(60_000))).proposals), from).not.toContain(title);
    }
  });

  it("Reopen removes the suppression: the same paste proposes it again", async () => {
    const { threadId, title } = await acceptHigh();
    await act(threadId, "open", { type: "dismiss" });
    expect(await act(threadId, "dismissed", { type: "reopen" }, at(20_000))).toMatchObject({ ok: true, to_status: "open" });
    expect(titles((await paste(at(60_000))).proposals)).toContain(title);
  });

  it("Undo of Dismiss removes the suppression: the same paste proposes it again", async () => {
    const { threadId, title } = await acceptHigh();
    const d = await act(threadId, "open", { type: "dismiss" });
    if (!d.ok || d.event_id === null) throw new Error("dismiss failed");
    expect(await undoEvent(dbA, threadId, d.event_id, { now: at(5_000) })).toMatchObject({ ok: true, undone_action: "dismiss", to_status: "open" });
    expect(await q(`select * from suppressions`)).toEqual([]);
    expect(titles((await paste(at(60_000))).proposals)).toContain(title);
  });

  it("after Delete source only, Dismiss still suppresses through the kept hash", async () => {
    const { threadId, title, sourceId } = await acceptHigh();
    const del = await asUser(pg, A, () => pg.query<{ r: { ok: boolean } }>(`select public.delete_source('${sourceId}', false) as r`));
    expect(del.rows[0]!.r).toMatchObject({ ok: true });
    expect(await q(`select id from extraction_items where thread_id = $1`, [threadId])).toEqual([]);
    expect(await q<{ status: string }>(`select status from threads where id = $1`, [threadId])).toEqual([{ status: "open" }]);
    expect(await act(threadId, "open", { type: "dismiss" }, at(10_000))).toMatchObject({ ok: true });
    expect(titles((await paste(at(60_000))).proposals)).not.toContain(title);
  });

  // KNOWN DEFECT (lead-tester, S12): suppressions are unique per (user, hash) and linked to the first
  // thread dismissed; Reopen (or Undo) of that thread deletes the row although another dismissed
  // thread with the same hash still relies on it. `it.fails` keeps the suite green while the defect
  // stands; once it is fixed this test fails and must become a plain `it`.
  it.fails("two dismissed threads with the same item hash: reopening one keeps the other suppressed", async () => {
    // Accept the High item, then paste the same text again and accept it again (nothing suppresses an
    // accepted item, so it is proposed a second time) → two threads from one hash.
    const first = await acceptHigh();
    const second = await acceptHigh();
    expect(second.threadId).not.toBe(first.threadId);
    await act(first.threadId, "open", { type: "dismiss" }, at(1_000));
    await act(second.threadId, "open", { type: "dismiss" }, at(2_000));
    await act(first.threadId, "dismissed", { type: "reopen" }, at(30_000));
    // `second` is still dismissed, so its item must stay suppressed (F9 acceptance).
    expect(titles((await paste(at(60_000))).proposals)).not.toContain(first.title);
  });
});

describe("Undo (D44) beyond the developer's cases", () => {
  it("a second Undo of the same event is refused, and so is Undo after a later action", async () => {
    const { threadId } = await acceptHigh();
    const s = await act(threadId, "open", { type: "snooze", until: LATER });
    if (!s.ok || s.event_id === null) throw new Error("snooze failed");
    expect(await undoEvent(dbA, threadId, s.event_id, { now: at(1_000) })).toMatchObject({ ok: true });
    expect(await undoEvent(dbA, threadId, s.event_id, { now: at(2_000) })).toMatchObject({ ok: false, code: "invalid_transition" });

    const w = await act(threadId, "open", { type: "mark_waiting", waitingOn: "Mike", expectedBy: null }, at(3_000));
    if (!w.ok || w.event_id === null) throw new Error("mark waiting failed");
    await act(threadId, "waiting", { type: "edit", fields: { title: "Renamed" } }, at(4_000));
    expect(await undoEvent(dbA, threadId, w.event_id, { now: at(5_000) })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await q<{ status: string; title: string }>(`select status, title from threads where id = $1`, [threadId])).toEqual([{ status: "waiting", title: "Renamed" }]);
  });

  it("another user cannot undo A's action (not_found, nothing written)", async () => {
    const { threadId } = await acceptHigh();
    const d = await act(threadId, "open", { type: "dismiss" });
    if (!d.ok || d.event_id === null) throw new Error("dismiss failed");
    const before = await q(`select * from thread_events order by id`);
    expect(await undoEvent(dbB, threadId, d.event_id, { now: at(1_000) })).toMatchObject({ ok: false, code: "not_found" });
    expect(await q(`select * from thread_events order by id`)).toEqual(before);
    expect(await q<{ n: number }>(`select count(*)::int n from suppressions`)).toEqual([{ n: 1 }]);
  });

  it("Undo of Edit restores an AI-inferred date's certainty exactly (Assumed comes back)", async () => {
    const { threadId } = await acceptHigh();
    const [before] = await q<{ due_at: string | null; due_certainty: string; due_time_known: boolean }>(
      `select due_at, due_certainty, due_time_known from threads where id = $1`,
      [threadId],
    );
    const e = await act(threadId, "open", { type: "edit", fields: { due_at: LATER, due_time_known: true } });
    if (!e.ok || e.event_id === null) throw new Error("edit failed");
    expect(await q(`select due_certainty from threads where id = $1`, [threadId])).toEqual([{ due_certainty: "explicit" }]);
    await undoEvent(dbA, threadId, e.event_id, { now: at(1_000) });
    expect(await q(`select due_at, due_certainty, due_time_known from threads where id = $1`, [threadId])).toEqual([before]);
  });
});

describe("Lifecycle table: every action outside ALLOWED_FROM is invalid_transition from every status (SQL)", () => {
  const actions: Array<[keyof typeof ALLOWED_FROM, StatusAction]> = [
    ["mark_waiting", { type: "mark_waiting", waitingOn: "Mike", expectedBy: null }],
    ["snooze", { type: "snooze", until: LATER }],
    ["dismiss", { type: "dismiss" }],
    ["back_to_me", { type: "back_to_me" }],
    ["wake", { type: "wake" }],
    ["reopen", { type: "reopen" }],
  ];
  const statuses: ThreadStatus[] = ["open", "waiting", "snoozed", "resolved", "dismissed"];

  async function seed(status: ThreadStatus) {
    const [r] = await q<{ id: string }>(
      `insert into threads (user_id, title, kind, status, resolution, waiting_on, snoozed_until, resolved_at)
       values ($1, 'T', 'commitment', $2, $3, $4, $5, $6) returning id`,
      [A, status, status === "resolved" ? "done" : null, status === "waiting" ? "Mike" : null, status === "snoozed" ? LATER : null, status === "resolved" ? NOW.toISOString() : null],
    );
    return r!.id;
  }

  it("matches the PRD table and writes nothing on refusal", async () => {
    let refused = 0;
    for (const [name, action] of actions)
      for (const status of statuses) {
        const id = await seed(status);
        const before = await q(`select * from threads where id = $1`, [id]);
        const res = await act(id, status, action);
        if (ALLOWED_FROM[name].includes(status)) {
          expect(res.ok, `${name} from ${status}`).toBe(true);
        } else {
          refused++;
          expect(res, `${name} from ${status}`).toMatchObject({ ok: false, code: "invalid_transition" });
          expect(await q(`select * from threads where id = $1`, [id])).toEqual(before);
          expect(await q(`select id from thread_events where thread_id = $1`, [id])).toEqual([]);
        }
      }
    // Every status has at least one refused action.
    expect(refused).toBeGreaterThanOrEqual(statuses.length);
  });
});

describe("SQL agrees with TS transition() on Edit cases the developer's matrix leaves out", () => {
  const statuses: ThreadStatus[] = ["open", "waiting", "snoozed", "resolved", "dismissed"];
  const edits: Array<Record<string, unknown>> = [
    { consequence: "Mike can't send it to the board" },
    { consequence: null },
    { kind: "waiting_on" },
    { kind: "decision" },
    { due_time_known: true },
    { due_at: null },
    { expected_by: null },
    { waiting_on: "Ana", expected_by: LATER },
    { title: "Same", next_action: "x", counterparty: null, consequence: "y", kind: "admin" },
  ];

  async function seed(status: ThreadStatus, withDue: boolean) {
    const [r] = await q<{ id: string }>(
      `insert into threads (user_id, title, kind, next_action, counterparty, due_at, due_certainty, consequence, consequence_basis,
                            status, resolution, waiting_on, expected_by, snoozed_until, resolved_at)
       values ($1, 'T', 'commitment', 'Send it', 'Mike', $2, $3, 'Board meets Monday', 'interpretation', $4, $5, $6, $7, $8, $9) returning id`,
      [
        A,
        withDue ? "2026-10-10T03:59:00.000Z" : null,
        withDue ? "inferred" : "none",
        status,
        status === "resolved" ? "done" : null,
        status === "waiting" ? "Mike" : null,
        status === "waiting" ? "2026-10-08T16:00:00.000Z" : null,
        status === "snoozed" ? LATER : null,
        status === "resolved" ? "2026-10-05T14:00:00.000Z" : null,
      ],
    );
    return r!.id;
  }
  const state = async (id: string) =>
    (await q<{ s: ThreadState }>(`select private.thread_state(t) as s from threads t where id = $1`, [id]))[0]!.s;

  it("same validity and same resulting state", async () => {
    let n = 0;
    for (const fields of edits)
      for (const status of statuses)
        for (const withDue of [true, false]) {
          const id = await seed(status, withDue);
          const s0 = await state(id);
          const ts = transition(s0, { type: "edit", fields }, { now: NOW });
          const sql = await act(id, status, { type: "edit", fields });
          const name = `${JSON.stringify(fields)} ${status} due=${withDue}`;
          expect(sql.ok, name).toBe(ts.ok);
          expect(await state(id), name).toEqual(ts.ok ? ts.thread : s0);
          n++;
        }
    expect(n).toBe(edits.length * statuses.length * 2);
  });
});
