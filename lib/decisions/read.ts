import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { log } from "@/lib/log";

/**
 * Decision list for /decisions (SITE_CONTRACT §2.11, CONTENT_MODEL §10): every decision the user
 * recorded, newest first, with its thread's title. RLS limits both reads to the user's own rows.
 */

const Row = z.object({ id: z.uuid(), thread_id: z.uuid(), choice: z.string(), decided_at: z.string() });
const ThreadRow = z.object({ id: z.uuid(), title: z.string() });

export interface DecisionListRow {
  id: string;
  thread_id: string;
  thread_title: string;
  choice: string;
  decided_at: string;
}

/** Newest first; null when the list could not be loaded (the page shows its error banner). */
export async function listDecisions(client: SupabaseClient): Promise<DecisionListRow[] | null> {
  const d = await client.from("decisions").select("id, thread_id, choice, decided_at").order("decided_at", { ascending: false }).order("id").limit(500);
  const rows = z.array(Row).safeParse(d.data);
  if (d.error || !rows.success) {
    log("decisions_load_failed", { step: "list", code: d.error ? "query" : "bad_result" });
    return null;
  }
  if (rows.data.length === 0) return [];
  const ids = [...new Set(rows.data.map((r) => r.thread_id))];
  const t = await client.from("threads").select("id, title").in("id", ids);
  const threads = z.array(ThreadRow).safeParse(t.data);
  if (t.error || !threads.success) {
    log("decisions_load_failed", { step: "threads", code: t.error ? "query" : "bad_result" });
    return null;
  }
  const title = new Map(threads.data.map((x) => [x.id, x.title]));
  // A decision always has its thread (FK, on delete cascade); one missing here is skipped, not shown untitled.
  return rows.data.flatMap((r) => {
    const thread_title = title.get(r.thread_id);
    return thread_title === undefined ? [] : [{ ...r, thread_title }];
  });
}
