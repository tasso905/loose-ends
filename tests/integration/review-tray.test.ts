import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordedModel, Recording } from "@/lib/ai/fake";
import { ProposalPayload, type ProposalPayloadV1 } from "@/lib/extraction/payload";
import { readExtraction, runExtraction, startExtraction, type RpcDb } from "@/lib/extraction/service";
import type { LogEvent, LogProps } from "@/lib/log";
import { acceptProposals, rejectProposals, undoRejectProposals } from "@/lib/review/service";
import { createFieldsFromPayload } from "@/lib/review/tray";
import { transition } from "@/lib/threads/transition";
import { migratedDb, rpcAs } from "./pglite";

/**
 * S3 (F6): accept / reject / undo against the real migrations in PGlite, with the recorded
 * (synthetic) Mike email. No network, no live model.
 */

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const NOW = new Date("2026-10-05T15:00:00Z");
const LATER = new Date("2026-10-05T15:05:00Z");

const MIKE = Recording.parse(
  JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "llm", "mike-email.extract.json"), "utf8")),
);

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

const q = async <T,>(sql: string) => (await pg.query<T>(sql)).rows;
const count = async (sql: string) => (await q<{ n: number }>(`select count(*)::int as n from ${sql}`))[0]!.n;

/** Paste the Mike email as `db`'s user and run the recorded extraction. Returns ids by band. */
async function pasteMike(db: RpcDb) {
  const start = await startExtraction(db, { text: MIKE.input!, title: null, writtenOn: "2026-10-05" }, { now: NOW, logger });
  if (!start.ok) throw new Error("start failed");
  const outcome = await runExtraction(db, start.extractionId, { model: createRecordedModel({ recordings: [MIKE] }), logger });
  expect(outcome).toBe("succeeded");
  const view = (await readExtraction(db, start.extractionId, { now: NOW }))!;
  // Undefined when that band was suppressed.
  const byBand = (b: string) => view.proposals.find((p) => p.band === b)!;
  return { extractionId: start.extractionId, sourceId: start.sourceId, view, high: byBand("high"), low: byBand("low") };
}

async function snapshot() {
  return {
    threads: await count("threads"),
    events: await count("thread_events"),
    threadEvidence: await count("evidence where thread_id is not null"),
    suppressions: await count("suppressions"),
    reviewed: await count("extraction_items where review_status <> 'pending'"),
  };
}

