import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAskWhySet } from "@/evals/ask-why/set";

/**
 * Checks the Ask-why question set against real Postgres English full-text search (PGlite), the way
 * F12 retrieves (PRD Decision Memory: full-text over choice + reason, joined with the thread's title
 * and counterparty, D31; top 5). The retrieval query itself is built in S9; this pins the property
 * the eval set depends on:
 *
 * - every unanswerable question shares no lexeme with any decision, so retrieval returns zero rows
 *   under ANY term semantics (OR is the loosest), and askWhy() is never called with records;
 * - every answerable question shares at least one lexeme with its expected decision, which ranks in
 *   the top 5 under OR semantics.
 *
 * Under AND semantics (plainto_tsquery / websearch_to_tsquery as is) most answerable questions match
 * nothing, because question words like "choose", "pick" or "go" are not in the stored text; the last
 * test records that, so S9 knows the query must OR the question's lexemes (or drop such words).
 */

const set = loadAskWhySet();
let db: PGlite;

const DOC = `coalesce(choice,'') || ' ' || coalesce(reason_user,'') || ' ' || thread_title || ' ' || coalesce(counterparty,'')`;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create table d (id text primary key, choice text not null, reason_user text, thread_title text not null, counterparty text,
    doc tsvector generated always as (to_tsvector('english', ${DOC})) stored)`);
  for (const x of set.decisions) {
    await db.query(`insert into d (id, choice, reason_user, thread_title, counterparty) values ($1, $2, $3, $4, $5)`, [
      x.id,
      x.choice,
      x.reason_user,
      x.thread_title,
      x.counterparty,
    ]);
  }
});
afterAll(async () => {
  await db?.close();
});

/** Question lexemes OR'd together: the loosest full-text query. Empty when every word is a stopword. */
async function orRetrieve(question: string): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    `with q as (select to_tsvector('english', $1) as v)
     select d.id from d, q
     where q.v <> ''::tsvector
       and d.doc @@ to_tsquery('english', array_to_string(tsvector_to_array(q.v), ' | '))
     order by ts_rank(d.doc, to_tsquery('english', array_to_string(tsvector_to_array(q.v), ' | '))) desc, d.id
     limit 5`,
    [question],
  );
  return res.rows.map((r) => r.id);
}

async function andRetrieve(question: string): Promise<string[]> {
  const res = await db.query<{ id: string }>(`select id from d where doc @@ plainto_tsquery('english', $1) order by id`, [question]);
  return res.rows.map((r) => r.id);
}

describe("Ask-why set vs Postgres English full-text search", () => {
  const unanswerable = set.questions.filter((q) => !q.answerable);
  const answerable = set.questions.flatMap((q) => (q.answerable ? [q] : []));

  it.each(unanswerable.map((q) => [q.id, q.question] as const))("%s: zero rows under OR semantics (%s)", async (_id, question) => {
    expect(await orRetrieve(question)).toEqual([]);
  });

  it.each(answerable.map((q) => [q.id, q.question, q.expect.decision_ids] as const))(
    "%s: expected decision in the top 5 under OR semantics (%s)",
    async (_id, question, ids) => {
      const got = await orRetrieve(question);
      for (const id of ids) expect(got, question).toContain(id);
    },
  );

  it("AND semantics (plainto_tsquery) finds the expected decision for only some answerable questions", async () => {
    let found = 0;
    for (const q of answerable) if ((await andRetrieve(q.question)).includes(q.expect.decision_ids[0]!)) found++;
    // Recorded, not a target: S9 must not use plain AND over the raw question.
    expect(found).toBeLessThan(answerable.length);
  });
});
