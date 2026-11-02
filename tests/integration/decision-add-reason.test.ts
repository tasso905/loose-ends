import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { addReason } from "@/lib/decisions/addReason";
import type { RpcDb } from "@/lib/extraction/service";
import { resolveThread, undoEvent } from "@/lib/threads/service";
import { asUser, migratedDb, rpcAs } from "./pglite";

/**
 * S9b "Add a reason now" (D58) against the real migrations in PGlite: public.decision_add_reason()
 * writes a reason only to the caller's own decision, only while it has none, verbatim, with a
 * `reason_added` event; decisions stays SELECT-only for clients; Ask why's search finds the new reason.
 */

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const NOW = new Date("2026-10-05T15:00:00.123Z");
const LATER = new Date("2026-10-06T09:00:00.000Z");

let pg: PGlite;
let dbA: RpcDb;
let dbB: RpcDb;
let threadId = "";
let decisionId = "";

const q = async <T,>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;

beforeEach(async () => {
  pg = await migratedDb();
  await pg.exec(`insert into auth.users values ('${A}', 'sam@example.com', '{"full_name":"Sam"}'), ('${B}', 'b@example.com', '{}')`);
  dbA = rpcAs(pg, A);
  dbB = rpcAs(pg, B);
  const [t] = await q<{ id: string }>(
    `insert into threads (user_id, title, kind, status, created_at, updated_at) values ($1, 'Choose a gym', 'decision', 'open', '2026-10-05T14:00:00Z', '2026-10-05T14:00:00Z') returning id`,
    [A],
  );
  threadId = t!.id;
  await pg.query(`insert into thread_events (user_id, thread_id, actor, type, before, after, created_at) values ($1, $2, 'user', 'created', null, '{}', '2026-10-05T14:00:00Z')`, [A, threadId]);
  const res = await resolveThread(dbA, threadId, "open", "decided", { choice: "Join the pool gym", reason: null }, { now: NOW });
  expect(res.ok).toBe(true);
  decisionId = (res as { decision_id: string }).decision_id;
});

const decision = async () => (await q<{ reason_user: string | null; choice: string }>(`select reason_user, choice from decisions where id = $1`, [decisionId]))[0]!;
const events = () => q<{ type: string; actor: string; before: unknown; after: unknown; created_at: string }>(`select type, actor, before, after, created_at from thread_events where thread_id = $1 order by id`, [threadId]);

describe("decision_add_reason", () => {
  it("adds the reason verbatim and appends a reason_added event with before and after", async () => {
    const reason = "  It has a pool,\nand it's close to work.  ";
    const res = await addReason(dbA, { decisionId, reason }, { now: LATER });
    expect(res).toMatchObject({ ok: true, decisionId, threadId, reason });
    expect((await decision()).reason_user).toBe(reason);
    const ev = await events();
    expect(ev.map((e) => e.type)).toEqual(["created", "resolved", "reason_added"]);
    expect(ev[2]).toMatchObject({
      actor: "user",
      before: { decision_id: decisionId, reason_user: null },
      after: { decision_id: decisionId, reason_user: reason },
    });
    expect(new Date(ev[2]!.created_at).toISOString()).toBe(LATER.toISOString());
    // History is never rewritten: the earlier events are unchanged.
    expect(ev[1]!.type).toBe("resolved");
  });

  it("only while there is no reason: a second add is refused and changes nothing", async () => {
    expect((await addReason(dbA, { decisionId, reason: "First" }, { now: LATER })).ok).toBe(true);
    const again = await addReason(dbA, { decisionId, reason: "Second" }, { now: LATER });
    expect(again).toMatchObject({ ok: false, code: "invalid_transition" });
    expect((await decision()).reason_user).toBe("First");
    expect((await events()).filter((e) => e.type === "reason_added")).toHaveLength(1);
  });

  it("refuses a decision saved with a reason", async () => {
    await pg.query(`update decisions set reason_user = 'Already' where id = $1`, [decisionId]);
    expect(await addReason(dbA, { decisionId, reason: "New" }, { now: LATER })).toMatchObject({ ok: false, code: "invalid_transition" });
    expect((await decision()).reason_user).toBe("Already");
  });

  it("another user's decision reads as not found and is untouched", async () => {
    expect(await addReason(dbB, { decisionId, reason: "Mine now" }, { now: LATER })).toMatchObject({ ok: false, code: "not_found" });
    expect((await decision()).reason_user).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["whitespace", " \n\t "],
    ["zero-width", "​​"],
    ["2,001 characters", "a".repeat(2001)],
  ])("the database refuses a %s reason (same rule as Resolve)", async (_, reason) => {
    const { error } = await dbA.rpc("decision_add_reason", { p_decision_id: decisionId, p_reason: reason, p_now: LATER.toISOString() });
    expect(error).not.toBeNull();
    expect((await decision()).reason_user).toBeNull();
  });

  it("2,000 emoji are 2,000 characters: accepted", async () => {
    const reason = "\u{1F600}".repeat(2000);
    expect((await addReason(dbA, { decisionId, reason }, { now: LATER })).ok).toBe(true);
    expect((await decision()).reason_user).toBe(reason);
  });

  it("decisions stays SELECT-only for clients: a direct update is refused", async () => {
    await expect(asUser(pg, A, () => pg.query(`update public.decisions set reason_user = 'x' where id = $1`, [decisionId]))).rejects.toThrow();
    expect((await decision()).reason_user).toBeNull();
  });

  it("Ask why's search finds the added reason", async () => {
    await addReason(dbA, { decisionId, reason: "The swimming lanes are never crowded." }, { now: LATER });
    const { data, error } = await dbA.rpc("search_decisions", { p_question: "Why did I care about crowded lanes?" });
    expect(error).toBeNull();
    expect((data as { id: string; reason_user: string }[]).map((d) => [d.id, d.reason_user])).toEqual([[decisionId, "The swimming lanes are never crowded."]]);
  });

  it("an Undo of the resolution is refused once a reason was added (it is no longer the latest event)", async () => {
    const [resolved] = await q<{ id: number }>(`select id from thread_events where thread_id = $1 and type = 'resolved'`, [threadId]);
    await addReason(dbA, { decisionId, reason: "Pool" }, { now: new Date(NOW.getTime() + 2000) });
    const undo = await undoEvent(dbA, threadId, resolved!.id, { now: new Date(NOW.getTime() + 3000) });
    expect(undo).toMatchObject({ ok: false, code: "invalid_transition" });
    expect((await decision()).reason_user).toBe("Pool");
  });
});
