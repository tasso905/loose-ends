import { describe, expect, it } from "vitest";
import { resolveDate, type DateContext } from "@/lib/pipeline/resolveDates";
import { containsWholePhrase } from "@/lib/pipeline/verifyQuotes";

/**
 * Lead-tester findings from writing eval fixtures 21-40 (test/eval-fixtures-21-40). `it` = REGRESSION
 * GUARD (verified behaviour). `it.fails` = OPEN DEFECT: it asserts the required (safe) behaviour and
 * currently fails; when the defect is fixed the test turns red and must be flipped to `it`.
 */

const ctx = (referenceDate: string, timezone: string): DateContext => ({ referenceDate, referenceDateSource: "user", timezone });

describe("T-D3: a time stated in another timezone", () => {
  // DEFECT T-D3 (rule 3). chrono parses a zone abbreviation ("PT", "GMT", "EST"), but chronoResolve()
  // keeps only the written hour and rebuilds it as wall time in the user's zone, so the zone is
  // silently dropped. "Friday at 11pm PT" for a London user (written Tue Oct 20, 2026) is 06:00Z
  // Sat Oct 24 (7:00 AM London); the pipeline stores Fri Oct 23 22:00Z: the wrong DAY. Safe outcome:
  // convert the stated zone, or set no date. Either passes.
  it.fails("'Friday at 11pm PT' for a London user is Sat Oct 24 06:00Z, or no date", () => {
    const r = resolveDate({ date_text: "Friday at 11pm PT", date_iso: null }, ctx("2026-10-20", "Europe/London"));
    expect(r.due_date === null || (r.due_date === "2026-10-24" && r.due_at === "2026-10-24T06:00:00.000Z"), `${r.due_date} ${r.due_at}`).toBe(true);
  });

  it.fails("'Thursday at 3pm GMT' for a New York user is 15:00Z (11:00 AM EDT), or no date", () => {
    const r = resolveDate({ date_text: "Thursday at 3pm GMT", date_iso: null }, ctx("2026-10-20", "America/New_York"));
    expect(r.due_date === null || r.due_at === "2026-10-22T15:00:00.000Z", `${r.due_date} ${r.due_at}`).toBe(true);
  });

  // Guard: times with no stated zone are the user's own zone (fixture 25, user moved to Tokyo).
  it("'by Monday at 8am' for a Tokyo user is Mon Oct 26 local, Sun Oct 25 23:00Z", () => {
    const r = resolveDate({ date_text: "by Monday at 8am", date_iso: "2026-10-26" }, ctx("2026-10-23", "Asia/Tokyo"));
    expect({ due_date: r.due_date, due_at: r.due_at, due_certainty: r.due_certainty }).toEqual({
      due_date: "2026-10-26",
      due_at: "2026-10-25T23:00:00.000Z",
      due_certainty: "explicit",
    });
  });
});

describe("T-Q1: a date phrase right after a year-like number", () => {
  // DEFECT T-Q1 (recall; safe direction). containsWholePhrase(kind "date") refuses a date phrase that
  // follows a 4-digit number, to stop "Oct 9" matching inside "2027 Oct 9". It also fires when the
  // phrase starts with a word ("by"), so in "choose a medical plan for 2027 by Friday, November 13."
  // the model's date_text "by Friday, November 13" is cleared as unverified and the item loses its
  // due date (found while writing fixture 39, which was reworded to avoid it).
  it.fails("'by Friday, November 13' after 'for 2027' is found in the source", () => {
    expect(containsWholePhrase("You need to choose a medical plan for 2027 by Friday, November 13.", "by Friday, November 13", "date")).toBe(true);
  });

  // Guard: the year-before rule still refuses a phrase that would drop its own year.
  it("'Oct 9' is still not found in '2027 Oct 9'", () => {
    expect(containsWholePhrase("The hearing is on 2027 Oct 9.", "Oct 9", "date")).toBe(false);
  });
});

describe("observations from fixtures 21-40 (REGRESSION GUARDS of current behaviour)", () => {
  // Not a defect ruling: 'within N days' is read as reference date + N. Fixture 40's golden marks the
  // policy clause 'within 14 days about any change' as Ignore, because its anchor is a future event.
  it("'within 14 days' written Fri Oct 9 reads as Fri Oct 23", () => {
    expect(resolveDate({ date_text: "within 14 days", date_iso: null }, ctx("2026-10-09", "America/New_York")).due_date).toBe("2026-10-23");
  });
  it("'within 5-7 business days' (a range) gives no date", () => {
    expect(resolveDate({ date_text: "within 5-7 business days", date_iso: "2026-10-29" }, ctx("2026-10-20", "America/Phoenix")).due_date).toBeNull();
  });
  it("'early next week' gives no date", () => {
    expect(resolveDate({ date_text: "early next week", date_iso: "2026-10-19" }, ctx("2026-10-15", "America/New_York")).due_date).toBeNull();
  });
});
