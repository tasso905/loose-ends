import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { log } from "@/lib/log";
import { Band, DueCertainty, ThreadKind, ThreadStatus } from "@/lib/schemas";
import { StoredOrigin, threadNotSure } from "./explain";
import { FILTER_STATUSES, sortThreads, type ThreadFilter } from "./view";

/**
 * Reads for the Threads index, Thread detail and the interim Today, with the user's own client:
 * RLS limits every query to the caller's rows, so another user's id reads as not found.
 */

/** Dates render in the user's timezone (DESIGN_STANDARD "Dates and numbers"); UTC if unknown. */
export async function userTimezone(client: SupabaseClient, userId: string): Promise<string> {
  const { data } = await client.from("profiles").select("timezone").eq("id", userId).maybeSingle();
  return typeof data?.timezone === "string" ? data.timezone : "UTC";
}

const ListRow = z.object({
  id: z.uuid(),
  title: z.string(),
  kind: ThreadKind,
  status: ThreadStatus,
  due_at: z.string().nullable(),
  due_certainty: DueCertainty,
  due_time_known: z.boolean(),
  snoozed_until: z.string().nullable(),
  resolved_at: z.string().nullable(),
  updated_at: z.string(),
  created_at: z.string(),
});
export type ThreadListRow = z.infer<typeof ListRow>;

const LIST_COLUMNS = "id, title, kind, status, due_at, due_certainty, due_time_known, snoozed_until, resolved_at, updated_at, created_at";

export async function listThreads(client: SupabaseClient, filter: ThreadFilter): Promise<ThreadListRow[] | null> {
  const { data, error } = await client.from("threads").select(LIST_COLUMNS).in("status", FILTER_STATUSES[filter]).limit(500);
  const parsed = z.array(ListRow).safeParse(data);
  if (error || !parsed.success) {
    log("threads_load_failed", { step: "list", code: error ? "query" : "bad_result" });
    return null;
  }
  return sortThreads(parsed.data, filter);
}

const Detail = ListRow.extend({
  next_action: z.string().nullable(),
  counterparty: z.string().nullable(),
  waiting_on: z.string().nullable(),
  expected_by: z.string().nullable(),
  resolution: z.string().nullable(),
  primary_source_id: z.uuid().nullable(),
});

const Evidence = z.object({
  id: z.uuid(),
  quote: z.string(),
  page: z.number().int().nullable(),
  source_id: z.uuid().nullable(),
  extraction_item_id: z.uuid().nullable(),
});

const Event = z.object({
  id: z.number().int(),
  type: z.string(),
  actor: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
});

const Item = z.object({
  band: Band,
  extraction_id: z.uuid(),
  payload: z.object({ label: z.object({ word: z.string(), reason: z.string() }).nullable().optional() }).loose(),
});

const Extraction = z.object({ brief: z.unknown().nullable(), source_id: z.uuid() });

/** F11: the decision a resolution as Decided wrote (verbatim choice and reason, rule 5). */
const Decision = z.object({ id: z.uuid(), choice: z.string(), reason_user: z.string().nullable(), decided_at: z.string() });

const Source = z.object({ id: z.uuid(), title: z.string().nullable(), kind: z.string(), reference_date: z.string() });

export interface ThreadDetail {
  thread: z.infer<typeof Detail>;
  evidence: z.infer<typeof Evidence>[];
  /** Append-only history, oldest first. */
  events: z.infer<typeof Event>[];
  /** The stored F19 label of the proposal it came from (rule 6: never recomputed). */
  origin: { band: z.infer<typeof Band>; label: { word: string; reason: string } | null } | null;
  sources: Record<string, z.infer<typeof Source>>;
  /** F7: the stored, verified brief of the extraction this thread came from (null: none). */
  brief: { brief: unknown; sourceId: string } | null;
  /** F7 "Not sure about" lines for this thread, from the stored proposal (lib/threads/explain.ts). */
  notSure: string[];
  /** F11: the latest decision, shown while the thread is resolved as Decided (null: none). */
  decision: z.infer<typeof Decision> | null;
}

export type DetailResult = { ok: true; detail: ThreadDetail } | { ok: false; reason: "not_found" | "failed" };

export async function getThreadDetail(client: SupabaseClient, id: string): Promise<DetailResult> {
  const fail = (step: string): DetailResult => {
    log("threads_load_failed", { step, code: "query" });
    return { ok: false, reason: "failed" };
  };
  const t = await client.from("threads").select(`${LIST_COLUMNS}, next_action, counterparty, waiting_on, expected_by, resolution, primary_source_id`).eq("id", id).maybeSingle();
  if (t.error) return fail("thread");
  if (!t.data) return { ok: false, reason: "not_found" };
  const thread = Detail.safeParse(t.data);
  if (!thread.success) return fail("thread_parse");

  const [ev, events, items, dec] = await Promise.all([
    client.from("evidence").select("id, quote, page, source_id, extraction_item_id").eq("thread_id", id).order("id"),
    client.from("thread_events").select("id, type, actor, before, after, created_at").eq("thread_id", id).order("id"),
    client.from("extraction_items").select("band, extraction_id, payload").eq("thread_id", id).limit(1),
    client.from("decisions").select("id, choice, reason_user, decided_at").eq("thread_id", id).order("decided_at", { ascending: false }).limit(1),
  ]);
  if (ev.error || events.error || items.error || dec.error) return fail("related");
  const decision = z.array(Decision).safeParse(dec.data);
  if (!decision.success) return fail("related_parse");
  const evidence = z.array(Evidence).safeParse(ev.data);
  const history = z.array(Event).safeParse(events.data);
  if (!evidence.success || !history.success) return fail("related_parse");
  const item = items.data?.[0] ? Item.safeParse(items.data[0]) : null;

  let brief: ThreadDetail["brief"] = null;
  if (item?.success) {
    const x = await client.from("extractions").select("brief, source_id").eq("id", item.data.extraction_id).maybeSingle();
    if (x.error) return fail("brief");
    const parsed = x.data ? Extraction.safeParse(x.data) : null;
    if (parsed && !parsed.success) return fail("brief_parse");
    if (parsed?.success && parsed.data.brief !== null) brief = { brief: parsed.data.brief, sourceId: parsed.data.source_id };
  }
  const origin = item?.success ? StoredOrigin.safeParse(item.data.payload) : null;

  const sourceIds = [
    ...new Set([...evidence.data.map((e) => e.source_id), brief?.sourceId ?? null].filter((s): s is string => s !== null)),
  ];
  let sources: ThreadDetail["sources"] = {};
  if (sourceIds.length > 0) {
    const s = await client.from("sources").select("id, title, kind, reference_date").in("id", sourceIds);
    const parsed = z.array(Source).safeParse(s.data);
    if (s.error || !parsed.success) return fail("sources");
    sources = Object.fromEntries(parsed.data.map((x) => [x.id, x]));
  }

  return {
    ok: true,
    detail: {
      thread: thread.data,
      evidence: evidence.data,
      events: history.data,
      origin: item?.success ? { band: item.data.band, label: item.data.payload.label ?? null } : null,
      sources,
      brief,
      notSure: threadNotSure(origin?.success ? origin.data : null, thread.data),
      decision: thread.data.resolution === "decided" ? (decision.data[0] ?? null) : null,
    },
  };
}
