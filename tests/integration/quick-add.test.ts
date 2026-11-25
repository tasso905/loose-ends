import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordedModel, Recording } from "@/lib/ai/fake";
import { quickAddWrittenOn } from "@/lib/capture/quickAddInput";
import { readExtraction, runExtraction, startExtraction, startQuickAdd, type RpcDb } from "@/lib/extraction/service";
import type { LogEvent, LogProps } from "@/lib/log";
import { autoCreateQuickAdd, quickAddRoute, readQuickAddResult, reviewableProposals, undoQuickAdd } from "@/lib/review/quickAdd";
import { createFieldsFromPayload } from "@/lib/review/tray";
import { markDone } from "@/lib/threads/service";
import { transition } from "@/lib/threads/transition";
import { migratedDb, rpcAs } from "./pglite";

/**
 * S14 (F4 quick add): auto-create and its undo against the real migrations in PGlite, with
 * synthetic recordings. No network, no live model.
 */

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
/** Wed Nov 11 2026, 10:00 in New York: "Friday" is Fri Nov 13. */
const NOW = new Date("2026-11-11T15:00:00Z");
const SOON = new Date(NOW.getTime() + 2_000);

const fixture = (name: string) =>
  Recording.parse(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "llm", `${name}.extract.json`), "utf8")));

/** F4 acceptance example 1, as a model would answer on Wed Nov 11 (the date agrees with chrono). */
const MIKE: Recording = Recording.parse({
  name: "test-quick-add-mike",
  task: "extract",
  input: "Send Mike the proposal Friday",
  responses: [
    {
      source_summary: "Quick add: the user's own task",
      participants: [{ name: "Mike", is_user: "no" }],
      items: [
        {
          type: "commitment", title: "Send the proposal to Mike", owner: "user", counterparty: "Mike",
          action: "Send the proposal to Mike", date_text: "Friday", date_iso: "2026-11-13", amount_text: null,
          certainty: "explicit", uncertainty_notes: [], matches_thread_id: null,
          evidence: [{ quote: "Send Mike the proposal Friday", speaker: null }],
        },
      ],
      brief: null,
    },
  ],
});
/** F4 acceptance example 2: the existing synthetic recording (a malformed first answer, then a valid one). */
const ACME = fixture("retry-once");
const ACME_NOW = new Date("2026-10-05T15:00:00Z");
const MAYBE = fixture("quick-add-maybe");
const MIXED = fixture("quick-add-mixed");
const PLUMBER = fixture("quick-add-plumber");

let pg: PGlite;
let dbA: RpcDb;
let dbB: RpcDb;
const logger = vi.fn<(event: LogEvent, props: LogProps) => void>();

beforeEach(async () => {
  pg = await migratedDb();
  await pg.exec(`insert into auth.users values ('${A}', 'sam@example.com', '{"full_name":"Sam"}'), ('${B}', 'b@example.com', '{}')`);
  await pg.exec(`update profiles set timezone = 'America/New_York'`);
  dbA = rpcAs(pg, A);
  dbB = rpcAs(pg, B);
  logger.mockReset();
});

const q = async <T,>(sql: string) => (await pg.query<T>(sql)).rows;
const count = async (sql: string) => (await q<{ n: number }>(`select count(*)::int as n from ${sql}`))[0]!.n;

/** A quick add as `db`'s user, as submitQuickAdd starts it (kind quick_add, written today), then the recording. */
async function quickAdd(db: RpcDb, rec: Recording, now = NOW) {
  const writtenOn = quickAddWrittenOn(now, "America/New_York");
  const start = await startExtraction(db, { text: rec.input!, title: null, writtenOn, kind: "quick_add" }, { now, logger });
  if (!start.ok) throw new Error("start failed");
  const outcome = await runExtraction(db, start.extractionId, { model: createRecordedModel({ recordings: [rec] }), logger });
  expect(outcome).toBe("succeeded");
  return { extractionId: start.extractionId, sourceId: start.sourceId };
}

async function snapshot() {
  return {
    threads: await count("threads"),
    events: await count("thread_events"),
    threadEvidence: await count("evidence where thread_id is not null"),
    evidence: await count("evidence"),
    suppressions: await count("suppressions"),
    statuses: await q<{ review_status: string }>(`select review_status from extraction_items order by id`),
  };
}

