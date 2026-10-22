import { describe, expect, it } from "vitest";
import { resolveDate, type DateContext } from "@/lib/pipeline/resolveDates";

/**
 * Lead-tester: independent verification of fix/dates-and-toast commit 2e4686f (D50 PM default,
 * T-C1 end of day, T-C2 weekday contradiction, T-C3 vague amounts, deadline idioms).
 *
 * `it` = REGRESSION GUARD (verified behaviour). `it.fails` = OPEN DEFECT: asserts the required
 * behaviour and currently fails; when fixed it turns red and must become `it`, relabelled.
 * "observed" = current behaviour pinned deliberately (safe, or pre-existing and reported).
 */

const NY: DateContext = { referenceDate: "2026-10-05", referenceDateSource: "user", timezone: "America/New_York" }; // Mon Oct 5, 2026
const ctx = (referenceDate: string, timezone = "America/New_York"): DateContext => ({ referenceDate, referenceDateSource: "user", timezone });
const r = (text: string, iso: string | null = null, c: DateContext = NY) => resolveDate({ date_text: text, date_iso: iso }, c);
const AMPM = /doesn't say AM or PM/;
const hasAmPmLine = (x: ReturnType<typeof r>) => x.not_sure.some((l) => AMPM.test(l));
const noDate = (text: string, c: DateContext = NY) => expect(r(text, null, c), text).toMatchObject({ due_at: null, due_date: null, due_certainty: "none" });

describe("D50: bare hour with no AM/PM (REGRESSION GUARDS)", () => {
  // EDT (UTC-4) on Oct 9, 2026.
  it.each([
    ["Friday at 1", "2026-10-09T17:00:00.000Z"],
    ["Friday at 2:15", "2026-10-09T18:15:00.000Z"],
    ["Friday at 5", "2026-10-09T21:00:00.000Z"],
    ["Friday at 5:30", "2026-10-09T21:30:00.000Z"],
    ["Friday at 6", "2026-10-09T22:00:00.000Z"],
    ["Friday by 6:00", "2026-10-09T22:00:00.000Z"],
    ["Friday at 6 o'clock", "2026-10-09T22:00:00.000Z"],
  ])("1-6 → PM, inferred, with the AM/PM line: %s", (t, at) => {
    const x = r(t);
    expect(x.due_at, t).toBe(at);
    expect(x.due_certainty).toBe("inferred");
    expect(hasAmPmLine(x), JSON.stringify(x.not_sure)).toBe(true);
  });

  it("PM default holds when the model agrees on the PM reading: still inferred with the AM/PM line (never explicit)", () => {
    const x = r("tomorrow at 5", "2026-10-06T17:00:00");
    expect(x).toMatchObject({ agreement: "agree", due_at: "2026-10-06T21:00:00.000Z", due_certainty: "inferred" });
    expect(hasAmPmLine(x)).toBe(true);
  });

  it("a model saying 5 AM is overridden by chrono's 5 PM, flagged (disagree, inferred, Check this date)", () => {
    const x = r("tomorrow at 5", "2026-10-06T05:00:00");
    expect(x).toMatchObject({ agreement: "disagree", due_at: "2026-10-06T21:00:00.000Z", due_certainty: "inferred" });
    expect(x.not_sure.some((l) => /Check this date/.test(l))).toBe(true);
  });

  it.each([
    ["Friday at 7", "2026-10-09T11:00:00.000Z"],
    ["Friday at 11", "2026-10-09T15:00:00.000Z"],
    ["Friday at 11:45", "2026-10-09T15:45:00.000Z"],
  ])("7-11 stay AM, still flagged: %s", (t, at) => {
    const x = r(t);
    expect(x.due_at).toBe(at);
    expect(hasAmPmLine(x)).toBe(true);
  });

  it.each([
    ["Friday at 12", "2026-10-09T16:00:00.000Z"],
    ["Friday at 12:30", "2026-10-09T16:30:00.000Z"],
  ])("12 is noon, flagged: %s", (t, at) => {
    const x = r(t);
    expect(x.due_at).toBe(at);
    expect(hasAmPmLine(x)).toBe(true);
  });

  it.each([
    ["Friday at noon", "2026-10-09T16:00:00.000Z"],
    ["Friday at 5pm", "2026-10-09T21:00:00.000Z"],
    ["Friday at 5 a.m.", "2026-10-09T09:00:00.000Z"],
    ["Friday at 5 in the afternoon", "2026-10-09T21:00:00.000Z"],
    ["Friday at 06:00", "2026-10-09T10:00:00.000Z"],
    ["Friday at 18:00", "2026-10-09T22:00:00.000Z"],
    ["Friday at 13", "2026-10-09T17:00:00.000Z"],
    ["Friday at 0:30", "2026-10-09T04:30:00.000Z"],
    ["tonight at 5", "2026-10-05T21:00:00.000Z"],
    ["this afternoon at 3", "2026-10-05T19:00:00.000Z"],
  ])("meridiem stated (or 24-hour / zero-padded): no AM/PM line, not shifted: %s", (t, at) => {
    const x = r(t);
    expect(x.due_at).toBe(at);
    expect(hasAmPmLine(x), JSON.stringify(x.not_sure)).toBe(false);
  });

  it.each(["5:30", "at 6", "at 5pm", "at 12"])("a bare time with no day is still no date: %s", (t) => noDate(t));

  it("DST: the PM default moves 'Sunday at 1:30' out of the London fall-back hour and keeps the line", () => {
    const x = r("Sunday at 1:30", null, ctx("2026-10-22", "Europe/London"));
    expect(x.due_at).toBe("2026-10-25T13:30:00.000Z"); // GMT after the change
    expect(hasAmPmLine(x)).toBe(true);
  });

  it("DST: 'Sunday at 2:30' on the US spring-forward day is 2:30 PM EDT (no gap shift); '2:30am' still shifts to 3:30 AM", () => {
    expect(r("Sunday at 2:30", null, ctx("2027-03-10")).due_at).toBe("2027-03-14T18:30:00.000Z");
    expect(r("Sunday at 2:30am", null, ctx("2027-03-10")).due_at).toBe("2027-03-14T07:30:00.000Z");
  });
});

