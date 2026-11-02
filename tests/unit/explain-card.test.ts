import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExplainBrief, mergeNotSure, parseBrief } from "@/components/review/ExplainBrief";
import { readDocument } from "@/lib/capture/document";
import { unsupportedClaims } from "@/lib/pipeline/briefClaims";
import { verifyBrief } from "@/lib/pipeline/verifyQuotes";
import { NOT_SURE_FALLBACK, threadNotSure } from "@/lib/threads/explain";
import { sourceCaption } from "@/lib/threads/view";
import { renewalPdf } from "../fixtures/documents";

const doc = await readDocument(renewalPdf(), "renewal.pdf");
if (!doc.ok) throw new Error("fixture not read");
const TEXT = doc.text;

const emptyBrief = { what_this_is: [], what_to_do: [], by_when: [], if_you_dont: [], worth_considering: [], not_sure_about: [] };

describe("rule 3 on Explain card lines (briefClaims)", () => {
  it("a date or amount written as in the source is supported", () => {
    expect(unsupportedClaims("It renews on October 31, 2026.", TEXT)).toEqual([]);
    expect(unsupportedClaims("The premium goes up to $1,470.", TEXT)).toEqual([]);
    expect(unsupportedClaims("Worth checking other insurers now.", TEXT)).toEqual([]);
    expect(unsupportedClaims("Nothing to pay today", TEXT)).toEqual(["date"]); // "today" is a date claim the source never makes
  });

  it("a computed or reworded date is unsupported", () => {
    expect(unsupportedClaims("Call by October 30, 2026 to be safe.", TEXT)).toEqual(["date"]);
    expect(unsupportedClaims("Renewal is in 10 days.", TEXT)).toEqual(["date"]);
  });

  it("a rounded or invented amount is unsupported", () => {
    expect(unsupportedClaims("That is about $1,500 a year.", TEXT)).toEqual(["amount"]);
    expect(unsupportedClaims("A rise of $270 on Nov 1.", TEXT)).toEqual(["date", "amount"]);
  });

  it("percentages and amounts in words must be in the source as written", () => {
    const src = "Rent goes up 4.5% from June 1, 2026. The deposit is two hundred dollars.";
    expect(unsupportedClaims("That is a 4.5% rise.", src)).toEqual([]);
    expect(unsupportedClaims("That is a 22.5% rise.", src)).toEqual(["amount"]);
    expect(unsupportedClaims("That is 22 percent more.", src)).toEqual(["amount"]);
    expect(unsupportedClaims("Keep the two hundred dollars deposit receipt.", src)).toEqual([]);
    expect(unsupportedClaims("Expect fifteen hundred dollars.", src)).toEqual(["amount"]);
    expect(unsupportedClaims("About two-hundred and fifty euros.", src)).toEqual(["amount"]);
  });

  it("word amounts match whole: the source's own amount is kept in any spacing, a part of it is not", () => {
    const src = "The fee is twenty-five dollars. A refund of two hundred and fifty euros. Budget 2.5 million dollars. Up twenty percent.";
    expect(unsupportedClaims("The fee is Twenty Five dollars.", src)).toEqual([]);
    expect(unsupportedClaims("A refund of two-hundred fifty euros.", src)).toEqual([]);
    expect(unsupportedClaims("A budget of 2.5 million dollars.", src)).toEqual([]);
    expect(unsupportedClaims("A twenty per cent rise.", src)).toEqual([]);
    expect(unsupportedClaims("About five dollars.", src)).toEqual(["amount"]);
    expect(unsupportedClaims("A budget of 1.5 million dollars.", src)).toEqual(["amount"]);
    expect(unsupportedClaims("A thirty percent rise.", src)).toEqual(["amount"]);
  });

  it("a word amount after a year, page or list number is still checked, on both sides", () => {
    expect(unsupportedClaims("By 2027, fifty dollars more.", "The fee is ten dollars.")).toEqual(["amount"]);
    expect(unsupportedClaims("Page 3. Twenty dollars is due.", "The fee is ten dollars.")).toEqual(["amount"]);
    expect(unsupportedClaims("Pay two hundred dollars.", "On Oct 5, two hundred dollars was paid.")).toEqual([]);
  });

  it("the source's own date repeated without its year is supported; a different year is not", () => {
    const src = "Your home policy renews on October 31, 2026.";
    expect(unsupportedClaims("Whether October 31 is a hard deadline.", src)).toEqual([]);
    expect(unsupportedClaims("Whether October 31, 2027 is a hard deadline.", src)).toEqual(["date"]);
    expect(unsupportedClaims("Whether October 30 is a hard deadline.", src)).toEqual(["date"]);
  });
});

