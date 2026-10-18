import { describe, expect, it, vi } from "vitest";
import type { Item } from "@/lib/ai/schema";
import { normalizeForMatch, pageForOffset, toOriginalRange } from "@/lib/pipeline/normalize";
import { approximateSearch, locateQuote, quoteHash, suppressionHash, verifyBrief, verifyQuotes } from "@/lib/pipeline/verifyQuotes";

const SOURCE = `Hi Sam,

Thanks Mike —   I’ll send you the revised
proposal Friday. We should grab lunch sometime.

Also: Legal still has the contract, so we're waiting on them.`;

function item(quote: string, over: Partial<Item> = {}): Item {
  return {
    type: "commitment",
    title: "t",
    owner: "user",
    counterparty: null,
    action: null,
    date_text: null,
    date_iso: null,
    amount_text: null,
    certainty: "explicit",
    uncertainty_notes: [],
    matches_thread_id: null,
    evidence: [{ quote, speaker: null }],
    ...over,
  };
}

describe("normalizeForMatch()", () => {
  it("collapses whitespace, folds typographic quotes and keeps an offset map", () => {
    const n = normalizeForMatch("  a\n\n b’c  ");
    expect(n.text).toBe("a b'c");
    expect(n.map.slice(0, 5)).toEqual([2, 3, 6, 7, 8]);
    expect(toOriginalRange(n, 2, 5)).toEqual({ start: 6, end: 9 });
  });

  it("pageForOffset maps offsets to 1-based pages", () => {
    expect(pageForOffset([0, 100, 250], 0)).toBe(1);
    expect(pageForOffset([0, 100, 250], 120)).toBe(2);
    expect(pageForOffset([0, 100, 250], 999)).toBe(3);
    expect(pageForOffset(null, 5)).toBeNull();
  });
});

describe("verifyQuotes(): exact matches", () => {
  it("matches across line breaks and curly apostrophes, storing the source's own text", () => {
    const r = verifyQuotes([item("I'll send you the revised proposal Friday")], SOURCE, { logger: () => {} });
    expect(r.items).toHaveLength(1);
    const ev = r.items[0]!.evidence[0]!;
    expect(ev.match_kind).toBe("exact");
    expect(ev.similarity).toBe(1);
    expect(ev.quote).toBe("I’ll send you the revised\nproposal Friday");
    expect(SOURCE.slice(ev.start_offset, ev.end_offset)).toBe(ev.quote);
  });

  it("assigns pages from page_offsets", () => {
    const at = SOURCE.indexOf("Legal");
    const r = verifyQuotes([item("Legal still has the contract")], SOURCE, { pageOffsets: [0, at - 5], logger: () => {} });
    expect(r.items[0]!.evidence[0]!.page).toBe(2);
  });
});

describe("verifyQuotes(): fuzzy matches (≥ 0.9)", () => {
  it("accepts a near-verbatim quote as fuzzy, with the source span", () => {
    // one character changed and one dropped in a 44-char quote
    const r = verifyQuotes([item("I'll send you the revized proposal Friday")], SOURCE, { logger: () => {} });
    expect(r.items).toHaveLength(1);
    const ev = r.items[0]!.evidence[0]!;
    expect(ev.match_kind).toBe("fuzzy");
    expect(ev.similarity).toBeGreaterThanOrEqual(0.9);
    expect(ev.quote).toContain("proposal Friday");
  });

  it("is case-insensitive in the fuzzy pass", () => {
    const r = verifyQuotes([item("we should grab lunch sometime")], SOURCE, { logger: () => {} });
    expect(r.items[0]!.evidence[0]!.match_kind).toBe("fuzzy");
    expect(r.items[0]!.evidence[0]!.quote).toBe("We should grab lunch sometime");
  });

  it("rejects a paraphrase below 0.9", () => {
    const r = verifyQuotes([item("I will email Mike the new proposal on Friday")], SOURCE, { logger: () => {} });
    expect(r.items).toHaveLength(0);
  });
});