describe("D50: a time of day that states the morning is never shifted to PM (REGRESSION GUARDS)", () => {
  // REGRESSION GUARD (was DEFECT T-D1, introduced by 2e4686f, fixed on fix/dates-and-toast): "morning" states AM, but STATED_MERIDIEM only knows
  // am/pm/noon/midnight and chrono does not always mark the meridiem certain, so the PM default
  // fires. Before 2e4686f these read 5/6 AM (correct time, wrong AM/PM line). Now the deadline is
  // 12 hours late, a model that says 6 AM is overridden (chrono wins, rule 3), and the
  // "doesn't say AM or PM" line is false.
  it.each([
    ["this morning at 5", "2026-10-05T09:00:00.000Z"],
    ["tomorrow morning at 6", "2026-10-06T10:00:00.000Z"],
    ["Friday morning at 6", "2026-10-09T10:00:00.000Z"],
    ["Friday at 6 in the morning", "2026-10-09T10:00:00.000Z"],
    ["tomorrow at 5 in the morning", "2026-10-06T09:00:00.000Z"],
  ])("%s → AM (or no time), never PM", (t, am) => {
    const x = r(t);
    expect(x.due_at === am || x.due_time_known === false, `${t} → ${x.due_at}`).toBe(true);
    expect(hasAmPmLine(x), JSON.stringify(x.not_sure)).toBe(false);
  });
});