describe("verifyBrief(): pages and rule 3", () => {
  it("source lines carry their page; interpretation lines with invented dates or amounts are dropped and logged", () => {
    const logger = vi.fn();
    const b = verifyBrief(
      {
        ...emptyBrief,
        what_this_is: [{ text: "Renewal notice", basis: "source", quote: "Policy renewal notice for policy HM-000-TEST" }],
        by_when: [
          { text: "By Oct 31", basis: "source", quote: "call us before October 31, 2026" },
          { text: "Best to call by October 29, 2026", basis: "interpretation", quote: null },
        ],
        if_you_dont: [
          { text: "The new premium is charged", basis: "interpretation", quote: null },
          { text: "You'd pay about $1,500", basis: "interpretation", quote: null },
        ],
        not_sure_about: ["Whether $1,470 includes taxes", "Whether the rise starts on Nov 1"],
      },
      TEXT,
      { pageOffsets: doc.pageOffsets, logger },
    );
    expect(b.what_this_is[0]).toMatchObject({ basis: "source", page: 1 });
    expect(b.by_when).toHaveLength(1);
    expect(b.by_when[0]).toMatchObject({ quote: "call us before October 31, 2026", page: 2 });
    expect(b.if_you_dont.map((l) => l.text)).toEqual(["The new premium is charged"]);
    expect(b.not_sure_about).toEqual(["Whether $1,470 includes taxes"]);
    expect(logger).toHaveBeenCalledWith("brief_line_unverified", expect.objectContaining({ brief_section: "by_when", line_index: 1, claim: "date" }));
    expect(logger).toHaveBeenCalledWith("brief_line_unverified", expect.objectContaining({ brief_section: "if_you_dont", claim: "amount" }));
    expect(logger).toHaveBeenCalledWith("brief_line_unverified", expect.objectContaining({ brief_section: "not_sure_about", line_index: 1 }));
    // Rule 9: no text in the log.
    for (const [, props] of logger.mock.calls) expect(JSON.stringify(props)).not.toMatch(/October|1,500|Nov/);
  });

  it("without a page map, page is null", () => {
    const b = verifyBrief({ ...emptyBrief, what_this_is: [{ text: "x", basis: "source", quote: "Thanks Mike" }] }, "Thanks Mike, see you.", {
      logger: () => {},
    });
    expect(b.what_this_is[0]?.page).toBeNull();
  });
});

const SOURCE = { title: "Renewal notice", kind: "upload", reference_date: "2026-10-05" };

