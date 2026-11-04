import { log as defaultLog, type Logger } from "@/lib/log";

/**
 * F13 export: "one JSON file of all user rows" (PRD F13), read with the user's own client, so RLS
 * (`user_id = auth.uid()`) limits every table to the caller's rows; each query also filters by the
 * user explicitly. PostgREST returns at most 1,000 rows per request, so every table is paged in a
 * stable order. Storage files are not included (their text is in sources.text_content).
 */

/** Every public table that holds user rows, with its owner column and a stable, unique order. */
export const EXPORT_TABLES = [
  { table: "profiles", owner: "id", order: ["id"] },
  { table: "user_settings", owner: "user_id", order: ["user_id"] },
  { table: "sources", owner: "user_id", order: ["created_at", "id"] },
  { table: "extractions", owner: "user_id", order: ["id"] },
  { table: "extraction_items", owner: "user_id", order: ["id"] },
  { table: "threads", owner: "user_id", order: ["created_at", "id"] },
  { table: "evidence", owner: "user_id", order: ["id"] },
  { table: "thread_events", owner: "user_id", order: ["id"] },
  { table: "decisions", owner: "user_id", order: ["id"] },
  { table: "suppressions", owner: "user_id", order: ["suppression_hash"] },
  { table: "usage_counters", owner: "user_id", order: ["day"] },
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number]["table"];

interface Query {
  eq(column: string, value: string): Query;
  order(column: string, opts: { ascending: boolean }): Query;
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
}
/** The slice of a user Supabase client this needs (unit-testable). */
export interface ExportClient {
  from(table: string): { select(columns: string): Query };
}

export interface UserExport {
  format: "loose-ends-export";
  version: 1;
  exported_at: string;
  user_id: string;
  tables: Record<ExportTable, unknown[]>;
}

export type ExportResult = { ok: true; data: UserExport } | { ok: false };

export async function buildExport(
  client: ExportClient,
  userId: string,
  now: Date,
  opts: { pageSize?: number; logger?: Logger } = {},
): Promise<ExportResult> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 1000, 1), 1000);
  const logger = opts.logger ?? defaultLog;
  const tables = {} as Record<ExportTable, unknown[]>;
  for (const { table, owner, order } of EXPORT_TABLES) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += pageSize) {
      let q = client.from(table).select("*").eq(owner, userId);
      for (const column of order) q = q.order(column, { ascending: true });
      const { data, error } = await q.range(from, from + pageSize - 1);
      if (error || !data) {
        logger("export_failed", { table, step: "read" });
        return { ok: false };
      }
      rows.push(...data);
      if (data.length < pageSize) break;
    }
    tables[table] = rows;
  }
  return { ok: true, data: { format: "loose-ends-export", version: 1, exported_at: now.toISOString(), user_id: userId, tables } };
}

/** `loose-ends-export-2026-10-27.json`, dated in UTC. */
export const exportFileName = (now: Date) => `loose-ends-export-${now.toISOString().slice(0, 10)}.json`;
