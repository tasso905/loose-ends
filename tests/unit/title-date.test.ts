import { describe, expect, it, vi } from "vitest";
import { extract } from "@/lib/ai/extract";
import { createRecordedModel } from "@/lib/ai/fake";
import type { Extraction, Item } from "@/lib/ai/schema";
import { datePhrases, stripDatePhrases } from "@/lib/pipeline/briefClaims";
import { processExtraction, quoteTitle, unbackedDateFree } from "@/lib/pipeline/proposals";

/**
 * Rule 3 follow-up (eval gate, Oct 28): once a date is cleared (it was not inside the item's own
 * quote), the model's `title` and `action` must not still state it. A date phrase in either must be
 * inside the verified date_text; otherwise it is stripped with its connector, the title falls back
 * to the quote and the action to null when stripping leaves no usable line. Logged as
 * field_unverified.
 */

const SOURCE = "Can you call the clinic Thursday at 10:30? Also Priya said she'd send the forms.";
const ctx = { referenceDate: "2026-10-20", referenceDateSource: "user" as const, timezone: "America/Chicago" };
const item = (quote: string, over: Partial<Item> = {}): Item => ({
  type: "waiting_on", title: "t", owner: "other", counterparty: null, action: null, date_text: null, date_iso: null,
  amount_text: null, certainty: "explicit", uncertainty_notes: [], matches_thread_id: null, evidence: [{ quote, speaker: null }], ...over,
});
const ex = (items: Item[]): Extraction => ({ source_summary: "s", participants: [], items, brief: null });

describe("stripDatePhrases() / unbackedDateFree()", () => {
  it.each([
    ["Get forms from Priya by Thursday", null, "Get forms from Priya"],
    ["Call clinic Thursday at 10:30", null, "Call clinic"],
    ["Send forms (due Oct 23)", null, "Send forms"],
    ["Pay rent on the 1st", null, "Pay rent"],
    ["Reply to Mike today", null, "Reply to Mike"],
    ["Confirm tile color by next Friday", "Friday", "Confirm tile color"],
    ["Crew visit Nov 13", "by Friday, November 13", "Crew visit"],
  ])("'%s' (date_text %s) → '%s'", (text, dateText, want) => {
    expect(unbackedDateFree(text, dateText, () => "FALLBACK")).toBe(want);
  });

  it.each([
    ["Send proposal to Mike by Friday", "Friday"],
    ["Submit timesheet by 5pm today", "by 5pm today"],
    ["Confirm tile color by next Friday", "next Friday"],
    ["Call May about the lease", null],
    ["Pick up the next book", null],
  ])("'%s' (date_text %s) is unchanged (the same string)", (text, dateText) => {
    expect(unbackedDateFree(text, dateText, () => "FALLBACK")).toBe(text);
  });

  it.each(["Friday", "By Friday", "Prep Friday's review", "Prepare the Oct 9 meeting notes"])("'%s' cannot be stripped cleanly: fallback", (text) => {
    expect(unbackedDateFree(text, null, () => "FALLBACK")).toBe("FALLBACK");
  });

  it("stripDatePhrases returns null when a connector is left dangling", () => {
    expect(stripDatePhrases("Send it to Dana and Friday", datePhrases("Send it to Dana and Friday"))).toBeNull();
  });

  it("quoteTitle keeps a short quote and cuts a long one at a word, under 80 characters", () => {
    expect(quoteTitle("  Priya said she'd\nsend the forms.  ")).toBe("Priya said she'd send the forms.");
    const long = quoteTitle("Please return the signed renewal form together with the updated insurance certificate and the parking permit application.");
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("processExtraction(): title and action after a date is cleared", () => {
  it("strips the cleared date from title and action, logs it, and keeps the rest", () => {
    const logger = vi.fn();
    const out = processExtraction(
      ex([
        item("Priya said she'd send the forms", {
          title: "Get forms from Priya by Thursday",
          action: "Priya sends the forms Thursday at 10:30",
          date_text: "Thursday at 10:30",
          date_iso: "2026-10-22T10:30:00",
        }),
      ]),
      { ...ctx, sourceText: SOURCE, logger },
    );
    const p = out.proposals[0]!;
    expect(p.date.due_at).toBeNull();
    expect(p.item.title).toBe("Get forms from Priya");
    expect(p.item.action).toBe("Priya sends the forms");
    expect(logger).toHaveBeenCalledWith("field_unverified", expect.objectContaining({ field: "title", reason: "date_unbacked_stripped" }));
    expect(logger).toHaveBeenCalledWith("field_unverified", expect.objectContaining({ field: "action", reason: "date_unbacked_stripped" }));
  });

  it("falls back to the quote for the title and null for the action when nothing usable is left", () => {
    const logger = vi.fn();
    const out = processExtraction(
      ex([item("Priya said she'd send the forms", { title: "Thursday", action: "By Thursday", date_text: "Thursday", date_iso: "2026-10-22" })]),
      { ...ctx, sourceText: SOURCE, logger },
    );
    const p = out.proposals[0]!;
    expect(p.item.title).toBe("Priya said she'd send the forms");
    expect(p.item.action).toBeNull();
    expect(logger).toHaveBeenCalledWith("field_unverified", expect.objectContaining({ field: "action", reason: "date_unbacked_cleared" }));
  });

  it("a title date the model made up with no date_text at all is stripped too", () => {
    const out = processExtraction(ex([item("Priya said she'd send the forms", { title: "Get forms from Priya by Oct 30" })]), {
      ...ctx,
      sourceText: SOURCE,
      logger: () => {},
    });
    expect(out.proposals[0]!.item.title).toBe("Get forms from Priya");
  });

  it("a title that repeats the verified in-quote date is kept as written, with no log", () => {
    const logger = vi.fn();
    const out = processExtraction(
      ex([
        item("Can you call the clinic Thursday at 10:30?", {
          type: "request",
          owner: "user",
          title: "Call the clinic Thursday at 10:30",
          action: "Call the clinic on Thursday",
          date_text: "Thursday at 10:30",
          date_iso: "2026-10-22T10:30:00",
        }),
      ]),
      { ...ctx, sourceText: SOURCE, logger },
    );
    const p = out.proposals[0]!;
    expect(p.item.title).toBe("Call the clinic Thursday at 10:30");
    expect(p.item.action).toBe("Call the clinic on Thursday");
    expect(logger).not.toHaveBeenCalledWith("field_unverified", expect.objectContaining({ field: "title" }));
  });
});

describe("extract() with the fake provider → pipeline", () => {
  it("a recorded model output whose title carries a neighbouring sentence's date is stripped end to end", async () => {
    const recorded = ex([
      item("Priya said she'd send the forms", {
        title: "Get forms from Priya by Thursday",
        action: null,
        date_text: "Thursday",
        date_iso: "2026-10-22",
        uncertainty_notes: ["Thursday may belong to the clinic call."],
      }),
    ]);
    const model = createRecordedModel({ recordings: [{ name: "title-date", task: "extract", input: SOURCE, responses: [recorded] }] });
    const run = await extract(
      { sourceText: SOURCE, sourceKind: "paste", ...ctx, user: { displayName: "Sam", aliases: [] } },
      { model, modelLabel: "fake:recorded", logger: () => {} },
    );
    const p = processExtraction(run.output, { ...ctx, sourceText: SOURCE, logger: () => {} }).proposals[0]!;
    expect(p.item).toMatchObject({ title: "Get forms from Priya", date_text: null, uncertainty_notes: [] });
    expect(p.date.due_date).toBeNull();
    expect(p.not_sure).toEqual([]);
  });
});
