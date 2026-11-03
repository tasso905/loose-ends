import { describe, expect, it } from "vitest";
import { extract } from "@/lib/ai/extract";
import { createRecordedModel } from "@/lib/ai/fake";
import type { Extraction, Item } from "@/lib/ai/schema";
import { processExtraction } from "@/lib/pipeline/proposals";
import { possessiveDatePhrase, resolveDate, type DateContext } from "@/lib/pipeline/resolveDates";

/**
 * Holdout date miss (Nov 2): a possessive day ("Saturday's movie night") gave no date at all.
 * chrono reads "Saturday" but the leftover "s" (and any event words after it) made the phrase
 * "not one date expression", so a correct, in-quote date was dropped. A possessive day is the same
 * claim as the day: it resolves the same way. Synthetic text only; not the holdout fixture.
 */

const ctx: DateContext = { referenceDate: "2026-10-20", referenceDateSource: "user", timezone: "America/New_York" }; // Tue
const r = (date_text: string, date_iso: string | null = null) => resolveDate({ date_text, date_iso }, ctx);

describe("possessiveDatePhrase()", () => {
  it.each([
    ["Saturday's", "Saturday"],
    ["Saturday’s", "Saturday"],
    ["to Saturday's movie night", "Saturday"],
    ["for tomorrow's call", "tomorrow"],
    ["next week's review", "next week"],
    ["Oct's rent", "Oct"],
    ["this weekend's game", "this weekend"],
  ])("'%s' → '%s'", (text, want) => expect(possessiveDatePhrase(text)).toBe(want));

  it.each(["Saturday", "Mike's party", "by Friday", "the client's deadline"])("'%s' has no possessive date", (text) => {
    expect(possessiveDatePhrase(text)).toBeNull();
  });
});

describe("resolveDate(): possessive days resolve like the day", () => {
  it.each([
    ["Saturday's", "2026-10-24"],
    ["Saturday’s", "2026-10-24"],
    ["to Saturday's movie night", "2026-10-24"],
    ["Friday's", "2026-10-23"],
    ["for tomorrow's call", "2026-10-21"],
    ["Monday's standup", "2026-10-26"],
  ])("'%s' → %s, agreeing with the model, explicit", (text, day) => {
    const d = r(text, day);
    expect({ due_date: d.due_date, agreement: d.agreement, certainty: d.due_certainty, not_sure: d.not_sure }).toEqual({
      due_date: day,
      agreement: "agree",
      certainty: "explicit",
      not_sure: [],
    });
  });

  it("'next week's review' is still vague: a date with the doesn't-name-a-day line", () => {
    const d = r("next week's review");
    expect(d.due_date).not.toBeNull();
    expect(d.due_certainty).toBe("inferred");
    expect(d.not_sure.join(" ")).toContain("doesn't name a day");
  });

  it("'last Friday's meeting' points back and never becomes a future date", () => {
    const d = r("last Friday's meeting");
    expect(d.due_date === null || d.due_date <= "2026-10-20").toBe(true);
  });

  it("a weekday that contradicts its date is still refused, quoting the phrase as written", () => {
    const d = r("Monday, Oct 23's meeting");
    expect(d.due_date).toBeNull();
  });

  it("phrases that resolved before are unchanged ('Saturday', 'by Friday at 5pm')", () => {
    expect(r("Saturday").due_date).toBe("2026-10-24");
    expect(r("by Friday at 5pm").due_at).toBe("2026-10-23T21:00:00.000Z");
  });

  it("a non-date possessive gives no date ('Mike's party')", () => {
    expect(r("Mike's party").due_date).toBeNull();
  });
});

describe("pipeline with the fake provider: a request dated by a possessive day keeps its date", () => {
  const QUOTE = "can you bring the projector to Saturday's movie night?";
  const SOURCE = `Hey Sam! ${QUOTE} Thanks.`;
  const item = (date_text: string): Item => ({
    type: "request", title: "Bring the projector", owner: "user", counterparty: null, action: null, date_text, date_iso: "2026-10-24",
    amount_text: null, certainty: "explicit", uncertainty_notes: [], matches_thread_id: null, evidence: [{ quote: QUOTE, speaker: null }],
  });

  it.each(["Saturday", "Saturday's", "to Saturday's movie night"])("date_text '%s' → Sat Oct 24, explicit, High", async (dateText) => {
    const recorded: Extraction = { source_summary: "s", participants: [], items: [item(dateText)], brief: null };
    const model = createRecordedModel({ recordings: [{ name: "possessive", task: "extract", input: SOURCE, responses: [recorded] }] });
    const run = await extract(
      { sourceText: SOURCE, sourceKind: "paste", referenceDate: ctx.referenceDate, referenceDateSource: "user", timezone: ctx.timezone, user: { displayName: "Sam", aliases: [] } },
      { model, modelLabel: "fake:recorded", logger: () => {} },
    );
    const p = processExtraction(run.output, { ...ctx, sourceText: SOURCE, logger: () => {} }).proposals[0]!;
    expect(p.item.date_text).toBe(dateText);
    expect({ due_date: p.date.due_date, certainty: p.date.due_certainty, band: p.band }).toEqual({ due_date: "2026-10-24", certainty: "explicit", band: "high" });
    expect(p.item.title).toBe("Bring the projector");
  });
});

describe("possessive of a month that is also a first name (T-D5)", () => {
  it.each(["June's", "May's", "April's", "August's", "ask June's team", "for May's birthday"])("'%s' → no date", (t) => {
    expect(possessiveDatePhrase(t)).toBeNull();
    expect(r(t).due_date).toBeNull();
  });

  it.each([
    ["June's rent", "June"],
    ["May's 15th", "May 15th"],
    ["for April's board meeting", "April"],
    ["August's newsletter", "August"],
  ])("'%s' with a date-ish noun or day number is still a date ('%s')", (t, want) => {
    expect(possessiveDatePhrase(t)).toBe(want);
    expect(r(t).due_date).not.toBeNull();
  });

  it("other months are unaffected ('Oct's rent', 'December's')", () => {
    expect(possessiveDatePhrase("Oct's rent")).toBe("Oct");
    expect(possessiveDatePhrase("December's")).toBe("December");
  });
});

describe("possessive month with a day number keeps the day (T-D6)", () => {
  it.each([
    ["June's 15th", "June 15th", "2027-06-15"],
    ["for May's 3rd", "May 3rd", "2027-05-03"],
    ["Nov's 12th", "Nov 12th", "2026-11-12"],
  ])("'%s' → '%s' → %s", (t, phrase, day) => {
    expect(possessiveDatePhrase(t)).toBe(phrase);
    expect(r(t).due_date).toBe(day);
  });

  it("'report' is not a date-ish noun: 'June's report' is a person's report", () => {
    expect(possessiveDatePhrase("June's report")).toBeNull();
  });
});

describe("possessive month: a person's things and counts are not dates (T-D7, T-D8)", () => {
  it.each(["May's order", "June's review", "June's schedule", "April's statement", "June's budget", "May's meeting", "June's end", "May's 3 kids", "June's 15 minutes", "Jan's 5 kids"])(
    "'%s' → no date",
    (t) => {
      expect(possessiveDatePhrase(t)).toBeNull();
      expect(r(t).due_date).toBeNull();
    },
  );

  it.each([
    ["May's rent", "2027-05-01"],
    ["June's board meeting", "2027-06-01"],
    ["June's 15", "2027-06-15"],
    ["June's 15 at noon", "2027-06-15"],
    ["Jan's 5th", "2027-01-05"],
  ])("'%s' stays a date: %s", (t, day) => expect(r(t).due_date).toBe(day));
});