describe("verifyQuotes(): rule 1 — no verified quote, no item", () => {
  it("drops a hallucinated item and logs quote_unverified without content", () => {
    const logger = vi.fn();
    const r = verifyQuotes([item("I will call the insurer tomorrow morning")], SOURCE, { logger, extractionId: "ex-1" });
    expect(r.items).toHaveLength(0);
    expect(r.droppedItemIndexes).toEqual([0]);
    expect(logger).toHaveBeenCalledWith("quote_unverified", expect.objectContaining({ extraction_id: "ex-1", item_index: 0, evidence_index: 0 }));
    const props = logger.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.values(props).some((v) => typeof v === "string" && v.includes("insurer"))).toBe(false);
  });

  it("keeps an item with one verified quote and drops only the unverified one", () => {
    const it2 = item("We should grab lunch sometime", {
      evidence: [
        { quote: "We should grab lunch sometime", speaker: "Sam" },
        { quote: "Let's do Thursday at noon", speaker: "Sam" },
      ],
    });
    const r = verifyQuotes([it2], SOURCE, { logger: () => {} });
    expect(r.items[0]!.evidence).toHaveLength(1);
    expect(r.droppedQuotes).toEqual([{ itemIndex: 0, evidenceIndex: 1, similarity: expect.any(Number) }]);
  });

  it("clears an amount or counterparty that is not in the source (rule 3)", () => {
    const logger = vi.fn();
    const r = verifyQuotes([item("Legal still has the contract", { amount_text: "$2,400", counterparty: "Legal" })], SOURCE, { logger });
    expect(r.items[0]!.item.amount_text).toBeNull();
    expect(r.items[0]!.item.counterparty).toBe("Legal");
    expect(logger).toHaveBeenCalledWith("field_unverified", expect.objectContaining({ field: "amount_text" }));
  });
});

describe("approximateSearch()", () => {
  it("finds the best substring by edit distance", () => {
    expect(approximateSearch("abcd", "xxabzdxx")).toEqual({ distance: 1, start: 2, end: 6 });
    expect(approximateSearch("abc", "abc")).toEqual({ distance: 0, start: 0, end: 3 });
  });

  it("handles a 30,000-character source within a reasonable time", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(1100).slice(0, 29_900);
    const src = `${filler} I'll send you the revised proposal Friday.`;
    const t0 = performance.now();
    const m = locateQuote("I'll send you the revized proposal Friday", src);
    expect(m?.match_kind).toBe("fuzzy");
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe("hashes", () => {
  it("quoteHash ignores whitespace and apostrophe style", () => {
    expect(quoteHash("I’ll  send")).toBe(quoteHash("I'll send"));
  });

  it("suppressionHash depends on both source and quote", () => {
    expect(suppressionHash(SOURCE, "a b c")).toBe(suppressionHash(SOURCE, "a  b c"));
    expect(suppressionHash(SOURCE, "a b c")).not.toBe(suppressionHash(`${SOURCE}!`, "a b c"));
  });
});

describe("verifyBrief()", () => {
  it("keeps verified source lines, drops unverified ones, and forces worth_considering to interpretation", () => {
    const b = verifyBrief(
      {
        what_this_is: [{ text: "A note from Mike", basis: "source", quote: "Thanks Mike" }],
        what_to_do: [{ text: "Send the proposal", basis: "source", quote: "Send it by Tuesday" }],
        by_when: [],
        if_you_dont: [{ text: "Mike may be waiting", basis: "interpretation", quote: "should not be shown" }],
        worth_considering: [{ text: "Check with Legal", basis: "source", quote: "Legal still has the contract" }],
        not_sure_about: ["Which proposal"],
      },
      SOURCE,
      { logger: () => {} },
    );
    expect(b.what_this_is).toHaveLength(1);
    expect(b.what_this_is[0]!.basis).toBe("source");
    expect(b.what_to_do).toHaveLength(0);
    expect(b.if_you_dont[0]).toMatchObject({ basis: "interpretation", quote: null });
    expect(b.worth_considering[0]).toMatchObject({ basis: "interpretation", quote: null });
    expect(b.not_sure_about).toEqual(["Which proposal"]);
  });
});

describe("verifyQuotes(): date_text must be in the source (round 2 fix)", () => {
  it("clears a date_text the source does not contain and logs it", () => {
    const logger = vi.fn();
    const r = verifyQuotes([item("We should grab lunch sometime", { date_text: "Thursday", date_iso: "2026-10-08" })], SOURCE, { logger });
    expect(r.items[0]!.item.date_text).toBeNull();
    expect(logger).toHaveBeenCalledWith("field_unverified", expect.objectContaining({ field: "date_text" }));
  });

  it("keeps a date_text that is in the source", () => {
    const r = verifyQuotes([item("proposal Friday", { date_text: "Friday" })], SOURCE, { logger: () => {} });
    expect(r.items[0]!.item.date_text).toBe("Friday");
  });
});
