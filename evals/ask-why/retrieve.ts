/**
 * The real F12 retrieval (public.search_decisions, migration 20261022172128) over the Ask-why set:
 * an in-process Postgres (PGlite) with every migration applied, one eval user, and decisions.json
 * seeded with its own IDs. Used by `pnpm eval` and the unit tests; no network, no env.
 */
import type { PGlite } from "@electric-sql/pglite";
import type { RetrievedDecision } from "@/lib/ai/askWhy";
import { retrieveDecisions } from "@/lib/decisions/ask";
import { migratedDb, rpcAs } from "@/tests/integration/pglite";
import type { Retriever } from "./harness";
import type { AskWhySet } from "./set";

export const EVAL_USER = "e7a10000-0000-4000-8000-000000000001";

export async function seedAskWhySet(db: PGlite, set: AskWhySet, user = EVAL_USER): Promise<void> {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'jordan.ellis@example.com', $2)`, [
    user,
    JSON.stringify({ full_name: set.meta.user.display_name }),
  ]);
  for (const d of set.decisions) {
    await db.query(
      `insert into threads (id, user_id, title, kind, counterparty, status, resolution, resolved_at, created_at, updated_at)
       values ($1, $2, $3, 'decision', $4, 'resolved', 'decided', $5, $5, $5)`,
      [d.thread_id, user, d.thread_title, d.counterparty, d.decided_at],
    );
    await db.query(
      `insert into decisions (id, user_id, thread_id, choice, reason_user, context_facts, decided_at) values ($1, $2, $3, $4, $5, $6, $7)`,
      [d.id, user, d.thread_id, d.choice, d.reason_user, JSON.stringify(d.context_facts), d.decided_at],
    );
  }
}

/** A retriever over a fresh seeded database; `close()` releases it. */
export async function pgliteRetriever(set: AskWhySet): Promise<{ retrieve: Retriever; db: PGlite; close: () => Promise<void> }> {
  const db = await migratedDb();
  await seedAskWhySet(db, set);
  const rpc = rpcAs(db, EVAL_USER);
  const retrieve = async (question: string): Promise<RetrievedDecision[]> => {
    const rows = await retrieveDecisions(rpc, question);
    if (rows === null) throw new Error("search_decisions failed");
    return rows;
  };
  return { retrieve, db, close: () => db.close() };
}
