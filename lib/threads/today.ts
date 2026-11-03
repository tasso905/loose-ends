import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { log } from "@/lib/log";
import { Band, DueCertainty, ThreadKind, ThreadStatus } from "@/lib/schemas";
import { parseInstant } from "@/lib/time";
import { RECENTLY_RESOLVED_DAYS, todaySections, type TodaySections } from "./attention";
import { reasonLine } from "./why";

/**
 * F10 Today reads, with the user's own client (RLS limits every query to the caller's rows). Only
 * accepted threads are read, so an unaccepted proposal of any band never appears (rule 4); pending
 * proposals only count towards the `N to review` chip.
 */

/** Numeric columns can arrive as strings; anything else fails the parse. */
const Numeric = z.preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number().min(0).max(1));

const TodayThread = z.object({
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
  counterparty: z.string().nullable(),
  waiting_on: z.string().nullable(),
  expected_by: z.string().nullable(),
  confidence: Numeric.nullable(),
  consequence: z.string().nullable(),
  consequence_basis: z.enum(["source", "interpretation"]).nullable(),
  primary_source_id: z.uuid().nullable(),
});
export type TodayThread = z.infer<typeof TodayThread>;

const COLUMNS =
  "id, title, kind, status, due_at, due_certainty, due_time_known, snoozed_until, resolved_at, updated_at, created_at, counterparty, waiting_on, expected_by, confidence, consequence, consequence_basis, primary_source_id";

const ItemDate = z.object({ thread_id: z.uuid(), date_text: z.string().nullable() });
const Source = z.object({ id: z.uuid(), title: z.string().nullable(), kind: z.string(), reference_date: z.string() });
const Pending = z.object({ extraction_id: z.uuid(), band: Band, type: z.string().nullable(), label: z.unknown() });
const ExtractionRow = z.object({ id: z.uuid(), status: z.string(), created_at: z.string() });

export interface TodayData {
  sections: TodaySections<TodayThread>;
  /** Reason line per attention thread (without the trailing `· Why?`). */
  reasons: Record<string, string>;
  /** The `N to review` chip: pending Likely and Maybe proposals, linking to the newest tray. */
  review: { count: number; extractionId: string } | null;
}

export async function getToday(client: SupabaseClient, timezone: string, now: Date): Promise<TodayData | null> {
  const fail = (step: string) => {
    log("threads_load_failed", { step, code: "query" });
    return null;
  };
  const since = new Date(now.getTime() - RECENTLY_RESOLVED_DAYS * 86_400_000).toISOString();
  const [active, resolved, pending] = await Promise.all([
    client.from("threads").select(COLUMNS).in("status", ["open", "waiting", "snoozed"]).limit(500),
    client.from("threads").select(COLUMNS).eq("status", "resolved").gte("resolved_at", since).order("resolved_at", { ascending: false }).limit(100),
    // Rule 4 / D4: an unaccepted Low proposal never surfaces in Today, not even as a count.
    client
      .from("extraction_items")
      .select("extraction_id, band, type:payload->item->>type, label:payload->label")
      .eq("review_status", "pending")
      .in("band", ["high", "medium"])
      .limit(500),
  ]);
  if (active.error || resolved.error || pending.error) return fail("today");
  const threads = z.array(TodayThread).safeParse([...(active.data ?? []), ...(resolved.data ?? [])]);
  const items = z.array(Pending).safeParse(pending.data ?? []);
  if (!threads.success || !items.success) return fail("today_parse");

  const sections = todaySections(threads.data, timezone, now);

  // Reason lines need the source's date phrase and written-on date for the (at most 5) attention rows.
  const ids = sections.attention.map((t) => t.id);
  const sourceIds = [...new Set(sections.attention.map((t) => t.primary_source_id).filter((s): s is string => s !== null))];
  // Same tray rules as the Review Tray: no key facts (D5) and no unlabeled (Ignore) items (D3).
  const shown = items.data.filter((p) => p.type !== "key_fact" && p.label !== null && p.label !== undefined);
  const extractionIds = [...new Set(shown.map((p) => p.extraction_id))];
  const [dates, sources, extractions] = await Promise.all([
    ids.length ? client.from("extraction_items").select("thread_id, date_text:payload->item->>date_text").in("thread_id", ids) : null,
    sourceIds.length ? client.from("sources").select("id, title, kind, reference_date").in("id", sourceIds) : null,
    extractionIds.length ? client.from("extractions").select("id, status, created_at").in("id", extractionIds) : null,
  ]);
  if (dates?.error || sources?.error || extractions?.error) return fail("today_related");
  const dateRows = z.array(ItemDate).safeParse(dates?.data ?? []);
  const sourceRows = z.array(Source).safeParse(sources?.data ?? []);
  const extractionRows = z.array(ExtractionRow).safeParse(extractions?.data ?? []);
  if (!dateRows.success || !sourceRows.success || !extractionRows.success) return fail("today_related_parse");

  const dateText = new Map(dateRows.data.map((d) => [d.thread_id, d.date_text]));
  const sourceById = new Map(sourceRows.data.map((s) => [s.id, s]));
  const reasons: Record<string, string> = {};
  for (const t of sections.attention) {
    const source = t.primary_source_id ? (sourceById.get(t.primary_source_id) ?? null) : null;
    reasons[t.id] = reasonLine(t, { dateText: dateText.get(t.id) ?? null, source, timezone, now });
  }

  const done = new Map(extractionRows.data.filter((x) => x.status === "succeeded").map((x) => [x.id, parseInstant(x.created_at).getTime()]));
  const counted = shown.filter((p) => done.has(p.extraction_id));
  // The chip links to the newest tray that still has something to review.
  const newest = [...done.entries()]
    .filter(([id]) => counted.some((p) => p.extraction_id === id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const review: TodayData["review"] = newest ? { count: counted.length, extractionId: newest[0] } : null;

  return { sections, reasons, review };
}
