/**
 * Lead-tester S14: F4's two acceptance examples on a fixed Wednesday clock (Nov 11 2026, 10:00 New
 * York), date disagreement, unusable High items and the first-attempt rule, on the real migrations
 * in PGlite. Synthetic recordings; no network.
 */
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { createRecordedModel, Recording } from "@/lib/ai/fake";
import { quickAddWrittenOn } from "@/lib/capture/quickAddInput";
import { retryExtraction, runExtraction, startExtraction, type RpcDb } from "@/lib/extraction/service";
import { autoCreateQuickAdd } from "@/lib/review/quickAdd";
import { migratedDb, rpcAs } from "./pglite";

const A = "00000000-0000-0000-0000-00000000000a";
const WED = new Date("2026-11-11T15:00:00Z");
const TZ = "America/New_York";
const quiet = () => {};

let pg: PGlite;
let db: RpcDb;
beforeEach(async () => {
  pg = await migratedDb();
  await pg.exec(`insert into auth.users values ('${A}', 'sam@example.com', '{"full_name":"Sam"}')`);
  await pg.exec(`update profiles set timezone = '${TZ}'`);
  db = rpcAs(pg, A);
});
const q = async (sql: string) => (await pg.query<Record<string, unknown>>(sql)).rows;

function rec(input: string, item: Record<string, unknown>) {
  return Recording.parse({
    name: "tester-s14-inline",
    task: "extract",
    input,
    responses: [
      {
        source_summary: "Quick add",
        participants: [],
        items: [
          {
            type: "commitment", title: "T", owner: "user", counterparty: null, action: "T", date_text: null, date_iso: null,
            amount_text: null, certainty: "explicit", uncertainty_notes: [], matches_thread_id: null,
            evidence: [{ quote: input, speaker: null }], ...item,
          },
        ],
        brief: null,
      },
    ],
  });
}
const model = (r: Recording) => createRecordedModel({ recordings: [r] });
async function add(r: Recording, now = WED) {
  const s = await startExtraction(db, { text: r.input!, title: null, writtenOn: quickAddWrittenOn(now, TZ), kind: "quick_add" }, { now, logger: quiet });
  if (!s.ok) throw new Error("start failed");
  expect(await runExtraction(db, s.extractionId, { model: model(r), logger: quiet })).toBe("succeeded");
  const res = await autoCreateQuickAdd(db, s.extractionId, { now, logger: quiet });
  if (!res.ok) throw new Error(res.code);
  return { ...s, created: res.created };
}
const MIKE = "Send Mike the proposal Friday";
const mike = (date_iso: string | null) => rec(MIKE, { title: "Send the proposal to Mike", counterparty: "Mike", action: "Send the proposal to Mike", date_text: "Friday", date_iso });

