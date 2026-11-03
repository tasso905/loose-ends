import { describe, expect, it } from "vitest";
import { NOT_SURE_FALLBACK } from "@/lib/threads/explain";
import { CONTEXT_CHARS, corrections, dateSteps, quoteContext, reasonLine, why, whyNow, type NowThread, type WhyInput } from "@/lib/threads/why";
import { greeting, TODAY_COPY } from "@/lib/threads/view";

const NY = "America/New_York";
const NOW = new Date("2026-10-08T14:00:00Z"); // Thu Oct 8, 10:00 in New York

function t(over: Partial<NowThread> = {}): NowThread {
  return {
    kind: "commitment",
    status: "open",
    counterparty: "Mike",
    waiting_on: null,
    expected_by: null,
    created_at: "2026-10-05T15:00:00Z",
    due_at: "2026-10-09T16:00:00Z",
    resolved_at: null,
    snoozed_until: null,
    ...over,
  };
}
const paste = { title: null, kind: "paste", reference_date: "2026-10-05" };
const ctx = (over: Partial<Parameters<typeof reasonLine>[1]> = {}) => ({ dateText: "Friday", source: paste, timezone: NY, now: NOW, ...over });

describe("reasonLine (F10: deterministic, source words first)", () => {
  it("matches the CONTENT_MODEL example", () => {
    expect(reasonLine(t(), ctx())).toBe('You told Mike "Friday" on Oct 5');
  });
  it("covers the other templates", () => {
    expect(reasonLine(t(), ctx({ dateText: null }))).toBe("You told Mike on Oct 5");
    expect(reasonLine(t({ counterparty: null }), ctx())).toBe('You said "Friday" on Oct 5');
    expect(reasonLine(t({ kind: "request", counterparty: "Dana" }), ctx())).toBe('Dana asked you on Oct 5: "Friday"');
    expect(reasonLine(t({ kind: "request", counterparty: "Dana" }), ctx({ dateText: null }))).toBe("Dana asked you on Oct 5");
    expect(reasonLine(t({ kind: "admin", counterparty: null }), ctx({ dateText: "Nov 1", source: { ...paste, title: "Renewal notice" } }))).toBe(
      'From Renewal notice, Oct 5 · "Nov 1"',
    );
    expect(reasonLine(t({ kind: "admin", counterparty: null }), ctx({ dateText: null, source: { ...paste, kind: "upload" } }))).toBe("From Uploaded file, Oct 5");
    expect(reasonLine(t({ kind: "admin", counterparty: null }), ctx({ source: null, dateText: null }))).toBe("You added this on Oct 5");
  });
  it("waiting threads name who they wait on, and when they were expected once that has passed", () => {
    const w = t({ kind: "waiting_on", status: "waiting", waiting_on: "Priya", expected_by: "2026-10-06T16:00:00Z" });
    expect(reasonLine(w, ctx())).toBe("Expected from Priya by Oct 6");
    expect(reasonLine({ ...w, expected_by: "2026-10-12T16:00:00Z" }, ctx())).toBe("Waiting on Priya");
  });
  it("a deleted source drops the date but keeps the words", () => {
    expect(reasonLine(t(), ctx({ source: null }))).toBe('You told Mike "Friday"');
  });
});

describe("whyNow", () => {
  it("matches the CONTENT_MODEL example", () => {
    expect(whyNow(t(), NY, NOW)).toBe("It's still open. It's due tomorrow.");
  });
  it("covers overdue, today, later, none and other statuses", () => {
    expect(whyNow(t({ due_at: "2026-10-06T16:00:00Z" }), NY, NOW)).toBe("It's still open. It's 2 days overdue.");
    expect(whyNow(t({ due_at: "2026-10-07T16:00:00Z" }), NY, NOW)).toBe("It's still open. It's 1 day overdue.");
    expect(whyNow(t({ due_at: "2026-10-08T20:00:00Z" }), NY, NOW)).toBe("It's still open. It's due today.");
    expect(whyNow(t({ due_at: "2026-10-12T16:00:00Z" }), NY, NOW)).toBe("It's still open. It's due in 4 days.");
    expect(whyNow(t({ due_at: "2026-11-30T16:00:00Z" }), NY, NOW)).toBe("It's still open. It's due Nov 30.");
    expect(whyNow(t({ due_at: null }), NY, NOW)).toBe("It's still open. It has no due date.");
    expect(whyNow(t({ status: "waiting", waiting_on: "Priya", expected_by: "2026-10-06T16:00:00Z" }), NY, NOW)).toBe(
      "You're still waiting on Priya. It was expected by Oct 6.",
    );
    expect(whyNow(t({ status: "resolved", resolved_at: "2026-10-07T16:00:00Z" }), NY, NOW)).toBe("You resolved this on Oct 7.");
    expect(whyNow(t({ status: "snoozed", snoozed_until: "2026-10-12T13:00:00Z" }), NY, NOW)).toBe("It's snoozed until Oct 12.");
  });
});

