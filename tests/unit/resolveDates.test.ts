import { describe, expect, it } from "vitest";
import { formatDay, resolveDate, type DateContext } from "@/lib/pipeline/resolveDates";

const NY: DateContext = { referenceDate: "2026-10-05", referenceDateSource: "user", timezone: "America/New_York" };

describe("resolveDate(): agreement with the model", () => {
  it("'Friday' from Mon Oct 5 is Fri Oct 9; agreeing model → explicit, end of day local", () => {
    const r = resolveDate({ date_text: "Friday", date_iso: "2026-10-09" }, NY);
    expect(r).toMatchObject({
      due_date: "2026-10-09",
      due_at: "2026-10-10T03:59:00.000Z", // 23:59 EDT
      due_time_known: false,
      due_certainty: "explicit",
      agreement: "agree",
      not_sure: [],
    });
    expect(r.reasoning).toBe('I read "Friday" as Fri Oct 9 (message dated Mon Oct 5).');
  });

  it("disagreement: keeps chrono's value, marks inferred and adds a Not sure about line", () => {
    const r = resolveDate({ date_text: "Friday", date_iso: "2026-10-16" }, NY);
    expect(r.due_date).toBe("2026-10-09");
    expect(r.due_certainty).toBe("inferred");
    expect(r.agreement).toBe("disagree");
    expect(r.not_sure).toEqual(['I read "Friday" as Fri Oct 9 (message dated Mon Oct 5). Check this date.']);
  });

  it("model gave no resolution: chrono's date, marked inferred", () => {
    const r = resolveDate({ date_text: "Friday", date_iso: null }, NY);
    expect(r).toMatchObject({ due_date: "2026-10-09", due_certainty: "inferred", agreement: "chrono_only" });
  });

  it("an unparseable model date counts as disagreement", () => {
    const r = resolveDate({ date_text: "Friday", date_iso: "someday" }, NY);
    expect(r).toMatchObject({ due_date: "2026-10-09", agreement: "disagree", due_certainty: "inferred" });
  });

  it("model datetime with offset is compared in the user's timezone", () => {
    const r = resolveDate({ date_text: "Oct 31 at 5pm", date_iso: "2026-10-31T17:00:00-04:00" }, NY);
    expect(r).toMatchObject({ agreement: "agree", due_time_known: true, due_at: "2026-10-31T21:00:00.000Z" });
  });

  it("a different time on the same day is a disagreement", () => {
    const r = resolveDate({ date_text: "Oct 31 at 5pm", date_iso: "2026-10-31T15:00:00-04:00" }, NY);
    expect(r.agreement).toBe("disagree");
    expect(r.due_at).toBe("2026-10-31T21:00:00.000Z");
  });
});

describe("resolveDate(): never fills a missing date (rule 3)", () => {
  it("no date_text and no date_iso → no due date", () => {
    expect(resolveDate({ date_text: null, date_iso: null }, NY)).toMatchObject({ due_at: null, due_certainty: "none", agreement: "none" });
  });

  it("a model date with no date_text anchor is discarded", () => {
    expect(resolveDate({ date_text: null, date_iso: "2026-10-09" }, NY)).toMatchObject({
      due_at: null,
      due_certainty: "none",
      agreement: "unanchored",
      not_sure: [],
    });
  });

  it.each(["sometime", "soon", "after the holidays"])("'%s' resolves to no date even if the model guessed one", (phrase) => {
    const r = resolveDate({ date_text: phrase, date_iso: "2026-12-01" }, NY);
    expect(r.due_at).toBeNull();
    expect(r.due_certainty).toBe("none");
    expect(r.agreement).toBe("model_only");
    expect(r.not_sure).toEqual([`I couldn't work out a date from "${phrase}", so I didn't set one.`]);
  });
});

