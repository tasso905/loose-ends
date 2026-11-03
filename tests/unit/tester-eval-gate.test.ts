import { describe, expect, it } from "vitest";
import type { Extraction, Item } from "@/lib/ai/schema";
import { processExtraction, unbackedDateFree } from "@/lib/pipeline/proposals";

/**
 * Lead-tester verification of fix/eval-gate (c3abb77): the date-in-quote rule (verifyFields) and
 * the title/action date stripping (unbackedDateFree). Synthetic text only.
 * `it` = REGRESSION GUARD (verified behaviour). `it.fails` = OPEN DEFECT: it asserts the required
 * (safe) behaviour and currently fails; when fixed, change it to `it` and relabel it.
 */

const ctx = { referenceDate: "2026-10-20", referenceDateSource: "user" as const, timezone: "America/Chicago" };
const item = (quote: string, over: Partial<Item> = {}): Item => ({
  type: "request", title: "Synthetic title", owner: "user", counterparty: null, action: null, date_text: null, date_iso: null,
  amount_text: null, certainty: "explicit", uncertainty_notes: [], matches_thread_id: null, evidence: [{ quote, speaker: null }], ...over,
});
const ex = (items: Item[]): Extraction => ({ source_summary: "s", participants: [], items, brief: null });
const run = (source: string, items: Item[]) => processExtraction(ex(items), { ...ctx, sourceText: source, logger: () => {} });

describe("date-in-quote rule: correct dates survive", () => {
  const SOURCE = "Hi Sam. Could you send the signed lease back by Friday, October 23? Thanks, Ravi";

  it("a date_text with different case and spacing from the quote is kept", () => {
    const p = run(SOURCE, [item("Could you send the signed lease back by Friday, October 23?", { date_text: "by friday,  october 23", date_iso: "2026-10-23" })]).proposals[0]!;
    expect(p.item.date_text).not.toBeNull();
    expect(p.date.due_date).toBe("2026-10-23");
  });

  it("a fuzzy-verified quote (a typo the model 'fixed') still anchors its date", () => {
    const TYPO = "Could you send the signd lease back by Friday, October 23? Thanks, Ravi";
    const p = run(TYPO, [item("Could you send the signed lease back by Friday, October 23?", { date_text: "by Friday, October 23", date_iso: "2026-10-23" })]).proposals[0]!;
    expect(p.evidence[0]!.match_kind).toBe("fuzzy");
    expect(p.date.due_date).toBe("2026-10-23");
  });

  it("a date in the second of two verified quotes anchors the item", () => {
    const S = "Can you book the hall? It needs to be confirmed by Thursday.";
    const p = run(S, [
      item("Can you book the hall?", { date_text: "by Thursday", date_iso: "2026-10-22", evidence: [{ quote: "Can you book the hall?", speaker: null }, { quote: "It needs to be confirmed by Thursday.", speaker: null }] }),
    ]).proposals[0]!;
    expect(p.date.due_date).toBe("2026-10-22");
  });

  it("a date from a neighbouring sentence is cleared and costs no score (unanchored, not disagree)", () => {
    const S = "Can you book the hall? The party is on Saturday.";
    const p = run(S, [item("Can you book the hall?", { date_text: "on Saturday", date_iso: "2026-10-24" })]).proposals[0]!;
    expect(p.date.due_date).toBeNull();
    expect(p.signals).not.toContain("date_disagrees");
    expect(p.band).toBe("high"); // 0.80 + 0.05 exact
  });
});

describe("title/action stripping: no title states an unbacked date (rule 3)", () => {
  it.each([
    ["Return the form by Oct 23", "by Friday, October 23", "Return the form"], // reformatted verified date: dropped, shown in the date field
    ["Send the link Thursday", "tomorrow", "Send the link"], // a resolved restatement of a relative date
    // T-T1 fix: "March trip" is an event name, not a date claim, so it is kept (was stripped at c3abb77).
    ["Book the cabin for the March trip", null, "Book the cabin for the March trip"],
  ])("'%s' (date_text %s) → '%s'", (title, dateText, want) => {
    expect(unbackedDateFree(title, dateText, () => "FALLBACK")).toBe(want);
  });
});

// T-T1, FIXED on fix/eval-gate (was an open defect at c3abb77; pins flipped to `it`): chrono reads a month or weekday used as a
// person's name or inside an event name as a date, so it is cut out of the title even when the
// model claimed no date at all, and the title then names the wrong thing ("Drive Mia to school")
// or no one ("Call about the lease"). The source quote still shows the original words.
describe("title stripping keeps names and event names that are not due dates", () => {
  it.each([
    ["Call June about the lease"],
    ["Ask April for the spare keys"],
    ["Email August Wilson the contract"],
    ["Drive Mia to Sunday school"],
    ["Prepare the Black Friday sale signs"],
  ])("'%s' with no date_text is unchanged", (title) => {
    expect(unbackedDateFree(title, null, () => "FALLBACK")).toBe(title);
  });
});
