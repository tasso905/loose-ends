import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { log } from "@/lib/log";
import { Band, DueCertainty, ThreadKind, ThreadStatus } from "@/lib/schemas";
import { why, type WhyView } from "./why";

/**
 * F8 Why panel read, with the user's own client (RLS: another user's thread reads as not found).
 * Stored rows only; why() turns them into sentences with fixed templates (rule 6).
 */

const Thread = z.object({
  id: z.uuid(),
  title: z.string(),
  kind: ThreadKind,
  status: ThreadStatus,
  due_at: z.string().nullable(),
  due_certainty: DueCertainty,
  snoozed_until: z.string().nullable(),
  resolved_at: z.string().nullable(),
  created_at: z.string(),
  counterparty: z.string().nullable(),
  waiting_on: z.string().nullable(),
  expected_by: z.string().nullable(),
});
const Evidence = z.object({
  id: z.uuid(),
  quote: z.string(),
  start_offset: z.number().int().nullable(),
  end_offset: z.number().int().nullable(),
  page: z.number().int().nullable(),
  source_id: z.uuid().nullable(),
});
const Item = z.object({ band: Band, payload: z.unknown() });
const Event = z.object({
  type: z.string(),
  actor: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
const Source = z.object({ id: z.uuid(), title: z.string().nullable(), kind: z.string(), reference_date: z.string(), text_content: z.string().nullable() });

export type WhyResult = { ok: true; view: WhyView } | { ok: false; reason: "not_found" | "failed" };

export async function loadWhy(client: SupabaseClient, threadId: string, timezone: string, now: Date): Promise<WhyResult> {
  const fail = (step: string): WhyResult => {
    log("why_load_failed", { step });
    return { ok: false, reason: "failed" };
  };
  const t = await client
    .from("threads")
    .select("id, title, kind, status, due_at, due_certainty, snoozed_until, resolved_at, created_at, counterparty, waiting_on, expected_by")
    .eq("id", threadId)
    .maybeSingle();
  if (t.error) return fail("thread");
  if (!t.data) return { ok: false, reason: "not_found" };
  const thread = Thread.safeParse(t.data);
  if (!thread.success) return fail("thread_parse");

  const [ev, items, events] = await Promise.all([
    client.from("evidence").select("id, quote, start_offset, end_offset, page, source_id").eq("thread_id", threadId).order("created_at").order("start_offset", { nullsFirst: false }).order("id").limit(1),
    client.from("extraction_items").select("band, payload").eq("thread_id", threadId).order("created_at").order("item_index").order("id").limit(1),
    client.from("thread_events").select("type, actor, before, after").eq("thread_id", threadId).eq("type", "edited").order("id"),
  ]);
  if (ev.error || items.error || events.error) return fail("related");
  const evidence = z.array(Evidence).safeParse(ev.data ?? []);
  const item = z.array(Item).safeParse(items.data ?? []);
  const history = z.array(Event).safeParse(events.data ?? []);
  if (!evidence.success || !item.success || !history.success) return fail("related_parse");

  const first = evidence.data[0] ?? null;
  let source: z.infer<typeof Source> | null = null;
  if (first?.source_id) {
    const s = await client.from("sources").select("id, title, kind, reference_date, text_content").eq("id", first.source_id).maybeSingle();
    if (s.error) return fail("source");
    if (s.data) {
      const parsed = Source.safeParse(s.data);
      if (!parsed.success) return fail("source_parse");
      source = parsed.data;
    }
  }

  return {
    ok: true,
    view: why({
      thread: thread.data,
      evidence: first,
      source,
      // F13 source deletion does not record a date yet; the panel says so without one.
      sourceDeletedAt: null,
      item: item.data[0] ?? null,
      events: history.data,
      timezone,
      now,
    }),
  };
}
