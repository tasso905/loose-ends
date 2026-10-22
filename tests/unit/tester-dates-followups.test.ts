import { describe, expect, it } from "vitest";
import { resolveDate, type DateContext } from "@/lib/pipeline/resolveDates";

/**
 * Lead-tester: adversarial rule-3 probes for core-loop follow-up C (lib/pipeline/resolveDates.ts).
 *
 * `it` tests are REGRESSION GUARDS for behaviour verified on fix/core-loop-followups.
 * `it.fails` tests document an OPEN DEFECT: they assert the required (safe) behaviour and currently
 * fail. When the defect is fixed the test starts passing, `it.fails` turns red, and the marker must
 * become `it` with the comment relabelled REGRESSION GUARD.
 * "observed" tests pin current behaviour that is safe but costs recall; change them deliberately.
 */

const NY: DateContext = { referenceDate: "2026-10-05", referenceDateSource: "user", timezone: "America/New_York" };
const at = (referenceDate: string, timezone = "America/New_York"): DateContext => ({ referenceDate, referenceDateSource: "user", timezone });
const noDate = (text: string, iso: string | null = null, ctx: DateContext = NY) => {
  const r = resolveDate({ date_text: text, date_iso: iso }, ctx);
  expect(r, text).toMatchObject({ due_at: null, due_date: null, due_certainty: "none" });
};

describe("C: phrases that must never become a date (REGRESSION GUARDS)", () => {
  // Each of these resolved to a date before follow-up C (e.g. "not Friday" → Fri Oct 9).
  it.each([
    "not Friday",
    "not before Friday",
    "after Friday",
    "between Friday and Monday",
    "Friday and Monday",
    "Friday, or Monday at the latest",
    "Saturday from 2 to 6pm",
    "Friday by Monday",
    "Saturday 6pm by Friday",
    "Black Friday",
    "Good Friday",
    "Sunday best",
    "any day now",
    "Monday or so",
    "around Friday",
    "Friday-ish",
    "a month",
    "5 Friday",
  ])("'%s' gives no date even when the model supplies one", (t) => noDate(t, "2026-10-09"));
});

describe("C: past references read backward (REGRESSION GUARDS)", () => {
  it("'last Friday' across a year boundary: written Fri Jan 2, 2026 → Fri Dec 26, 2025", () => {
    expect(resolveDate({ date_text: "last Friday", date_iso: null }, at("2026-01-02")).due_date).toBe("2025-12-26");
  });
  it("'last Friday' written on a Friday is the previous Friday, never the same day or later", () => {
    expect(resolveDate({ date_text: "last Friday", date_iso: null }, at("2026-10-09")).due_date).toBe("2026-10-02");
  });
  it("'last Saturday at 6pm' keeps the backward date and the stated time", () => {
    expect(resolveDate({ date_text: "last Saturday at 6pm", date_iso: null }, NY)).toMatchObject({
      due_date: "2026-10-03",
      due_at: "2026-10-03T22:00:00.000Z",
      due_time_known: true,
    });
  });
  it("'yesterday' written Jan 1, 2027 is Dec 31, 2026", () => {
    expect(resolveDate({ date_text: "yesterday", date_iso: null }, at("2027-01-01")).due_date).toBe("2026-12-31");
  });
  it("a phrase with 'past' or 'last' never resolves after the written-on day", () => {
    for (const t of ["past due Friday", "overdue since last Friday", "last-minute Friday", "last call Friday", "Friday (last chance)"]) {
      const d = resolveDate({ date_text: t, date_iso: "2026-10-09" }, NY).due_date;
      expect(d === null || d <= NY.referenceDate, `${t} → ${d}`).toBe(true);
    }
  });
});

describe("C: day + separate time is one expression (REGRESSION GUARDS)", () => {
  it.each(["by 6pm on Saturday", "Saturday, by 6pm", "Saturday by 18:00"])("'%s' → Sat Oct 10, 6:00 PM EDT", (t) => {
    expect(resolveDate({ date_text: t, date_iso: "2026-10-10T18:00:00" }, NY)).toMatchObject({
      due_date: "2026-10-10",
      due_at: "2026-10-10T22:00:00.000Z",
      due_time_known: true,
    });
  });
  it("'Saturday by 6pm or Sunday' is two dates and is rejected", () => noDate("Saturday by 6pm or Sunday", "2026-10-10T18:00:00"));
  it("'Saturday by 6' (bare hour after 'by') is rejected rather than guessed", () => noDate("Saturday by 6"));
});

