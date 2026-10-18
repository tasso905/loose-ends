import { describe, expect, it } from "vitest";
import type { Extraction, Item } from "@/lib/ai/schema";
import { isWholeText, matchFactUnit } from "@/lib/ai/grounding";
import { processExtraction } from "@/lib/pipeline/proposals";
import { containsWholePhrase } from "@/lib/pipeline/verifyQuotes";
import { transition } from "@/lib/threads/transition";

const ctx = { referenceDate: "2026-10-05", referenceDateSource: "user" as const, timezone: "America/New_York", logger: () => {} };

const item = (quote: string, over: Partial<Item> = {}): Item => ({
  type: "commitment", title: "t", owner: "user", counterparty: null, action: null, date_text: null, date_iso: null,
  amount_text: null, certainty: "explicit", uncertainty_notes: [], matches_thread_id: null, evidence: [{ quote, speaker: null }], ...over,
});
const ex = (items: Item[]): Extraction => ({ source_summary: "s", participants: [], items, brief: null });

describe("containsWholePhrase()", () => {
  it("matches whole words only, Unicode-aware", () => {
    expect(containsWholePhrase("Maybe later", "May")).toBe(false);
    expect(containsWholePhrase("Due May 3.", "May 3")).toBe(true);
    expect(containsWholePhrase("Café Zoë pays", "Zoë")).toBe(true);
    expect(containsWholePhrase("Zoëlle pays", "Zoë")).toBe(false);
  });

  it("is safe for punctuation in the phrase", () => {
    expect(containsWholePhrase("Pay by 10/9 please", "10/9")).toBe(true);
    expect(containsWholePhrase("Pay by 110/95", "10/9")).toBe(false);
    expect(containsWholePhrase("Due Oct. 9, 2026", "Oct. 9")).toBe(true);
    expect(containsWholePhrase("Total $2,400.", "$2,400")).toBe(true);
    expect(containsWholePhrase("a+b (c)", "(c)")).toBe(true);
  });
});

describe("date_text not in the source → no due date (round 4: quote fallback removed)", () => {
  it("never reads a date from the quote instead", () => {
    const src = "I'll send it Friday.";
    const out = processExtraction(ex([item("I'll send it Friday", { date_text: "by Fri.", date_iso: "2026-10-09" })]), { ...ctx, sourceText: src });
    expect(out.proposals[0]!.date).toMatchObject({ due_at: null, due_certainty: "none", agreement: "unanchored" });
  });
});

describe("Ask-why grounding: whole stored text only (round 5)", () => {
  it("user_reason and source_fact must be the whole stored text", () => {
    expect(isWholeText("The alternatives were more expensive.", "The alternatives were more expensive")).toBe(true);
    expect(isWholeText("more expensive", "The alternatives were more expensive")).toBe(false);
    expect(matchFactUnit("annual premium $1,470", "Annual premium $1,470.")).toBe("Annual premium $1,470");
    expect(matchFactUnit("Annual premium $1,470", "Annual premium $1,470, renews Oct 31.")).toBeNull();
    expect(matchFactUnit("Provider B doesn’t include flood cover", "Provider B doesn't include flood cover")).toBe("Provider B doesn't include flood cover");
    expect(matchFactUnit("Provider B does include flood cover", "Provider B does not include flood cover")).toBeNull();
    expect(matchFactUnit(" ", "x")).toBeNull();
  });
});

describe("N6: actor and via", () => {
  const fields = {
    title: "Send it", kind: "commitment" as const, next_action: null, counterparty: null, due_at: null, due_certainty: "none" as const,
    due_time_known: false, consequence: null, consequence_basis: null, waiting_on: null, expected_by: null, primary_source_id: null, confidence: 0.9,
  };
  it("ai creates only via auto_create; users never via auto_create", () => {
    expect(transition(null, { type: "create", via: "accept", extractionItemId: null, fields }, { actor: "ai" }).ok).toBe(false);
    expect(transition(null, { type: "create", via: "auto_create", extractionItemId: null, fields }, { actor: "user" }).ok).toBe(false);
    expect(transition(null, { type: "create", via: "auto_create", extractionItemId: null, fields }, { actor: "ai" }).ok).toBe(true);
  });
});

describe("round 4", () => {
  it("whole-phrase check refuses the front or back of a longer number", () => {
    expect(containsWholePhrase("Pay $2,400,000 now", "$2,400")).toBe(false);
    expect(containsWholePhrase("Ref 12-10/9", "10/9")).toBe(false);
    expect(containsWholePhrase("Due 10/9, please", "10/9")).toBe(true);
    expect(containsWholePhrase("Due May 3, 2026", "May 3")).toBe(true);
  });

  it("round 5: a date phrase may not drop a following year; an amount may not drop a digit group", () => {
    expect(containsWholePhrase("Due May 3, 2026", "May 3", "date")).toBe(false);
    expect(containsWholePhrase("Due 9 Oct '27", "9 Oct", "date")).toBe(false);
    expect(containsWholePhrase("Due May 3, then call", "May 3", "date")).toBe(true);
    expect(containsWholePhrase("Due May 3 at 10", "May 3", "date")).toBe(true);
    expect(containsWholePhrase("Pay $2,400 000 now", "$2,400", "amount")).toBe(false);
    expect(containsWholePhrase("Pay $2,400 by Friday", "$2,400", "amount")).toBe(true);
  });

});

describe("round 6", () => {
  it("a date phrase may not drop a year written before it", () => {
    expect(containsWholePhrase("Due 2027 Oct 9", "Oct 9", "date")).toBe(false);
    expect(containsWholePhrase("Due Oct 9", "Oct 9", "date")).toBe(true);
  });
});
