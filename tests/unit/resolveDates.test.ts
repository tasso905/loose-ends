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

  it("'tomorrow at 5' is 5 PM (bare hour 1-6, user decision Oct 21), inferred with a Not sure about line, even if the model agrees", () => {
    const r = resolveDate({ date_text: "tomorrow at 5", date_iso: "2026-10-06T17:00:00" }, NY);
    expect(r.agreement).toBe("agree");
    expect(r.due_certainty).toBe("inferred");
    expect(r.due_at).toBe("2026-10-06T21:00:00.000Z");
    expect(r.not_sure).toContain(`"tomorrow at 5" doesn't say AM or PM. I read it as Tue Oct 6, 5:00 PM.`);
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

describe("resolveDate(): rule 3 probes (core-loop follow-ups C)", () => {
  const none = (text: string, iso: string | null = null) => {
    const r = resolveDate({ date_text: text, date_iso: iso }, NY);
    expect(r, text).toMatchObject({ due_at: null, due_date: null, due_certainty: "none" });
    expect(r.not_sure, text).toEqual([`I couldn't work out a date from "${text}", so I didn't set one.`]);
  };

  it("a past reference never becomes a future due date: 'last Saturday' written Mon Oct 5 is Sat Oct 3", () => {
    expect(resolveDate({ date_text: "last Saturday", date_iso: null }, NY)).toMatchObject({ due_date: "2026-10-03", due_certainty: "inferred" });
    expect(resolveDate({ date_text: "last Saturday", date_iso: "2026-10-03" }, NY)).toMatchObject({ due_date: "2026-10-03", agreement: "agree" });
    expect(resolveDate({ date_text: "3 days ago", date_iso: null }, NY).due_date).toBe("2026-10-02");
  });

  it.each(["last Saturday", "past Monday", "3 days ago", "yesterday", "last week"])("'%s' resolves on or before the written-on day", (t) => {
    const d = resolveDate({ date_text: t, date_iso: null }, NY).due_date;
    expect(d === null || d <= NY.referenceDate, `${t} → ${d}`).toBe(true);
  });

  it("a past reference chrono can only read forward is rejected, not guessed ('previous Tuesday')", () => {
    none("previous Tuesday", "2026-09-29");
  });

  it.each(["in a month of Sundays", "one day at a time", "a mile a minute", "one day", "a day"])("idiom or bare duration '%s' is not a date", (t) => {
    none(t, "2026-11-14");
  });

  it.each(["Friday or Monday", "Saturday until 6pm", "Friday 5"])("an ambiguous phrase '%s' is rejected, never guessed", (t) => none(t));

  it.each(["Saturday by 6pm", "Saturday no later than 6pm", "Saturday at 6pm", "by 6pm Saturday", "Saturday before 6pm"])(
    "'%s' keeps the stated time (Sat Oct 10, 6:00 PM EDT)",
    (t) => {
      expect(resolveDate({ date_text: t, date_iso: "2026-10-10T18:00:00" }, NY)).toMatchObject({
        due_date: "2026-10-10",
        due_at: "2026-10-10T22:00:00.000Z",
        due_time_known: true,
        agreement: "agree",
        due_certainty: "explicit",
      });
    },
  );

  it("filler around the day is still allowed: 'by end of day Friday', 'by Fri.', 'due on the 15th'", () => {
    expect(resolveDate({ date_text: "by end of day Friday", date_iso: "2026-10-09" }, NY)).toMatchObject({ due_date: "2026-10-09", due_certainty: "explicit" });
    expect(resolveDate({ date_text: "by Fri.", date_iso: "2026-10-09" }, NY).due_date).toBe("2026-10-09");
    expect(resolveDate({ date_text: "due on the 15th", date_iso: "2026-10-15" }, NY).due_date).toBe("2026-10-15");
  });

  it("'tomorrow at 5' is 5 PM marked inferred with the AM/PM line (user decision Oct 21; D32)", () => {
    const r = resolveDate({ date_text: "tomorrow at 5", date_iso: null }, NY);
    expect(r).toMatchObject({ due_date: "2026-10-06", due_at: "2026-10-06T21:00:00.000Z", due_certainty: "inferred" });
    expect(r.not_sure).toContain(`"tomorrow at 5" doesn't say AM or PM. I read it as Tue Oct 6, 5:00 PM.`);
  });
});

describe("resolveDate(): dates-and-toast round (user decisions Oct 21, tester T-C1..T-C3)", () => {
  it.each([
    ["tomorrow at 1", "2026-10-06T17:00:00.000Z"],
    ["tomorrow at 6", "2026-10-06T22:00:00.000Z"],
    ["tomorrow at 7", "2026-10-06T11:00:00.000Z"],
    ["tomorrow at 11", "2026-10-06T15:00:00.000Z"],
  ])("bare hour '%s': 1-6 is PM, 7-11 stays AM; always inferred with the AM/PM line", (t, at) => {
    const r = resolveDate({ date_text: t, date_iso: null }, NY);
    expect(r.due_at).toBe(at);
    expect(r.due_certainty).toBe("inferred");
    expect(r.not_sure.some((l) => l.includes("doesn't say AM or PM"))).toBe(true);
  });

  it("'Saturday by 6:00' gets the AM/PM line and reads 6 PM; '06:00' and '18:00' are 24-hour, no line", () => {
    const r = resolveDate({ date_text: "Saturday by 6:00", date_iso: null }, NY);
    expect(r).toMatchObject({ due_date: "2026-10-10", due_at: "2026-10-10T22:00:00.000Z", due_certainty: "inferred" });
    expect(r.not_sure).toContain(`"Saturday by 6:00" doesn't say AM or PM. I read it as Sat Oct 10, 6:00 PM.`);
    for (const [t, at] of [["Saturday by 06:00", "2026-10-10T10:00:00.000Z"], ["Saturday by 18:00", "2026-10-10T22:00:00.000Z"]]) {
      const x = resolveDate({ date_text: t!, date_iso: null }, NY);
      expect(x.due_at, t).toBe(at);
      expect(x.not_sure.some((l) => l.includes("AM or PM")), t).toBe(false);
    }
  });

  it.each(["end of the day", "by the end of the day", "by EOD", "by close of business"])("'%s' alone is the written-on day (Mon Oct 5)", (t) => {
    expect(resolveDate({ date_text: t, date_iso: "2026-10-05" }, NY)).toMatchObject({ due_date: "2026-10-05", due_time_known: false, agreement: "agree" });
  });

  it("'by end of day Friday' is still Friday", () => {
    expect(resolveDate({ date_text: "by end of day Friday", date_iso: "2026-10-09" }, NY).due_date).toBe("2026-10-09");
  });

  it.each(["at the latest", "first thing", "cobweb Friday"])("'%s' without a day, or a lookalike word, is not a date", (t) => {
    expect(resolveDate({ date_text: t, date_iso: null }, NY).due_date).toBeNull();
  });

  it("a weekday that contradicts its date gives no date and says why", () => {
    const r = resolveDate({ date_text: "Monday Oct 9", date_iso: "2026-10-09" }, NY);
    expect(r).toMatchObject({ due_date: null, due_certainty: "none" });
    expect(r.not_sure).toEqual([`"Monday Oct 9" says Monday, but Oct 9 is a Friday, so I didn't set a date.`]);
    expect(resolveDate({ date_text: "Friday Oct 9", date_iso: "2026-10-09" }, NY)).toMatchObject({ due_date: "2026-10-09", due_certainty: "explicit" });
  });
});

describe("resolveDate(): a part of the day states AM or PM (T-D1)", () => {
  it.each([
    ["this morning at 5", "2026-10-05T09:00:00.000Z"],
    ["tomorrow morning at 6", "2026-10-06T10:00:00.000Z"],
    ["Friday at 6 in the morning", "2026-10-09T10:00:00.000Z"],
    ["this afternoon at 2", "2026-10-05T18:00:00.000Z"],
    ["Friday at 3 in the afternoon", "2026-10-09T19:00:00.000Z"],
    ["tomorrow evening at 6", "2026-10-06T22:00:00.000Z"],
    ["tonight at 8", "2026-10-06T00:00:00.000Z"],
    ["Friday night at 9", "2026-10-10T01:00:00.000Z"],
  ])("'%s' keeps the stated part of the day, no PM default and no AM/PM line", (t, at) => {
    const r = resolveDate({ date_text: t, date_iso: null }, NY);
    expect(r.due_at).toBe(at);
    expect(r.not_sure.some((l) => l.includes("AM or PM"))).toBe(false);
  });
});

describe("resolveDate(): night + a small hour is the next day's small hours (T-D2)", () => {
  // Written Mon Oct 5, 2026, New York (UTC-4).
  it.each([
    ["tonight at 1", "2026-10-06", "2026-10-06T05:00:00.000Z"],
    ["tonight at 2:30", "2026-10-06", "2026-10-06T06:30:00.000Z"],
    ["tonight at 12", "2026-10-06", "2026-10-06T04:00:00.000Z"],
    ["Friday night at 2", "2026-10-10", "2026-10-10T06:00:00.000Z"],
    ["tomorrow night at 3", "2026-10-07", "2026-10-07T07:00:00.000Z"],
  ])("'%s' → %s, small hours, inferred with the AM/PM line", (t, day, at) => {
    const r = resolveDate({ date_text: t, date_iso: null }, NY);
    expect(r.due_date).toBe(day);
    expect(r.due_at).toBe(at);
    expect(r.due_certainty).toBe("inferred");
    expect(r.not_sure.some((l) => l.includes("doesn't say AM or PM"))).toBe(true);
  });

  it.each([
    ["tonight at 8", "2026-10-06T00:00:00.000Z"],
    ["tonight at 5", "2026-10-05T21:00:00.000Z"],
    ["tonight at 1pm", "2026-10-05T17:00:00.000Z"],
    ["Friday night at 11", "2026-10-10T03:00:00.000Z"],
  ])("'%s' is unchanged (evening hour, or PM written out)", (t, at) => {
    expect(resolveDate({ date_text: t, date_iso: null }, NY).due_at).toBe(at);
  });

  it.each([
    ["tonight at 1am", "2026-10-06T05:00:00.000Z"],
    ["tonight at 2:30 a.m.", "2026-10-06T06:30:00.000Z"],
    ["Friday night at 2am", "2026-10-10T06:00:00.000Z"],
    ["tonight at 01:00", "2026-10-06T05:00:00.000Z"],
    ["tonight at 05:00", "2026-10-06T09:00:00.000Z"],
    ["tonight at 06:00", "2026-10-06T10:00:00.000Z"],
    ["last night at 1am", "2026-10-05T05:00:00.000Z"],
  ])("'%s' (AM stated, by am or a zero-padded hour) is the next morning with no AM/PM line", (t, at) => {
    const r = resolveDate({ date_text: t, date_iso: null }, NY);
    expect(r.due_at).toBe(at);
    expect(r.not_sure.some((l) => l.includes("AM or PM"))).toBe(false);
  });

  it.each([
    ["tonight at 13:00", "2026-10-05T17:00:00.000Z"],
    ["tonight at 21:30", "2026-10-06T01:30:00.000Z"],
    ["Friday night at 14:30", "2026-10-09T18:30:00.000Z"],
  ])("'%s' is a 24-hour time, kept as written with no AM/PM line", (t, at) => {
    const r = resolveDate({ date_text: t, date_iso: null }, NY);
    expect(r.due_at).toBe(at);
    expect(r.not_sure.some((l) => l.includes("AM or PM"))).toBe(false);
  });

  it("'last night' is the night before the written-on day: 1 is that night's small hours, 11 is the evening", () => {
    const one = resolveDate({ date_text: "last night at 1", date_iso: null }, NY);
    expect(one.due_at).toBe("2026-10-05T05:00:00.000Z");
    expect(one.not_sure.some((l) => l.includes("doesn't say AM or PM"))).toBe(true);
    expect(resolveDate({ date_text: "last night at 11", date_iso: null }, NY).due_at).toBe("2026-10-05T03:00:00.000Z");
  });

  it("agrees with a model that read 'tonight at 1' as 1 AM the next day", () => {
    const r = resolveDate({ date_text: "tonight at 1", date_iso: "2026-10-06T01:00:00" }, NY);
    expect(r.agreement).toBe("agree");
    expect(r.due_at).toBe("2026-10-06T05:00:00.000Z");
  });
});

describe("resolveDate(): vague amounts", () => {
  it.each(["a few days", "in a few days", "a couple of days", "several weeks", "the past few days"])("'%s' gives no date", (t) => {
    expect(resolveDate({ date_text: t, date_iso: "2026-10-08" }, NY).due_date).toBeNull();
  });
});