describe("accept (one transactional function)", () => {
  it("one accept writes the thread, its evidence, a created event and review_status together", async () => {
    const m = await pasteMike(dbA);
    const res = await acceptProposals(dbA, m.extractionId, [m.high.id], { now: LATER });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toHaveLength(1);
    const threadId = res.created[0]!.thread_id!;
    expect(res.created[0]).toMatchObject({ item_id: m.high.id, band: "high" });

    const [t] = await q<Record<string, unknown>>(`select * from threads where id = '${threadId}'`);
    expect(t).toMatchObject({
      user_id: A,
      title: "Send revised proposal to Mike",
      kind: "commitment",
      status: "open",
      next_action: "Send the revised proposal",
      counterparty: "Mike",
      due_certainty: "explicit",
      due_time_known: false,
      primary_source_id: m.sourceId,
      resolution: null,
      waiting_on: null,
    });
    expect(new Date(t!.created_at as string).toISOString()).toBe(LATER.toISOString());

    const ev = await q<{ thread_id: string; extraction_item_id: string; quote: string; source_id: string }>(
      `select thread_id, extraction_item_id, quote, source_id from evidence where thread_id = '${threadId}'`,
    );
    expect(ev).toEqual([{ thread_id: threadId, extraction_item_id: m.high.id, quote: "I'll send you the revised proposal Friday", source_id: m.sourceId }]);

    const events = await q<{ actor: string; type: string; before: unknown; after: Record<string, unknown> }>(
      `select actor, type, before, after from thread_events where thread_id = '${threadId}'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "user", type: "created", before: null });
    expect(events[0]!.after).toMatchObject({ via: "accept", extraction_item_id: m.high.id, status: "open", kind: "commitment" });

    const [item] = await q<{ review_status: string; thread_id: string; reviewed_at: string }>(
      `select review_status, thread_id, reviewed_at from extraction_items where id = '${m.high.id}'`,
    );
    expect(item).toMatchObject({ review_status: "accepted", thread_id: threadId });
    expect(new Date(item!.reviewed_at).toISOString()).toBe(LATER.toISOString());

    // The Low item was not selected and is untouched.
    expect((await q<{ s: string }>(`select review_status as s from extraction_items where id = '${m.low.id}'`))[0]!.s).toBe("pending");
  });

  it("is atomic: a failure in the last write leaves no thread, no evidence link and the item pending", async () => {
    const m = await pasteMike(dbA);
    await pg.exec(`
      create function public.test_fail_event() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
      create trigger test_fail_event before insert on public.thread_events for each row execute function public.test_fail_event();
    `);
    const before = await snapshot();
    const res = await acceptProposals(dbA, m.extractionId, [m.high.id, m.low.id], { now: LATER, logger });
    expect(res).toMatchObject({ ok: false, notFound: false, error: { error: { code: "save_failed" } } });
    expect(await snapshot()).toEqual(before);
    expect(logger).toHaveBeenCalledWith("review_persist_failed", expect.objectContaining({ step: "accept_proposals" }));
  });

  it("a repeat accept writes nothing and returns the existing thread", async () => {
    const m = await pasteMike(dbA);
    const first = await acceptProposals(dbA, m.extractionId, [m.high.id], { now: LATER });
    const after = await snapshot();
    const again = await acceptProposals(dbA, m.extractionId, [m.high.id, m.high.id], { now: LATER });
    expect(again).toMatchObject({ ok: true, created: [], invalid: [] });
    if (!first.ok || !again.ok) throw new Error("unexpected");
    expect(again.already).toEqual([{ item_id: m.high.id, thread_id: first.created[0]!.thread_id, band: "high" }]);
    expect(await snapshot()).toEqual(after);
  });

  it("an explicitly accepted Low proposal becomes a thread (D4)", async () => {
    const m = await pasteMike(dbA);
    const res = await acceptProposals(dbA, m.extractionId, [m.low.id], { now: LATER });
    expect(res).toMatchObject({ ok: true, created: [{ item_id: m.low.id, band: "low" }] });
    const [t] = await q<{ kind: string; status: string; title: string }>(`select kind, status, title from threads`);
    expect(t).toEqual({ kind: "commitment", status: "open", title: "Lunch with Mike" });
  });

  it("Ignore-band and rejected items are not accepted", async () => {
    const m = await pasteMike(dbA);
    await pg.exec(`update extraction_items set band = 'ignore' where id = '${m.low.id}'`);
    await rejectProposals(dbA, m.extractionId, [m.high.id], { now: LATER });
    const before = await snapshot();
    const res = await acceptProposals(dbA, m.extractionId, [m.high.id, m.low.id], { now: LATER });
    expect(res).toMatchObject({ ok: true, created: [], already: [] });
    if (res.ok) expect(res.invalid.map((e) => e.item_id).sort()).toEqual([m.high.id, m.low.id].sort());
    expect(await snapshot()).toEqual(before);
  });
});

describe("reject and undo", () => {
  it("reject stores rejected + a suppression; a re-paste does not propose it again", async () => {
    const m = await pasteMike(dbA);
    const res = await rejectProposals(dbA, m.extractionId, [m.high.id], { now: LATER });
    expect(res).toMatchObject({ ok: true, rejected: [{ item_id: m.high.id, band: "high" }] });

    const [item] = await q<{ review_status: string; suppression_hash: string }>(
      `select review_status, suppression_hash from extraction_items where id = '${m.high.id}'`,
    );
    expect(item!.review_status).toBe("rejected");
    const sup = await q<{ reason: string; suppression_hash: string; thread_id: string | null }>(`select reason, suppression_hash, thread_id from suppressions`);
    expect(sup).toEqual([{ reason: "rejected", suppression_hash: item!.suppression_hash, thread_id: null }]);
    expect(await count("threads")).toBe(0);

    const again = await pasteMike2();
    expect(again.map((p) => p.payload.item.title)).toEqual(["Lunch with Mike"]);
  });

  it("a repeat reject writes nothing", async () => {
    const m = await pasteMike(dbA);
    await rejectProposals(dbA, m.extractionId, [m.high.id], { now: LATER });
    const before = await snapshot();
    const again = await rejectProposals(dbA, m.extractionId, [m.high.id], { now: LATER });
    expect(again).toMatchObject({ ok: true, rejected: [], already: [{ item_id: m.high.id }] });
    expect(await snapshot()).toEqual(before);
  });

  it("undo restores pending and removes the suppression, so a re-paste proposes it again", async () => {
    const m = await pasteMike(dbA);
    await rejectProposals(dbA, m.extractionId, [m.high.id, m.low.id], { now: LATER });
    expect(await count("suppressions")).toBe(2);
    const undo = await undoRejectProposals(dbA, m.extractionId, [m.high.id]);
    expect(undo).toMatchObject({ ok: true, restored: [{ item_id: m.high.id }] });
    expect((await q<{ s: string; r: string | null }>(`select review_status as s, reviewed_at as r from extraction_items where id = '${m.high.id}'`))[0]).toEqual({ s: "pending", r: null });
    expect(await count("suppressions")).toBe(1);

    // Now acceptable again.
    expect(await acceptProposals(dbA, m.extractionId, [m.high.id], { now: LATER })).toMatchObject({ ok: true, created: [{ item_id: m.high.id }] });
    // An accepted item cannot be rejected or "undone".
    expect(await rejectProposals(dbA, m.extractionId, [m.high.id], { now: LATER })).toMatchObject({ ok: true, invalid: [{ item_id: m.high.id }] });
  });

  it("reject keeps a stronger existing suppression (forgotten) as it is", async () => {
    const m = await pasteMike(dbA);
    const [h] = await q<{ h: string }>(`select suppression_hash as h from extraction_items where id = '${m.high.id}'`);
    await pg.exec(`insert into suppressions (user_id, suppression_hash, reason) values ('${A}', '${h!.h}', 'forgotten')`);
    await rejectProposals(dbA, m.extractionId, [m.high.id], { now: LATER });
    await undoRejectProposals(dbA, m.extractionId, [m.high.id]);
    expect(await q(`select reason from suppressions`)).toEqual([{ reason: "forgotten" }]);
  });
});

/** Second paste of the same text by A; returns the proposals it shows. */
async function pasteMike2() {
  return (await pasteMike(dbA)).view.proposals;
}

describe("another user's ids are refused (RLS and the function)", () => {
  it("B cannot accept, reject or undo A's item, with A's or B's own extraction id; nothing is written", async () => {
    const a = await pasteMike(dbA);
    const b = await pasteMike(dbB);
    const before = await snapshot();
    for (const ex of [a.extractionId, b.extractionId]) {
      expect(await acceptProposals(dbB, ex, [a.high.id], { now: LATER })).toMatchObject({ ok: false, notFound: true });
      expect(await rejectProposals(dbB, ex, [a.high.id], { now: LATER })).toMatchObject({ ok: false, notFound: true });
      expect(await undoRejectProposals(dbB, ex, [a.high.id])).toMatchObject({ ok: false, notFound: true });
      // Mixed with B's own id: the whole call is refused.
      expect(await acceptProposals(dbB, ex, [b.high.id, a.high.id], { now: LATER })).toMatchObject({ ok: false, notFound: true });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("an item of another extraction is refused even for its owner", async () => {
    const first = await pasteMike(dbA);
    const other = await startExtraction(dbA, { text: "Second note.", title: null, writtenOn: "2026-10-05" }, { now: NOW, logger });
    if (!other.ok) throw new Error("start failed");
    expect(await acceptProposals(dbA, other.extractionId, [first.high.id], { now: LATER })).toMatchObject({ ok: false, notFound: true });
  });

  it("the function refuses another user's id even when RLS is bypassed", async () => {
    const a = await pasteMike(dbA);
    // Superuser (RLS does not apply) with B's auth.uid().
    await pg.exec(`select set_config('request.jwt.claim.sub', '${B}', false)`);
    const res = await pg.query<{ r: unknown }>(
      `select public.accept_proposals('${a.extractionId}', array['${a.high.id}']::uuid[], now()) as r`,
    );
    expect(res.rows[0]!.r).toEqual({ ok: false, error: "not_found" });
    const rej = await pg.query<{ r: unknown }>(`select public.reject_proposals('${a.extractionId}', array['${a.high.id}']::uuid[], now()) as r`);
    expect(rej.rows[0]!.r).toEqual({ ok: false, error: "not_found" });
    expect(await count("threads")).toBe(0);
    expect(await count("suppressions")).toBe(0);
  });
});

describe("SQL proposal_thread_fields() agrees with TS transition(create)", () => {
  const SOURCE = "11111111-1111-4111-8111-111111111111";
  const ITEM = "22222222-2222-4222-8222-222222222222";

  function variants(base: ProposalPayloadV1): Array<[string, ProposalPayloadV1]> {
    const out: Array<[string, ProposalPayloadV1]> = [];
    const types = ["commitment", "request", "waiting_on", "deadline", "intention", "decision", "key_fact"] as const;
    const owners = ["user", "other", "unknown"] as const;
    const dates: Array<[string, ProposalPayloadV1["date"]]> = [
      ["dated", base.date],
      ["inferred+time", { ...base.date, due_certainty: "inferred", due_time_known: true, due_at: "2026-10-09T19:00:00.000Z" }],
      ["undated", { ...base.date, due_at: null, due_date: null, due_time_known: false, due_certainty: "none" }],
    ];
    for (const type of types)
      for (const owner of owners)
        for (const [dn, date] of dates)
          for (const counterparty of ["Mike", null, "   "]) {
            out.push([`${type}/${owner}/${dn}/${counterparty ?? "null"}`, { ...base, item: { ...base.item, type, owner, counterparty }, date }]);
          }
    out.push(["empty title", { ...base, item: { ...base.item, title: "" } }]);
    out.push(["blank title", { ...base, item: { ...base.item, title: "  " } }]);
    out.push(["no action", { ...base, item: { ...base.item, action: null } }]);
    return out;
  }

  it("for every item type, owner, date shape and counterparty", async () => {
    const m = await pasteMike(dbA);
    const base = ProposalPayload.parse(m.high.payload);
    const cases = variants(base);
    expect(cases.length).toBeGreaterThan(180);
    for (const [name, payload] of cases) {
      const res = await pg.query<{ f: Record<string, unknown> | null }>(
        `select private.proposal_thread_fields($1::jsonb, $2::uuid, $3::numeric) as f`,
        [JSON.stringify(payload), SOURCE, "0.95"],
      );
      const sql = res.rows[0]!.f;
      const fields = createFieldsFromPayload(payload, { sourceId: SOURCE, confidence: 0.95 });
      const ts = fields ? transition(null, { type: "create", via: "accept", extractionItemId: ITEM, fields }, { actor: "user", now: NOW }) : null;
      if (!ts || !ts.ok) {
        expect(sql, name).toBeNull();
        continue;
      }
      expect(sql, name).toEqual(ts.thread);
      // The stored event `after` is the SQL fields plus via and extraction_item_id: same as TS.
      expect({ ...sql, via: "accept", extraction_item_id: ITEM }, name).toEqual(ts.event!.after);
    }
  });

  it("the accepted thread row equals the TS-created thread state", async () => {
    const m = await pasteMike(dbA);
    const res = await acceptProposals(dbA, m.extractionId, [m.high.id, m.low.id], { now: LATER });
    if (!res.ok) throw new Error("accept failed");
    for (const c of res.created) {
      const p = m.view.proposals.find((x) => x.id === c.item_id)!;
      const fields = createFieldsFromPayload(p.payload, { sourceId: m.sourceId, confidence: p.confidence })!;
      const ts = transition(null, { type: "create", via: "accept", extractionItemId: p.id, fields }, { actor: "user", now: LATER });
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
      const [ev] = await q<{ after: unknown }>(`select after from thread_events where thread_id = '${c.thread_id}'`);
      expect(ev!.after).toEqual(ts.event!.after);
    }
  });
});