describe("dateSteps", () => {
  const stored = { due_at: "2026-10-09T16:00:00Z", due_certainty: "inferred" as const, reasoning: 'I read "Friday" as Fri Oct 9 (message dated Mon Oct 5).' };
  it("shows the pipeline's own step while the thread keeps that date", () => {
    expect(dateSteps({ due_at: "2026-10-09T16:00:00.000Z", due_certainty: "inferred" }, stored)).toEqual([stored.reasoning]);
  });
  it("never shows the AI's date as current once the user changed it", () => {
    expect(dateSteps({ due_at: "2026-10-12T16:00:00Z", due_certainty: "explicit" }, stored)).toEqual([]);
  });
  it("says when the source gives no date", () => {
    expect(dateSteps({ due_at: null, due_certainty: "none" }, { due_at: null, due_certainty: "none", reasoning: null })).toEqual(["The source doesn't give a date."]);
    expect(dateSteps({ due_at: null, due_certainty: "none" }, null)).toEqual([]);
  });
});

describe("corrections", () => {
  it("lists the user's edits only (CONTENT_MODEL example first)", () => {
    const lines = corrections(
      [
        { type: "edited", actor: "user", before: { due_at: "2026-10-09T16:00:00Z" }, after: { due_at: "2026-10-12T16:00:00Z" } },
        { type: "edited", actor: "ai", before: { due_at: null }, after: { due_at: "2026-10-12T16:00:00Z" } },
        { type: "resolved", actor: "user", before: null, after: { status: "resolved" } },
        { type: "edited", actor: "user", before: { title: "Old" }, after: { title: "Send it" } },
        { type: "edited", actor: "user", before: { due_at: "2026-10-12T16:00:00Z" }, after: { due_at: null } },
      ],
      NY,
    );
    expect(lines).toEqual(["You changed the date from Oct 9 to Oct 12", 'You changed the title to "Send it"', "You removed the date"]);
  });
});

