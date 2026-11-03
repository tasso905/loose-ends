import { describe, expect, it, vi } from "vitest";
import type { Extraction, Item } from "@/lib/ai/schema";
import { statesDate } from "@/lib/pipeline/briefClaims";
import { processExtraction } from "@/lib/pipeline/proposals";

/**
 * Eval gate (Oct 27), rule 3: a date is kept only when its phrase is inside the item's own verified
 * quote. Fixtures 07 g1, 21 g2 and 39 g1 took a date from a neighbouring sentence. The cleared
 * date leaves no due date and no "Not sure about" line that claims one.
 */

const ctx = { referenceDate: "2026-10-20", referenceDateSource: "user" as const, timezone: "America/Chicago" };
const item = (quote: string, over: Partial<Item> = {}): Item => ({
  type: "waiting_on", title: "t", owner: "other", counterparty: null, action: null, date_text: null, date_iso: null,
  amount_text: null, certainty: "explicit", uncertainty_notes: [], matches_thread_id: null, evidence: [{ quote, speaker: null }], ...over,
});
const ex = (items: Item[]): Extraction => ({ source_summary: "s", participants: [], items, brief: null });

const SOURCE = "Can you call the clinic Thursday at 10:30? Also Priya said she'd send the forms.";

describe("processExtraction(): a date from a neighbouring sentence", () => {
  it("is cleared: no due date, no date line, and date-stating notes are dropped", () => {
    const logger = vi.fn();
    const out = processExtraction(
      ex([
        item("Priya said she'd send the forms", {
          date_text: "Thursday at 10:30",
          date_iso: "2026-10-22T10:30:00",
          uncertainty_notes: ["Not clear if Thursday at 10:30 applies to the forms.", "Not clear which forms."],
        }),
      ]),
      { ...ctx, sourceText: SOURCE, logger },
    );
    const p = out.proposals[0]!;
    expect(p.item.date_text).toBeNull();
    expect(p.date).toMatchObject({ due_at: null, due_date: null, due_certainty: "none" });
    expect(p.not_sure).toEqual(["Not clear which forms."]);
    expect(p.item.uncertainty_notes).toEqual(["Not clear which forms."]);
    expect(p.not_sure.some(statesDate)).toBe(false);
    expect(logger).toHaveBeenCalledWith("field_unverified", expect.objectContaining({ field: "date_text", reason: "outside_quote" }));
  });

  it("a date inside the item's own quote is kept, with its notes", () => {
    const out = processExtraction(
      ex([
        item("Can you call the clinic Thursday at 10:30?", {
          type: "request",
          owner: "user",
          date_text: "Thursday at 10:30",
          date_iso: "2026-10-22T10:30:00",
          uncertainty_notes: ["Thursday at 10:30 could be AM or PM."],
        }),
      ]),
      { ...ctx, sourceText: SOURCE, logger: () => {} },
    );
    const p = out.proposals[0]!;
    expect(p.date.due_date).toBe("2026-10-22");
    expect(p.not_sure).toContain("Thursday at 10:30 could be AM or PM.");
  });
});

describe("statesDate()", () => {
  it.each(["Due Friday.", "by Oct 9", "at 5pm", "the 15th"])("'%s' states a date", (s) => expect(statesDate(s)).toBe(true));
  it.each(["Not clear which forms.", "Costs $1,470.", "Who must act is unclear.", "Right now it is unclear."])("'%s' does not", (s) =>
    expect(statesDate(s)).toBe(false),
  );
});