describe("dates: DST, year rollover and timezone (REGRESSION GUARDS)", () => {
  it("'tomorrow at 9am' written Sat Oct 31, 2026 in New York is Sun Nov 1 9 AM EST (14:00 UTC, after fall-back)", () => {
    expect(resolveDate({ date_text: "tomorrow at 9am", date_iso: null }, at("2026-10-31")).due_at).toBe("2026-11-01T14:00:00.000Z");
  });
  it("same phrase in London (BST ended Oct 25) is 09:00 UTC", () => {
    expect(resolveDate({ date_text: "tomorrow at 9am", date_iso: null }, at("2026-10-31", "Europe/London")).due_at).toBe("2026-11-01T09:00:00.000Z");
  });
  it("'Friday at 5pm' in a +05:30 and a +13:45 zone", () => {
    expect(resolveDate({ date_text: "Friday at 5pm", date_iso: null }, at("2026-10-05", "Asia/Kolkata")).due_at).toBe("2026-10-09T11:30:00.000Z");
    expect(resolveDate({ date_text: "Friday at 5pm", date_iso: null }, at("2026-10-05", "Pacific/Chatham")).due_at).toBe("2026-10-09T03:15:00.000Z");
  });
  it("'Jan 2' written Dec 30, 2026 rolls to 2027; 'Dec 28' written Jan 3, 2027 stays in 2026", () => {
    expect(resolveDate({ date_text: "Jan 2", date_iso: null }, at("2026-12-30")).due_date).toBe("2027-01-02");
    expect(resolveDate({ date_text: "Dec 28", date_iso: null }, at("2027-01-03")).due_date).toBe("2026-12-28");
  });
  it("'this Friday' vs 'next Friday' written Mon Oct 5: Oct 9 vs Oct 16", () => {
    expect(resolveDate({ date_text: "this Friday", date_iso: null }, NY).due_date).toBe("2026-10-09");
    expect(resolveDate({ date_text: "next Friday", date_iso: null }, NY).due_date).toBe("2026-10-16");
  });
});

describe("rule 3 OPEN DEFECTS found in follow-up verification", () => {
  // DEFECT T-C1 (pre-existing, not introduced by C): "end of the day" written Mon Oct 5 resolves to
  // Tue Oct 6. chrono wins on disagreement, so a model that correctly says Oct 5 is overridden with
  // the wrong day. "by the end of the day" is a common deadline phrase.
  it.fails("DEFECT: 'by the end of the day' written Mon Oct 5 is Oct 5 or no date, never Oct 6", () => {
    for (const t of ["by the end of the day", "the end of the day", "end of the day"]) {
      const d = resolveDate({ date_text: t, date_iso: "2026-10-05" }, NY).due_date;
      expect(d === null || d === "2026-10-05", `${t} → ${d}`).toBe(true);
    }
  });

  // DEFECT T-C2 (pre-existing): a weekday that contradicts the date is resolved silently. With an
  // agreeing model the result is `explicit` with no "Not sure about" line, though the source is
  // self-contradictory ("Monday Oct 9": Oct 9, 2026 is a Friday; "Friday the 13th" → Tue Oct 13).
  it.fails("DEFECT: a weekday that contradicts the date is rejected or flagged, never explicit", () => {
    for (const [t, iso] of [["Monday Oct 9", "2026-10-09"], ["Friday the 13th", "2026-10-13"], ["Fri Oct 10", "2026-10-10"]] as const) {
      const r = resolveDate({ date_text: t, date_iso: iso }, NY);
      expect(r.due_date === null || (r.due_certainty === "inferred" && r.not_sure.length > 0), `${t} → ${r.due_date} ${r.due_certainty}`).toBe(true);
    }
  });

  // DEFECT T-C3: follow-up C says bare durations give no date, and "one day", "few days", "2 days"
  // do not; but "a few days", "a couple of days", "a couple days" and "several days" still become
  // a date (Oct 7 / Oct 8 / Oct 12), as does "the past few days" (Oct 2).
  it.fails("DEFECT: 'a few days', 'a couple of days', 'several days', 'the past few days' give no date", () => {
    for (const t of ["a few days", "a couple of days", "a couple days", "several days", "the past few days"]) noDate(t);
  });
});

describe("observed: safe but lower recall after C (for the date-accuracy eval)", () => {
  // These were resolved to the right day before C and now give no date. Not a trust-rule breach
  // (no date beats a wrong date), but common deadline phrasing; "at the latest" appears in eval
  // fixture 05 and a model may return it inside date_text.
  it.each(["Friday at the latest", "Oct 31 at the latest", "first thing Friday", "Saturday at 6pm at the latest"])("'%s' currently gives no date", (t) => noDate(t));
});