describe("quoteContext (±200 characters)", () => {
  const text = `${"a".repeat(300)}QUOTE${"b".repeat(300)}`;
  it("cuts 200 characters each side and flags the fade masks", () => {
    const c = quoteContext(text, { quote: "QUOTE", start_offset: 300, end_offset: 305 });
    expect(c.before).toHaveLength(CONTEXT_CHARS);
    expect(c.after).toHaveLength(CONTEXT_CHARS);
    expect(c.quote).toBe("QUOTE");
    expect(c).toMatchObject({ clippedBefore: true, clippedAfter: true });
  });
  it("no masks when the whole source fits", () => {
    expect(quoteContext("Hi. QUOTE. Bye.", { quote: "QUOTE", start_offset: 4, end_offset: 9 })).toEqual({
      before: "Hi. ",
      quote: "QUOTE",
      after: ". Bye.",
      clippedBefore: false,
      clippedAfter: false,
    });
  });
  it("falls back to the first occurrence when offsets no longer match, and to the quote alone", () => {
    expect(quoteContext("x QUOTE y", { quote: "QUOTE", start_offset: 0, end_offset: 5 }).before).toBe("x ");
    expect(quoteContext(null, { quote: "QUOTE", start_offset: 0, end_offset: 5 })).toMatchObject({ before: "", quote: "QUOTE", after: "" });
    expect(quoteContext("nothing here", { quote: "QUOTE", start_offset: 0, end_offset: 5 })).toMatchObject({ before: "", after: "" });
  });
  it("never splits a surrogate pair at a cut", () => {
    const emoji = "\u{1F600}";
    const s = `${"a".repeat(99)}${emoji.repeat(60)}QUOTE`;
    const start = s.indexOf("QUOTE");
    const c = quoteContext(s, { quote: "QUOTE", start_offset: start, end_offset: start + 5 });
    expect(c.before.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  });
});

describe("why() assembles the panel from stored rows only", () => {
  const base: WhyInput = {
    thread: { ...t({ due_at: "2026-10-09T16:00:00Z" }), id: "11111111-1111-4111-8111-111111111111", title: "Send revised proposal to Mike", due_certainty: "inferred" },
    evidence: { id: "e1", quote: "I'll send you the revised proposal Friday", start_offset: 13, end_offset: 54, page: null, source_id: "s1" },
    source: { id: "s1", title: null, kind: "paste", reference_date: "2026-10-05", text_content: "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime." },
    sourceDeletedAt: null,
    item: {
      band: "high",
      payload: {
        label: { word: "Likely", reason: "you said you'd do it, with a day" },
        not_sure: [],
        item: { certainty: "explicit", uncertainty_notes: [] },
        date: { due_at: "2026-10-09T16:00:00Z", due_certainty: "inferred", reasoning: 'I read "Friday" as Fri Oct 9 (message dated Mon Oct 5).', not_sure: [] },
      },
    },
    events: [],
    timezone: NY,
    now: NOW,
  };

  it("fills every part", () => {
    const v = why(base);
    expect(v.quote).toMatchObject({ before: "Thanks Mike — ", quote: "I'll send you the revised proposal Friday", after: ". We should grab lunch sometime." });
    expect(v.caption).toBe("Pasted text · Oct 5");
    expect(v.sourceDeleted).toBeNull();
    expect(v.sourceId).toBe("s1");
    expect(v.steps).toEqual(['I read "Friday" as Fri Oct 9 (message dated Mon Oct 5).']);
    expect(v.notSure).toEqual([NOT_SURE_FALLBACK.inferredDate]);
    expect(v.origin).toEqual({ band: "high", label: { word: "Likely", reason: "you said you'd do it, with a day" } });
    expect(v.whyNow).toBe("It's still open. It's due tomorrow.");
    expect(v.corrections).toEqual([]);
  });

  it("deleted source: the quote stays, the deleted line replaces Open source", () => {
    const v = why({ ...base, source: null, evidence: { ...base.evidence!, source_id: null } });
    expect(v.quote).toMatchObject({ before: "", quote: "I'll send you the revised proposal Friday" });
    expect(v.caption).toBe("Source deleted");
    expect(v.sourceDeleted).toBe("Original source deleted.");
    expect(v.sourceId).toBeNull();
    expect(why({ ...base, source: null, sourceDeletedAt: "2026-10-12T15:00:00Z" }).sourceDeleted).toBe("Original source deleted on Oct 12.");
  });

  it("no proposal and no evidence (e.g. a thread made without one)", () => {
    const v = why({ ...base, evidence: null, source: null, item: null });
    expect(v).toMatchObject({ quote: null, caption: null, sourceDeleted: null, steps: [], origin: null });
  });

  it("an Ignore band or a malformed payload shows no label", () => {
    expect(why({ ...base, item: { band: "ignore", payload: base.item!.payload } }).origin).toBeNull();
    expect(why({ ...base, item: { band: "high", payload: "nonsense" } }).origin).toBeNull();
  });
});

describe("Today copy", () => {
  it("greeting is the full local date", () => {
    expect(greeting(new Date("2026-10-18T14:00:00Z"), NY)).toBe("Sunday, October 18");
    expect(greeting(new Date("2026-10-19T02:00:00Z"), NY)).toBe("Sunday, October 18");
    expect(greeting(new Date("2026-10-19T02:00:00Z"), "Asia/Tokyo")).toBe("Monday, October 19");
  });
  it("count line and review chip", () => {
    expect(TODAY_COPY.countLine(2)).toBe("2 things are worth your attention");
    expect(TODAY_COPY.countLine(1)).toBe("1 thing is worth your attention");
    expect(TODAY_COPY.toReview(3)).toBe("3 to review");
  });
});