describe("tester S14: dates and bands on a Wednesday", () => {
  it("'Friday' is Open, due Fri Nov 13, explicit; written Nov 11, source 'user'", async () => {
    const r = await add(mike("2026-11-13"));
    expect(r.created).toHaveLength(1);
    const [t] = await q("select status, due_certainty, due_time_known, due_at from threads");
    expect(t).toMatchObject({ status: "open", due_certainty: "explicit", due_time_known: false });
    expect(new Date(t!.due_at as string).toISOString().slice(0, 10)).toBe("2026-11-14"); // 23:59 on the 13th in New York
    expect(await q("select reference_date::text as d, reference_date_source as s, kind from sources")).toEqual([{ d: "2026-11-11", s: "user", kind: "quick_add" }]);
  });

  it("the model disagrees (Nov 20): chrono's Nov 13 is kept, inferred with a not-sure line", async () => {
    const r = await add(mike("2026-11-20"));
    const [i] = await q("select band, review_status, payload from extraction_items");
    const date = (i!.payload as { date: { due_at: string; due_certainty: string } }).date;
    expect(new Date(date.due_at).toISOString()).toBe("2026-11-14T04:59:00.000Z");
    expect(date.due_certainty).toBe("inferred");
    expect((i!.payload as { not_sure: unknown[] }).not_sure.length).toBeGreaterThan(0);
    // The band decides: an auto-created thread only if the proposal is still High.
    expect(r.created.length).toBe(i!.band === "high" ? 1 : 0);
  });

  it("near midnight the date is the user's, not UTC's: Wed 22:00 New York is Nov 11, Friday is Nov 13", async () => {
    const late = new Date("2026-11-12T03:00:00Z");
    await add(mike("2026-11-13"), late);
    expect(await q("select reference_date::text as d from sources")).toEqual([{ d: "2026-11-11" }]);
    expect(new Date((await q("select due_at from threads"))[0]!.due_at as string).toISOString()).toBe("2026-11-14T04:59:00.000Z");
  });

  it("'Acme said they'd pay by the 15th': Waiting on Acme, expected Nov 15, explicit, no date invented elsewhere", async () => {
    const r = await add(rec("Acme said they'd pay by the 15th", { type: "waiting_on", title: "Acme to pay", owner: "other", counterparty: "Acme", action: "Pay", date_text: "by the 15th", date_iso: "2026-11-15" }));
    expect(r.created).toHaveLength(1);
    const [t] = await q("select status, kind, waiting_on, expected_by, due_certainty from threads");
    expect(t).toMatchObject({ status: "waiting", kind: "waiting_on", waiting_on: "Acme", due_certainty: "explicit" });
    expect(new Date(t!.expected_by as string).toISOString()).toBe("2026-11-16T04:59:00.000Z");
  });

  it("a dateless item keeps no date", async () => {
    await add(rec("Call the plumber", { title: "Call the plumber", date_iso: "2026-11-13" }));
    const rows = await q("select due_at, due_certainty from threads");
    for (const t of rows) expect(t).toEqual({ due_at: null, due_certainty: "none" });
    expect(rows).toHaveLength(1);
  });

  it("High but waiting on nobody named: stays pending, no thread", async () => {
    const r = await add(rec("They'll call me back", { type: "waiting_on", title: "Call back", owner: "other", counterparty: null, action: "Call back" }));
    expect(r.created).toEqual([]);
    expect((await q("select review_status from extraction_items")).every((x) => x.review_status === "pending")).toBe(true);
    expect(await q("select id from threads")).toEqual([]);
  });

  it("evidence missing: a High item is not created (rule 1)", async () => {
    const r = mike("2026-11-13");
    const s = await startExtraction(db, { text: MIKE, title: null, writtenOn: "2026-11-11", kind: "quick_add" }, { now: WED, logger: quiet });
    if (!s.ok) throw new Error("start");
    await runExtraction(db, s.extractionId, { model: model(r), logger: quiet });
    await pg.exec("delete from evidence");
    expect(await autoCreateQuickAdd(db, s.extractionId, { now: WED, logger: quiet })).toMatchObject({ ok: true, created: [] });
    expect(await q("select id from threads")).toEqual([]);
  });

  it("refused while running and after a failure; a Try again success creates nothing", async () => {
    const s = await startExtraction(db, { text: MIKE, title: null, writtenOn: "2026-11-11", kind: "quick_add" }, { now: WED, logger: quiet });
    if (!s.ok) throw new Error("start");
    expect(await autoCreateQuickAdd(db, s.extractionId, { now: WED, logger: quiet })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await runExtraction(db, s.extractionId, { model: createRecordedModel({ recordings: [] }), logger: quiet })).toBe("failed");
    expect(await autoCreateQuickAdd(db, s.extractionId, { now: WED, logger: quiet })).toMatchObject({ ok: false, code: "invalid_transition" });
    const again = await retryExtraction(db, s.extractionId, { logger: quiet });
    if (!again.ok) throw new Error("retry");
    const id = (again as unknown as { extractionId: string }).extractionId;
    expect(await runExtraction(db, id, { model: model(mike("2026-11-13")), logger: quiet })).toBe("succeeded");
    expect(await autoCreateQuickAdd(db, id, { now: WED, logger: quiet })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await q("select id from threads")).toEqual([]);
    expect((await q("select band, review_status from extraction_items"))).toEqual([{ band: "high", review_status: "pending" }]);
  });
});