describe("resolveDate(): relative phrases", () => {
  it("'this Friday' and 'Friday' are the coming Friday; 'next Friday' is the one after", () => {
    expect(resolveDate({ date_text: "this Friday", date_iso: null }, NY).due_date).toBe("2026-10-09");
    expect(resolveDate({ date_text: "next Friday", date_iso: null }, NY).due_date).toBe("2026-10-16");
  });

  it("'next Friday': a model reading of Oct 9 disagrees with chrono → inferred, chrono kept", () => {
    const r = resolveDate({ date_text: "next Friday", date_iso: "2026-10-09" }, NY);
    expect(r).toMatchObject({ due_date: "2026-10-16", agreement: "disagree", due_certainty: "inferred" });
  });

  it("'tomorrow' and 'by Oct 31'", () => {
    expect(resolveDate({ date_text: "tomorrow", date_iso: "2026-10-06" }, NY)).toMatchObject({ due_date: "2026-10-06", due_certainty: "explicit" });
    expect(resolveDate({ date_text: "by Oct 31", date_iso: "2026-10-31" }, NY)).toMatchObject({ due_date: "2026-10-31", due_certainty: "explicit" });
  });

  it("'the 15th' is the next 15th (F4 'pay by the 15th')", () => {
    expect(resolveDate({ date_text: "by the 15th", date_iso: "2026-10-15" }, NY)).toMatchObject({ due_date: "2026-10-15", agreement: "agree" });
    const late = { ...NY, referenceDate: "2026-10-20" };
    expect(resolveDate({ date_text: "the 15th", date_iso: null }, late).due_date).toBe("2026-11-15");
  });

  it("phrases naming a period are marked inferred with a note", () => {
    const r = resolveDate({ date_text: "next week", date_iso: "2026-10-12" }, NY);
    expect(r.due_certainty).toBe("inferred");
    expect(r.not_sure).toContain(`"next week" doesn't name a day. I read it as Mon Oct 12.`);
  });

  it("a relative phrase against a defaulted written-on date is an assumption", () => {
    const r = resolveDate({ date_text: "Friday", date_iso: "2026-10-09" }, { ...NY, referenceDateSource: "defaulted" });
    expect(r.due_certainty).toBe("inferred");
    expect(r.not_sure).toEqual([
      'I read "Friday" as Fri Oct 9 (I assumed this was written today, Mon Oct 5). Change the date if that\'s wrong.',
    ]);
  });

  it("an absolute date against a defaulted written-on date stays explicit", () => {
    const r = resolveDate({ date_text: "Oct 31", date_iso: "2026-10-31" }, { ...NY, referenceDateSource: "defaulted" });
    expect(r.due_certainty).toBe("explicit");
  });
});

describe("resolveDate(): year rollover", () => {
  const DEC30: DateContext = { referenceDate: "2026-12-30", referenceDateSource: "user", timezone: "America/New_York" };

  it("'Friday' from Wed Dec 30, 2026 is Fri Jan 1, 2027", () => {
    const r = resolveDate({ date_text: "Friday", date_iso: "2027-01-01" }, DEC30);
    expect(r).toMatchObject({ due_date: "2027-01-01", agreement: "agree" });
    expect(r.reasoning).toBe('I read "Friday" as Fri Jan 1, 2027 (message dated Wed Dec 30).');
  });

  it("'Jan 3' written in late December is next year", () => {
    expect(resolveDate({ date_text: "Jan 3", date_iso: "2027-01-03" }, DEC30)).toMatchObject({ due_date: "2027-01-03", agreement: "agree" });
  });

  it("a model that keeps the old year disagrees and loses", () => {
    expect(resolveDate({ date_text: "Jan 3", date_iso: "2026-01-03" }, DEC30)).toMatchObject({ due_date: "2027-01-03", agreement: "disagree" });
  });

  it("'the 5th' written on Dec 20 is Jan 5 next year", () => {
    expect(resolveDate({ date_text: "the 5th", date_iso: null }, { ...DEC30, referenceDate: "2026-12-20" }).due_date).toBe("2027-01-05");
  });
});

