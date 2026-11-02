import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getThreadDetail } from "@/lib/threads/read";
import { loadWhy } from "@/lib/threads/whyRead";

/**
 * Evidence and proposals from one extraction share created_at (one insert), so the first-quote
 * tie-break used to fall to a random uuid. Now: evidence by (created_at, start_offset, id) and
 * extraction_items by (created_at, item_index, id), in both the Why panel and Thread detail.
 *
 * A small in-memory stand-in for the supabase-js query builder (select / eq / in / order / limit /
 * maybeSingle), with PostgREST ordering semantics (ascending, NULLS LAST unless nullsFirst). The
 * live (created_at, id) check is tests/integration/why-order-live.test.ts.
 */

type Row = Record<string, unknown>;
type Order = { col: string; ascending: boolean; nullsFirst: boolean };

function fakeClient(tables: Record<string, Row[]>): SupabaseClient {
  const cmp = (a: unknown, b: unknown) => (a === b ? 0 : (a as string | number) < (b as string | number) ? -1 : 1);
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const orders: Order[] = [];
    let limit: number | null = null;
    const run = () => {
      const sorted = [...rows].sort((x, y) => {
        for (const o of orders) {
          const a = x[o.col] ?? null;
          const b = y[o.col] ?? null;
          if (a === null || b === null) {
            if (a === b) continue;
            return (a === null) === o.nullsFirst ? -1 : 1;
          }
          const c = cmp(a, b) * (o.ascending ? 1 : -1);
          if (c !== 0) return c;
        }
        return 0;
      });
      return limit === null ? sorted : sorted.slice(0, limit);
    };
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => ((rows = rows.filter((r) => r[col] === v)), q),
      in: (col: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[col]))), q),
      order: (col: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) => {
        const ascending = o.ascending ?? true;
        orders.push({ col, ascending, nullsFirst: o.nullsFirst ?? !ascending });
        return q;
      },
      limit: (n: number) => ((limit = n), q),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: run(), error: null }),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const T = "11111111-1111-4111-8111-111111111111";
const SRC = "22222222-2222-4222-8222-222222222222";
const EX = "33333333-3333-4333-8333-333333333333";
const AT = "2026-10-20T12:00:00.000Z"; // one insert: every row shares it
const LOW_ID = "00000000-0000-4000-8000-000000000001"; // sorts first by uuid
const HIGH_ID = "ffffffff-ffff-4fff-8fff-fffffffffff1"; // sorts last by uuid

const TEXT = "I will send the cedar quote Friday. The fence goes in Monday.";
const tables = (): Record<string, Row[]> => ({
  threads: [
    {
      id: T, title: "Send the cedar quote", kind: "commitment", status: "open", due_at: null, due_certainty: "none", due_time_known: false,
      snoozed_until: null, resolved_at: null, updated_at: AT, created_at: AT, counterparty: null, waiting_on: null, expected_by: null,
      next_action: null, resolution: null, primary_source_id: SRC,
    },
  ],
  // The earlier quote in the source has the uuid that sorts LAST; the later one sorts first.
  evidence: [
    { id: LOW_ID, thread_id: T, quote: "The fence goes in Monday.", start_offset: 36, end_offset: 61, page: null, source_id: SRC, extraction_item_id: null, created_at: AT },
    { id: HIGH_ID, thread_id: T, quote: "I will send the cedar quote Friday.", start_offset: 0, end_offset: 35, page: null, source_id: SRC, extraction_item_id: null, created_at: AT },
  ],
  // The first proposal (item_index 0) has the uuid that sorts LAST.
  extraction_items: [
    { id: LOW_ID, thread_id: T, extraction_id: EX, item_index: 1, band: "low", payload: { label: { word: "Also noticed", reason: "second" } }, created_at: AT },
    { id: HIGH_ID, thread_id: T, extraction_id: EX, item_index: 0, band: "high", payload: { label: { word: "Likely", reason: "first" } }, created_at: AT },
  ],
  thread_events: [],
  decisions: [],
  extractions: [{ id: EX, brief: null, source_id: SRC }],
  sources: [{ id: SRC, title: null, kind: "paste", reference_date: "2026-10-20", text_content: TEXT }],
});

describe("first quote and proposal with a shared created_at", () => {
  it("Thread detail lists evidence in source order and takes the first proposal by item index", async () => {
    const r = await getThreadDetail(fakeClient(tables()), T);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.detail.evidence.map((e) => e.quote)).toEqual(["I will send the cedar quote Friday.", "The fence goes in Monday."]);
    expect(r.detail.origin).toEqual({ band: "high", label: { word: "Likely", reason: "first" } });
  });

  it("the Why panel shows the same first quote and proposal", async () => {
    const r = await loadWhy(fakeClient(tables()), T, "America/New_York", new Date(AT));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.evidenceId).toBe(HIGH_ID); // the quote at offset 0, though its uuid sorts last
    expect(JSON.stringify(r.view.quote)).toContain("I will send the cedar quote Friday.");
    expect(r.view.origin).toEqual({ band: "high", label: { word: "Likely", reason: "first" } });
  });

  it("a row with no start_offset sorts after rows that have one (NULLS LAST)", async () => {
    const t = tables();
    t.evidence![1]!.start_offset = null;
    const r = await getThreadDetail(fakeClient(t), T);
    expect(r.ok && r.detail.evidence[0]!.quote).toBe("The fence goes in Monday.");
  });

  it("an earlier created_at still wins over a smaller offset", async () => {
    const t = tables();
    t.evidence![0]!.created_at = "2026-10-20T11:00:00.000Z";
    const r = await getThreadDetail(fakeClient(t), T);
    expect(r.ok && r.detail.evidence[0]!.quote).toBe("The fence goes in Monday.");
  });
});