describe("Explain card render (F7)", () => {
  const brief = {
    ...emptyBrief,
    what_this_is: [{ text: "paraphrase", basis: "source", quote: "Policy renewal notice for policy HM-000-TEST", page: 1, match: null }],
    what_to_do: [{ text: "Decide whether to shop around", basis: "interpretation", quote: null, match: null }],
    by_when: [{ text: "Oct 31", basis: "source", quote: "call us before October 31, 2026", page: 2, match: null }],
    if_you_dont: [{ text: "x", basis: "source", quote: "If you do nothing, the new premium of $1,470 will be charged.", page: 2, match: null }],
    worth_considering: [{ text: "Compare two other quotes", basis: "interpretation", quote: null, match: null }],
    not_sure_about: ["Whether the rise includes tax"],
  };
  const html = renderToStaticMarkup(createElement(ExplainBrief, { brief, source: SOURCE, notSure: ["The source suggests this but doesn't say it outright."] }));

  it("source lines are quotes with the source and page; the model's paraphrase is not shown", () => {
    expect(html).toMatch(/font-serif[^>]*>call us before October 31, 2026</);
    expect(html).toContain("Renewal notice · p. 2");
    expect(html).toContain("Renewal notice · p. 1");
    expect(html).not.toContain("paraphrase");
  });

  it("every What/When/If-you-don't line is a quote or labelled Interpretation", () => {
    expect(html).toContain(">Interpretation<");
    expect(html).toContain("Decide whether to shop around");
  });

  it("sections in order; Worth considering not rendered (D18 deferred)", () => {
    const order = ["What this is", "What you need to do", "By when", "If you don&#x27;t", "Not sure about"].map((s) => html.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain("Worth considering");
    expect(html).not.toContain("Compare two other quotes");
  });

  it("Not sure about merges the brief's and the thread's lines", () => {
    expect(html).toContain("Whether the rise includes tax");
    expect(html).toContain("doesn&#x27;t say it outright");
  });

  it("a brief with nothing showable renders nothing", () => {
    expect(parseBrief({ ...emptyBrief, by_when: [{ text: "x", basis: "source", quote: null }] })).toBeNull();
    expect(renderToStaticMarkup(createElement(ExplainBrief, { brief: null }))).toBe("");
  });

  it("a deleted source labels its quotes Source deleted", () => {
    const out = renderToStaticMarkup(createElement(ExplainBrief, { brief, source: null }));
    expect(out).toContain("Source deleted");
  });
});

describe("threadNotSure (F7: Not sure about whenever certainty != explicit)", () => {
  const thread = { due_at: "2026-10-31T03:59:00Z", due_certainty: "explicit" };
  it("explicit item, explicit date: nothing", () => {
    expect(threadNotSure({ not_sure: [], item: { certainty: "explicit", uncertainty_notes: [] } }, thread)).toEqual([]);
  });
  it("implied or speculative with no note of its own gets the template line", () => {
    expect(threadNotSure({ not_sure: [], item: { certainty: "implied", uncertainty_notes: [] } }, thread)).toEqual([NOT_SURE_FALLBACK.implied]);
    expect(threadNotSure({ not_sure: ["Casual"], item: { certainty: "speculative", uncertainty_notes: ["Casual"] } }, thread)).toEqual(["Casual"]);
  });
  it("an inferred date keeps its notes; once the user sets the date they go", () => {
    const p = { not_sure: ["It doesn't say AM or PM."], item: { certainty: "explicit" as const, uncertainty_notes: [] }, date: { not_sure: ["It doesn't say AM or PM."] } };
    expect(threadNotSure(p, { ...thread, due_certainty: "inferred" })).toEqual(["It doesn't say AM or PM."]);
    expect(threadNotSure(p, thread)).toEqual([]);
    expect(threadNotSure({ not_sure: [], date: { not_sure: [] } }, { ...thread, due_certainty: "inferred" })).toEqual([NOT_SURE_FALLBACK.inferredDate]);
  });
  it("no payload, nothing to say", () => {
    expect(threadNotSure(null, { due_at: null, due_certainty: "none" })).toEqual([]);
  });
  it("mergeNotSure drops repeats", () => {
    expect(mergeNotSure(["A", "b "], ["a", "C"])).toEqual(["A", "b", "C"]);
  });
});

describe("sourceCaption", () => {
  it("name and page, or name and date; deleted", () => {
    expect(sourceCaption(SOURCE, 2)).toBe("Renewal notice · p. 2");
    expect(sourceCaption({ title: null, kind: "paste", reference_date: "2026-10-05" }, null)).toBe("Pasted text · Oct 5");
    expect(sourceCaption({ title: null, kind: "upload", reference_date: "2026-10-05" }, null)).toBe("Uploaded file · Oct 5");
    expect(sourceCaption(null, 1)).toBe("Source deleted");
  });
});