describe("T-C1 end of day (REGRESSION GUARDS)", () => {
  it.each(["end of the day", "by the end of the day", "EOD", "by EOD", "COB", "close of business", "end of business day", "by end of business day"])(
    "%s → the written-on day, no clock time, inferred",
    (t) => expect(r(t)).toMatchObject({ due_date: "2026-10-05", due_time_known: false, due_certainty: "inferred" }),
  );
  it.each([
    ["Friday EOD", "2026-10-09"],
    ["EOD Friday", "2026-10-09"],
    ["by end of day Friday", "2026-10-09"],
    ["end of day tomorrow", "2026-10-06"],
    ["COB Oct 15", "2026-10-15"],
  ])("%s → the named day, not the written-on day", (t, d) => expect(r(t).due_date).toBe(d));
  it("year rollover: 'end of the day' written Dec 31 is Dec 31, not Jan 1", () => expect(r("end of the day", null, ctx("2026-12-31")).due_date).toBe("2026-12-31"));
  it("defaulted reference date: 'EOD' is inferred with an Assumed line", () => {
    const x = r("EOD", null, { ...NY, referenceDateSource: "defaulted" });
    expect(x.due_certainty).toBe("inferred");
    expect(x.reasoning).toMatch(/I assumed this was written today/);
  });
});

describe("deadline idioms: stripping is not over-broad (REGRESSION GUARDS)", () => {
  // Words that look like the masked idioms but are not dates.
  it.each(["Bob", "cob salad", "COBRA deadline", "the cobbler", "end of the road", "end of the line", "first thing", "first thing in the morning", "at the latest", "at the very latest", "the latest"])(
    "%s → no date",
    (t) => noDate(t),
  );
  it.each([
    ["Friday at the very latest", "2026-10-09"],
    ["first thing tomorrow", "2026-10-06"],
    ["tomorrow first thing", "2026-10-06"],
    ["first thing in the morning Friday", "2026-10-09"],
  ])("%s → day kept", (t, d) => expect(r(t).due_date).toBe(d));
  it("an idiom does not hide a second date: 'Friday, or Monday at the latest' stays no date", () => noDate("Friday, or Monday at the latest"));
  it("an idiom does not unlock a range: 'Friday EOD to Monday' stays no date", () => noDate("Friday EOD to Monday"));
});

describe("T-C3 vague amounts (REGRESSION GUARDS)", () => {
  it.each(["in a few days", "a couple of weeks", "several days from now", "a few days after the 15th", "Oct 15 or a few days after", "in a couple of hours", "few days", "the next couple of Fridays"])(
    "%s → no date",
    (t) => noDate(t),
  );
  // Real dates whose phrase happens to contain no vague word stay dates.
  it.each([
    ["Friday", "2026-10-09"],
    ["Oct 15", "2026-10-15"],
    ["in 3 days", "2026-10-08"],
  ])("%s → kept", (t, d) => expect(r(t).due_date).toBe(d));
});