describe("resolveDate(): DST", () => {
  it("US fall-back (Nov 1, 2026): end of day before is EDT, after is EST", () => {
    const ctx: DateContext = { referenceDate: "2026-10-29", referenceDateSource: "user", timezone: "America/New_York" };
    expect(resolveDate({ date_text: "Saturday", date_iso: "2026-10-31" }, ctx).due_at).toBe("2026-11-01T03:59:00.000Z");
    expect(resolveDate({ date_text: "Monday", date_iso: "2026-11-02" }, ctx).due_at).toBe("2026-11-03T04:59:00.000Z");
  });

  it("US fall-back: a stated time after the change uses the new offset", () => {
    const ctx: DateContext = { referenceDate: "2026-10-30", referenceDateSource: "user", timezone: "America/New_York" };
    expect(resolveDate({ date_text: "Monday at 9am", date_iso: "2026-11-02T09:00:00" }, ctx)).toMatchObject({
      due_at: "2026-11-02T14:00:00.000Z",
      due_time_known: true,
      agreement: "agree",
    });
  });

  it("US spring-forward (Mar 14, 2027)", () => {
    const ctx: DateContext = { referenceDate: "2027-03-12", referenceDateSource: "user", timezone: "America/New_York" };
    expect(resolveDate({ date_text: "Saturday at 9am", date_iso: null }, ctx).due_at).toBe("2027-03-13T14:00:00.000Z");
    expect(resolveDate({ date_text: "Monday at 9am", date_iso: null }, ctx).due_at).toBe("2027-03-15T13:00:00.000Z");
  });

  it("Europe/London fall-back (Oct 25, 2026)", () => {
    const ctx: DateContext = { referenceDate: "2026-10-23", referenceDateSource: "user", timezone: "Europe/London" };
    expect(resolveDate({ date_text: "Saturday at 10am", date_iso: null }, ctx).due_at).toBe("2026-10-24T09:00:00.000Z");
    expect(resolveDate({ date_text: "Monday at 10am", date_iso: null }, ctx).due_at).toBe("2026-10-26T10:00:00.000Z");
  });

  it("a timezone far from UTC keeps the local calendar day", () => {
    const ctx: DateContext = { referenceDate: "2026-10-05", referenceDateSource: "user", timezone: "Pacific/Auckland" };
    const r = resolveDate({ date_text: "Friday", date_iso: "2026-10-09" }, ctx);
    expect(r).toMatchObject({ due_date: "2026-10-09", agreement: "agree" });
    expect(r.due_at).toBe("2026-10-09T10:59:00.000Z"); // 23:59 NZDT (UTC+13)
  });
});

describe("formatDay()", () => {
  it("formats per DESIGN_STANDARD 'Dates and numbers'", () => {
    expect(formatDay("2026-10-09", 2026)).toBe("Fri Oct 9");
    expect(formatDay("2027-01-08", 2026)).toBe("Fri Jan 8, 2027");
  });
});

describe("resolveDate(): past dates and DST gaps (round 2 fixes)", () => {
  it("a month-day up to 30 days before the written-on date stays in the past (overdue)", () => {
    expect(resolveDate({ date_text: "Sep 10", date_iso: "2026-09-10" }, NY)).toMatchObject({ due_date: "2026-09-10", agreement: "agree" });
  });

  it("weekday phrases still look forward", () => {
    expect(resolveDate({ date_text: "Friday", date_iso: null }, NY).due_date).toBe("2026-10-09");
  });

  it("a time inside the spring-forward gap moves forward by the gap (2:30 AM → 3:30 AM EDT)", () => {
    const r = resolveDate({ date_text: "Sunday at 2:30am", date_iso: null }, { ...NY, referenceDate: "2027-03-12" });
    expect(r.due_at).toBe("2027-03-14T07:30:00.000Z");
  });
});