describe("quick_add_auto_create", () => {
  it("F4 example 1: 'Send Mike the proposal Friday' creates one Open thread due the coming Friday", async () => {
    const m = await quickAdd(dbA, MIKE);
    const res = await autoCreateQuickAdd(dbA, m.extractionId, { now: SOON });
    if (!res.ok) throw new Error(`auto-create refused: ${res.code}`);
    expect(res.created).toHaveLength(1);
    const c = res.created[0]!;
    expect(c).toMatchObject({ band: "high", title: "Send the proposal to Mike" });

    const [t] = await q<Record<string, unknown>>(`select * from threads where id = '${c.thread_id}'`);
    expect(t).toMatchObject({ status: "open", kind: "commitment", next_action: "Send the proposal to Mike", due_certainty: "explicit", primary_source_id: m.sourceId });
    // Due Friday Nov 13 at the end of the day in the user's timezone (date-only, chrono re-resolved).
    expect(new Date(t!.due_at as string).toISOString()).toBe("2026-11-14T04:59:00.000Z");

    const events = await q<{ actor: string; type: string; before: unknown; after: Record<string, unknown>; created_at: string }>(
      `select actor, type, before, after, created_at from thread_events where thread_id = '${c.thread_id}'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "ai", type: "created", before: null });
    expect(events[0]!.after).toMatchObject({ via: "auto_create", extraction_item_id: c.item_id });
    expect(new Date(events[0]!.created_at).toISOString()).toBe(SOON.toISOString());

    const [item] = await q<{ review_status: string; thread_id: string }>(`select review_status, thread_id from extraction_items where id = '${c.item_id}'`);
    expect(item).toEqual({ review_status: "auto_created", thread_id: c.thread_id });
    expect(await count(`evidence where thread_id = '${c.thread_id}' and extraction_item_id = '${c.item_id}'`)).toBe(1);

    const view = (await readExtraction(dbA, m.extractionId, { now: SOON }))!;
    expect(quickAddRoute(res.created, view.proposals)).toBe("stay");
  });

  it("the thread row and event equal transition(create, via auto_create, actor ai)", async () => {
    const m = await quickAdd(dbA, MIKE);
    const res = await autoCreateQuickAdd(dbA, m.extractionId, { now: SOON });
    if (!res.ok) throw new Error("refused");
    const view = (await readExtraction(dbA, m.extractionId, { now: SOON }))!;
    const c = res.created[0]!;
    const p = view.proposals.find((x) => x.id === c.item_id)!;
    const fields = createFieldsFromPayload(p.payload, { sourceId: m.sourceId, confidence: p.confidence })!;
    const ts = transition(null, { type: "create", via: "auto_create", extractionItemId: p.id, fields }, { actor: "ai", now: SOON });
    if (!ts.ok) throw new Error("ts invalid");
    const [row] = await q<Record<string, unknown>>(
      `select title, kind, next_action, counterparty, due_at, due_certainty, due_time_known, consequence, consequence_basis,
              status, resolution, waiting_on, expected_by, snoozed_until, resolved_at, primary_source_id, confidence::float8 as confidence
       from threads where id = '${c.thread_id}'`,
    );
    const iso = (v: unknown) => (v === null ? null : new Date(v as string).toISOString());
    expect({ ...row, due_at: iso(row!.due_at), expected_by: iso(row!.expected_by), snoozed_until: iso(row!.snoozed_until), resolved_at: iso(row!.resolved_at) }).toEqual({
      ...ts.thread,
      due_at: iso(ts.thread!.due_at),
    });
    const [ev] = await q<{ actor: string; after: unknown }>(`select actor, after from thread_events where thread_id = '${c.thread_id}'`);
    expect(ev!.actor).toBe(ts.event!.actor);
    expect(ev!.after).toEqual(ts.event!.after);
    // transition() refuses an auto-create by the user: only the AI's quick-add create skips review.
    expect(transition(null, { type: "create", via: "auto_create", extractionItemId: p.id, fields }, { actor: "user" }).ok).toBe(false);
  });

  it("F4 example 2: 'Acme said they'd pay by the 15th' creates a Waiting thread", async () => {
    const m = await quickAdd(dbA, ACME, ACME_NOW);
    const res = await autoCreateQuickAdd(dbA, m.extractionId, { now: ACME_NOW });
    if (!res.ok) throw new Error("refused");
    expect(res.created).toHaveLength(1);
    const [t] = await q<Record<string, unknown>>(`select status, kind, waiting_on, expected_by from threads where id = '${res.created[0]!.thread_id}'`);
    expect(t).toMatchObject({ status: "waiting", kind: "waiting_on", waiting_on: "Acme" });
    expect(t!.expected_by).not.toBeNull();
  });

  it("Medium proposals are never auto-created: they stay pending for the tray (rule 2, D9)", async () => {
    const m = await quickAdd(dbA, MAYBE);
    const before = await snapshot();
    const res = await autoCreateQuickAdd(dbA, m.extractionId, { now: SOON });
    expect(res).toMatchObject({ ok: true, created: [] });
    expect(await snapshot()).toEqual(before);
    const view = (await readExtraction(dbA, m.extractionId, { now: SOON }))!;
    expect(view.proposals.map((p) => [p.band, p.reviewStatus])).toEqual([["medium", "pending"]]);
    expect(quickAddRoute([], view.proposals)).toBe("review");
  });

  it("mixed: the High item becomes a thread, the Medium one goes to the tray, and the tray shows only it", async () => {
    const m = await quickAdd(dbA, MIXED);
    const res = await autoCreateQuickAdd(dbA, m.extractionId, { now: SOON });
    if (!res.ok) throw new Error("refused");
    expect(res.created.map((c) => c.title)).toEqual(["Call the bank about the card"]);
    const view = (await readExtraction(dbA, m.extractionId, { now: SOON }))!;
    expect(quickAddRoute(res.created, view.proposals)).toBe("review");
    expect(reviewableProposals(view.proposals).map((p) => [p.band, p.reviewStatus, p.payload.item.title])).toEqual([
      ["medium", "pending", "Book a dentist visit"],
    ]);
  });

  it("is refused for a paste, and a second call creates nothing more", async () => {
    const paste = await startExtraction(dbA, { text: PLUMBER.input!, title: null, writtenOn: null }, { now: NOW, logger });
    if (!paste.ok) throw new Error("start failed");
    await runExtraction(dbA, paste.extractionId, { model: createRecordedModel({ recordings: [PLUMBER] }), logger });
    expect(await autoCreateQuickAdd(dbA, paste.extractionId, { now: SOON })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await count("threads")).toBe(0);

    const m = await quickAdd(dbA, PLUMBER);
    const first = await autoCreateQuickAdd(dbA, m.extractionId, { now: SOON });
    expect(first.ok && first.created.length).toBe(1);
    const after = await snapshot();
    expect(await autoCreateQuickAdd(dbA, m.extractionId, { now: SOON })).toMatchObject({ ok: true, created: [] });
    expect(await snapshot()).toEqual(after);
  });

  it("another user's extraction is not found and nothing is written", async () => {
    const m = await quickAdd(dbA, PLUMBER);
    const before = await snapshot();
    expect(await autoCreateQuickAdd(dbB, m.extractionId, { now: SOON })).toMatchObject({ ok: false, code: "not_found" });
    expect(await snapshot()).toEqual(before);
  });
});

describe("quick_add_undo (F4: undo removes the thread and its events)", () => {
  async function created(rec = PLUMBER) {
    const m = await quickAdd(dbA, rec);
    const res = await autoCreateQuickAdd(dbA, m.extractionId, { now: SOON });
    if (!res.ok) throw new Error("refused");
    return { ...m, created: res.created };
  }
  const pairs = (c: { thread_id: string; event_id: number }[]) => c.map((x) => ({ threadId: x.thread_id, eventId: x.event_id }));

  it("removes the thread and its events; the proposal keeps its evidence and is rejected without a suppression", async () => {
    const m = await created();
    const c = m.created[0]!;
    const res = await undoQuickAdd(dbA, pairs(m.created), { now: new Date(SOON.getTime() + 8_000) });
    expect(res).toEqual({ ok: true, removed: 1 });
    expect(await count("threads")).toBe(0);
    expect(await count("thread_events")).toBe(0);
    expect(await q(`select review_status, thread_id from extraction_items where id = '${c.item_id}'`)).toEqual([{ review_status: "rejected", thread_id: null }]);
    expect(await count(`evidence where extraction_item_id = '${c.item_id}' and thread_id is null`)).toBe(1);
    expect(await count("suppressions")).toBe(0);

    // The same line typed again is proposed and auto-created again (nothing suppresses it).
    const again = await quickAdd(dbA, PLUMBER);
    const res2 = await autoCreateQuickAdd(dbA, again.extractionId, { now: SOON });
    expect(res2.ok && res2.created.length).toBe(1);
  });

  it("is accepted at 12 s and refused after it, with nothing changed", async () => {
    const m = await created();
    const before = await snapshot();
    expect(await undoQuickAdd(dbA, pairs(m.created), { now: new Date(SOON.getTime() + 12_001) })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await snapshot()).toEqual(before);
    expect(await undoQuickAdd(dbA, pairs(m.created), { now: new Date(SOON.getTime() + 12_000) })).toEqual({ ok: true, removed: 1 });
  });

  it("is refused once the user has acted on the thread (Done), with nothing changed", async () => {
    const m = await created();
    const done = await markDone(dbA, m.created[0]!.thread_id, "open", { now: new Date(SOON.getTime() + 1_000) });
    expect(done.ok).toBe(true);
    const before = await snapshot();
    expect(await undoQuickAdd(dbA, pairs(m.created), { now: new Date(SOON.getTime() + 2_000) })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await snapshot()).toEqual(before);
  });

  it("is refused for a thread accepted from the review tray, and for a wrong event id", async () => {
    const m = await created(MAYBE);
    expect(m.created).toHaveLength(0);
    const view = (await readExtraction(dbA, m.extractionId, { now: SOON }))!;
    const { acceptProposals } = await import("@/lib/review/service");
    const acc = await acceptProposals(dbA, m.extractionId, [view.proposals[0]!.id], { now: SOON });
    if (!acc.ok) throw new Error("accept failed");
    const threadId = acc.created[0]!.thread_id!;
    const id = (await q<{ id: number }>(`select id::int as id from thread_events where thread_id = '${threadId}'`))[0]?.id;
    const before = await snapshot();
    expect(await undoQuickAdd(dbA, [{ threadId, eventId: id! }], { now: SOON })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await undoQuickAdd(dbA, [{ threadId, eventId: id! + 999 }], { now: SOON })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await snapshot()).toEqual(before);
  });

  it("is all or nothing across threads, and another user's thread is not found", async () => {
    const one = await created();
    const two = await created(MIXED);
    await markDone(dbA, two.created[0]!.thread_id, "open", { now: new Date(SOON.getTime() + 1_000) });
    const before = await snapshot();
    expect(await undoQuickAdd(dbA, [...pairs(one.created), ...pairs(two.created)], { now: new Date(SOON.getTime() + 2_000) })).toMatchObject({
      ok: false,
      code: "invalid_transition",
    });
    expect(await undoQuickAdd(dbB, pairs(one.created), { now: new Date(SOON.getTime() + 2_000) })).toMatchObject({ ok: false, code: "not_found" });
    expect(await snapshot()).toEqual(before);
  });

  it("a forged call with mismatched arrays is a save failure (22023), nothing written", async () => {
    const m = await created();
    const before = await snapshot();
    const res = await dbA.rpc("quick_add_undo", { p_thread_ids: [m.created[0]!.thread_id], p_event_ids: [], p_now: SOON.toISOString() });
    expect(res.error).toMatchObject({ code: "22023" });
    expect(await snapshot()).toEqual(before);
  });
});

describe("clock guard", () => {
  it("refuses a p_now far from the database clock", async () => {
    const guarded = await migratedDb({ clockGuard: true });
    await guarded.exec(`insert into auth.users values ('${A}', 'sam@example.com', '{}')`);
    const db = rpcAs(guarded, A);
    const far = new Date("2020-01-01T00:00:00Z");
    expect(await autoCreateQuickAdd(db, "00000000-0000-0000-0000-0000000000ff", { now: far, logger })).toMatchObject({ ok: false, code: "save_failed" });
    expect(
      await undoQuickAdd(db, [{ threadId: "00000000-0000-0000-0000-0000000000ff", eventId: 1 }], { now: far }),
    ).toMatchObject({ ok: false, code: "invalid_transition" });
  });
});

describe("start_quick_add: one submission key, one source (S14 D2)", () => {
  const KEY = "00000000-0000-4000-8000-0000000000c1";
  const start = (db: RpcDb, key = KEY, text = PLUMBER.input!, env: Record<string, string> = {}) =>
    startQuickAdd(db, { key, text, writtenOn: "2026-11-11" }, { now: NOW, logger, env });
  const model = () => createRecordedModel({ recordings: [PLUMBER] });

  it("a replay returns the same extraction: not stored, counted or extracted again, and the same threads to undo", async () => {
    const first = await start(dbA);
    if (!first.ok) throw new Error("start failed");
    expect(first.replayed).toBe(false);
    expect(await runExtraction(dbA, first.extractionId, { model: model(), logger })).toBe("succeeded");
    await autoCreateQuickAdd(dbA, first.extractionId, { now: SOON });
    const a = await readQuickAddResult(dbA, first.extractionId, { now: SOON });

    const again = await start(dbA);
    expect(again).toEqual({ ...first, replayed: true });
    const m = model();
    expect(await runExtraction(dbA, first.extractionId, { model: m, logger })).toBe("skipped");
    expect(m.doGenerateCalls).toHaveLength(0);
    expect(await autoCreateQuickAdd(dbA, first.extractionId, { now: SOON })).toMatchObject({ ok: true, created: [] });
    const b = await readQuickAddResult(dbA, first.extractionId, { now: new Date(SOON.getTime() + 3_000) });
    expect(a).toMatchObject({ age_ms: 0, untouched: true });
    expect(b).toEqual({ ...a, age_ms: 3_000 });
    expect(await q("select extractions from usage_counters")).toEqual([{ extractions: 1 }]);
    expect([await count("sources"), await count("extractions"), await count("threads")]).toEqual([1, 1, 1]);
    expect((await undoQuickAdd(dbA, b!.created.map((c) => ({ threadId: c.thread_id, eventId: c.event_id })), { now: SOON })).ok).toBe(true);
    // Undone: a late replay brings nothing back.
    await start(dbA);
    await autoCreateQuickAdd(dbA, first.extractionId, { now: SOON });
    expect((await readQuickAddResult(dbA, first.extractionId, { now: SOON }))!.created).toEqual([]);
    expect(await count("threads")).toBe(0);
  });

  it("while the first request is running, a replay gets its extraction and cannot run it", async () => {
    const first = await start(dbA);
    if (!first.ok) throw new Error("start failed");
    await dbA.rpc("set_extraction_stage", { p_extraction_id: first.extractionId, p_stage: "finding" });
    expect(await start(dbA)).toEqual({ ...first, replayed: true });
    const m = model();
    expect(await runExtraction(dbA, first.extractionId, { model: m, logger })).toBe("skipped");
    expect(m.doGenerateCalls).toHaveLength(0);
  });

  it("at the daily limit a replay still answers; a new key is refused and can be used later", async () => {
    const first = await start(dbA);
    await pg.exec("update usage_counters set extractions = 30");
    expect(await start(dbA)).toEqual({ ...first, replayed: true });
    const other = "00000000-0000-4000-8000-0000000000c2";
    expect(await start(dbA, other)).toMatchObject({ ok: false, unknown: false, error: { error: { code: "rate_limited" } } });
    await pg.exec("update usage_counters set extractions = 0");
    expect(await start(dbA, other)).toMatchObject({ ok: true, replayed: false });
  });

  it("with the AI budget closed, a replay still answers and a new key saves nothing", async () => {
    const first = await start(dbA);
    const closed = { DAILY_AI_BUDGET_USD: "0" };
    expect(await start(dbA, KEY, PLUMBER.input!, closed)).toEqual({ ...first, replayed: true });
    expect(await start(dbA, "00000000-0000-4000-8000-0000000000c3", PLUMBER.input!, closed)).toMatchObject({
      ok: false, unknown: false, error: { error: { code: "save_failed" } },
    });
    expect(await count("sources")).toBe(1);
  });

  it("a key is the user's own and belongs to one text; deleting the source removes it (rule 8)", async () => {
    const first = await start(dbA);
    const b = await start(dbB);
    if (!first.ok || !b.ok) throw new Error("start failed");
    expect(b.replayed).toBe(false);
    expect(b.extractionId).not.toBe(first.extractionId);
    expect(await readQuickAddResult(dbB, first.extractionId, { now: SOON })).toMatchObject({ created: [], untouched: false });
    expect(await start(dbA, KEY, "Another line")).toMatchObject({ ok: false, unknown: false });
    await pg.exec(`delete from sources where id = '${first.sourceId}'`);
    expect(await count(`private.quick_add_submissions where user_id = '${A}'`)).toBe(0);
  });

  it("a thread the user acted on is no longer undoable", async () => {
    const m = await quickAdd(dbA, PLUMBER);
    const res = await autoCreateQuickAdd(dbA, m.extractionId, { now: SOON });
    if (!res.ok) throw new Error("refused");
    await markDone(dbA, res.created[0]!.thread_id, "open", { now: SOON });
    expect(await readQuickAddResult(dbA, m.extractionId, { now: SOON })).toMatchObject({ untouched: false, created: [{ title: PLUMBER.input }] });
  });

  it("no answer from the database is `unknown`; a refusal is not", async () => {
    const dropped: RpcDb = { rpc: async () => ({ data: null, error: { code: "", message: "fetch failed" } }) };
    expect(await start(dropped)).toMatchObject({ ok: false, unknown: true });
    const refused: RpcDb = { rpc: async () => ({ data: null, error: { code: "22023" } }) };
    expect(await start(refused)).toMatchObject({ ok: false, unknown: false });
  });
});