describe("T-C2 weekday contradicts the date (REGRESSION GUARDS)", () => {
  it.each(["Monday Oct 9", "Friday the 13th", "Fri Oct 10", "Tuesday, October 9th"])("%s → no date, with a weekday 'Not sure about' line", (t) => {
    const x = r(t, "2026-10-09");
    expect(x).toMatchObject({ due_date: null, due_certainty: "none" });
    expect(x.not_sure.join(" ")).toMatch(/says \w+day, but .* is a \w+day, so I didn't set a date/);
  });
  it.each([
    ["Friday Oct 9", "2026-10-09"],
    ["Friday, October 9th", "2026-10-09"],
    ["Fri 10/9", "2026-10-09"],
    ["Friday the 9th", "2026-10-09"],
    ["Tuesday the 13th", "2026-10-13"],
    ["Sat Oct 10 at 5", "2026-10-10"],
  ])("a matching weekday is kept: %s", (t, d) => expect(r(t).due_date).toBe(d));
  it("year rollover: 'Monday Jan 4' written Dec 28, 2026 is Mon Jan 4, 2027 (checked against the resolved year)", () => {
    expect(r("Monday Jan 4", null, ctx("2026-12-28")).due_date).toBe("2027-01-04");
    noDate("Monday Jan 1", ctx("2026-12-28")); // Jan 1, 2027 is a Friday
  });
});

describe("observed (pre-existing on fix/core-loop-followups, reported, not introduced by 2e4686f)", () => {
  // Rule 3 risk: "the day" alone is read by chrono as tomorrow; T-C1's fix covers only "end of the day".
  it.each(["the day", "on the day", "by the day", "before the day"])("'%s' currently → Tue Oct 6 (inferred, Check this date)", (t) => {
    expect(r(t)).toMatchObject({ due_date: "2026-10-06", due_certainty: "inferred" });
  });
  // The idiom "at the end of the day" (= ultimately) now reads as the written-on day (was tomorrow).
  it("'at the end of the day' currently → written-on day, inferred", () => expect(r("at the end of the day")).toMatchObject({ due_date: "2026-10-05", due_certainty: "inferred" }));
  // "midnight" is the start of the named day (00:00 Fri = Thursday night), not its end.
  it("'Friday at midnight' currently → Fri Oct 9 00:00 EDT", () => expect(r("Friday at midnight").due_at).toBe("2026-10-09T04:00:00.000Z"));
  // Recall: "12 noon" gives no date.
  it("'Friday at 12 noon' currently gives no date", () => noDate("Friday at 12 noon"));
});

describe("round 3 (bb20ada): parts of the day (REGRESSION GUARDS)", () => {
  // Written Mon Oct 5 (EDT, UTC-4). The part of the day states AM/PM: no PM default, no AM/PM line.
  it.each([
    ["this evening at 11", "2026-10-05T23:00"],
    ["tonight at 11", "2026-10-05T23:00"],
    ["Saturday morning at 11:30", "2026-10-10T11:30"],
    ["Saturday morning at 1", "2026-10-10T01:00"],
    ["tomorrow evening at 6", "2026-10-06T18:00"],
    ["Friday night at 9", "2026-10-09T21:00"],
    ["Friday night at 11", "2026-10-09T23:00"],
    ["this afternoon at 1", "2026-10-05T13:00"],
  ])("%s → %s local, no AM/PM line", (t, local) => {
    const x = r(t);
    expect(x.due_at).toBe(new Date(`${local}:00-04:00`).toISOString());
    expect(hasAmPmLine(x)).toBe(false);
  });
  it.each(["early morning Friday", "Friday early morning", "at 2 at night", "overnight Friday", "Friday at 5 (night shift)"])("%s → no date (safe)", (t) => noDate(t));
  it("the AM/PM line still appears when no part of the day is stated ('tomorrow at 5')", () => expect(hasAmPmLine(r("tomorrow at 5"))).toBe(true));
});

describe("OPEN DEFECT T-D2 (pre-existing, not introduced by this branch): night + a small hour becomes the afternoon", () => {
  // chrono adds 12 to every hour after "night"/"tonight", so "tonight at 1" is read as 1 PM, which
  // contradicts "tonight". STATED_MERIDIEM (correctly) treats "night" as stating the meridiem, so no
  // AM/PM line is shown either, and chrono wins over the model (rule 3): a model that says Tue 1:00 AM
  // is overridden by Mon 1:00 PM. Already the case before 2e4686f (chrono's hour 13 was > 12, so it was
  // never "guessed"). Required: never an hour from 12 to 5 PM for night/tonight without a "Not sure
  // about" line; either the small-hours reading (next day, AM) or no clock time.
  const localHour = (iso: string | null) =>
    iso ? Number(new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" })) : null;
  it.fails.each(["tonight at 1", "tonight at 2:30", "tonight at 12", "Friday night at 2", "tomorrow night at 3"])(
    "DEFECT: %s is never read as an afternoon time without a 'Not sure about' line",
    (t) => {
      const x = r(t);
      const h = localHour(x.due_at);
      const afternoon = h !== null && h >= 12 && h <= 17;
      expect(afternoon && !hasAmPmLine(x), `${t} → ${x.due_at} ${JSON.stringify(x.not_sure)}`).toBe(false);
    },
  );
  it.fails("DEFECT: a model saying Tue 1:00 AM for 'tonight at 1' is not overridden by Mon 1:00 PM", () => {
    expect(r("tonight at 1", "2026-10-06T01:00:00").due_at).not.toBe("2026-10-05T17:00:00.000Z");
  });
});