describe("resolveDate(): same-day phrases and bare times (round 4)", () => {
  it("'this morning' / 'tonight at 8' are the written-on day", () => {
    expect(resolveDate({ date_text: "this morning", date_iso: null }, NY)).toMatchObject({ due_date: "2026-10-05", due_time_known: false });
    expect(resolveDate({ date_text: "tonight at 8", date_iso: null }, NY)).toMatchObject({ due_date: "2026-10-05", due_at: "2026-10-06T00:00:00.000Z" });
  });

  it.each(["at 5", "5pm"])("bare time '%s' names no day, so no due date", (t) => {
    expect(resolveDate({ date_text: t, date_iso: "2026-10-05T17:00:00" }, NY)).toMatchObject({ due_at: null, due_certainty: "none" });
  });
});

describe("resolveDate(): month-day past window (user decision A, Oct 18)", () => {
  it.each([
    ["Oct 4", "2026-10-04"], // 1 day before → past
    ["Sep 5", "2026-09-05"], // exactly 30 days before → past
    ["Sep 4", "2027-09-04"], // 31 days before → next occurrence
    ["Sep 10", "2026-09-10"],
    ["Apr 10", "2027-04-10"],
    ["Oct 5", "2026-10-05"], // the written-on day itself
    ["Oct 31", "2026-10-31"],
  ])("'%s' written Mon Oct 5, 2026 → %s", (text, expected) => {
    expect(resolveDate({ date_text: text, date_iso: null }, NY).due_date).toBe(expected);
  });

  it("the window crosses a year boundary: 'Dec 20' written Jan 5, 2027 is 2026-12-20", () => {
    expect(resolveDate({ date_text: "Dec 20", date_iso: null }, { ...NY, referenceDate: "2027-01-05" }).due_date).toBe("2026-12-20");
    expect(resolveDate({ date_text: "Dec 1", date_iso: null }, { ...NY, referenceDate: "2027-01-05" }).due_date).toBe("2027-12-01");
  });

  it("an explicit year is never moved", () => {
    expect(resolveDate({ date_text: "Apr 10, 2026", date_iso: null }, NY).due_date).toBe("2026-04-10");
  });
});

describe("resolveDate(): times (round 5)", () => {
  it.each(["now", "in a sec", "in 2 hours"])("relative time '%s' keeps the day, drops the clock time", (t) => {
    expect(resolveDate({ date_text: t, date_iso: null }, NY)).toMatchObject({ due_date: "2026-10-05", due_time_known: false, due_at: "2026-10-06T03:59:00.000Z" });
  });

  it("'tomorrow at 5' is inferred with a Not sure about line, even if the model agrees", () => {
    const r = resolveDate({ date_text: "tomorrow at 5", date_iso: "2026-10-06T05:00:00" }, NY);
    expect(r.agreement).toBe("agree");
    expect(r.due_certainty).toBe("inferred");
    expect(r.not_sure).toContain(`"tomorrow at 5" doesn't say AM or PM. I read it as Tue Oct 6, 5:00 AM.`);
  });

  it.each(["tomorrow at 5pm", "tomorrow at 17:00", "tomorrow at noon", "Monday at 9am"])("'%s' states the time: explicit when the model agrees", (t) => {
    const r = resolveDate({ date_text: t, date_iso: null }, NY);
    expect(r.due_time_known).toBe(true);
    expect(r.not_sure.some((l) => l.includes("AM or PM"))).toBe(false);
  });
});

describe("resolveDate(): Feb 29 (round 6)", () => {
  it("when chrono finds no valid reading at all, there is no due date (never invented)", () => {
    // Written Dec 1, 2028: chrono reads no valid Feb 29 either way, so the date is dropped.
    expect(resolveDate({ date_text: "Feb 29", date_iso: null }, { ...NY, referenceDate: "2028-12-01" }).due_at).toBeNull();
  });

  it.each([
    ["2028-03-10", "2028-02-29"], // 10 days back → past
    ["2027-03-10", "2028-02-29"], // next leap year
    ["2028-02-01", "2028-02-29"],
  ])("'Feb 29' written %s → %s", (ref, expected) => {
    expect(resolveDate({ date_text: "Feb 29", date_iso: null }, { ...NY, referenceDate: ref }).due_date).toBe(expected);
  });
});
