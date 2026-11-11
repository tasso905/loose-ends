import { describe, expect, it } from "vitest";
import { editFieldsToState, endOfLocalDay, EditFields, snoozeMenuDates, snoozeUntil } from "@/lib/threads/actions";

/**
 * Lead-tester S12: Snooze presets are 9:00 in the user's timezone (D11) and date-only fields are
 * 23:59 local, across DST changes, year rollover, far-east and half-hour zones.
 */

const NY = "America/New_York";

describe("Snooze presets across DST and year rollover", () => {
  it("Tomorrow across the US fall-back (Sat Oct 31 2026 → Sun Nov 1, EST)", () => {
    const now = new Date("2026-11-01T02:00:00Z"); // Sat Oct 31, 22:00 EDT
    expect(snoozeUntil({ preset: "tomorrow" }, now, NY)).toBe("2026-11-01T14:00:00.000Z");
  });

  it("Next Monday on the fall-back Sunday is the next day, at 9:00 EST", () => {
    const now = new Date("2026-11-01T16:00:00Z"); // Sun Nov 1, 11:00 EST
    expect(snoozeUntil({ preset: "next_monday" }, now, NY)).toBe("2026-11-02T14:00:00.000Z");
  });

  it("Tomorrow across the US spring-forward (Sat Mar 13 2027 → Sun Mar 14, EDT)", () => {
    const now = new Date("2027-03-13T15:00:00Z");
    expect(snoozeUntil({ preset: "tomorrow" }, now, NY)).toBe("2027-03-14T13:00:00.000Z");
  });

  it("Year rollover: Thu Dec 31 2026 evening → Tomorrow Jan 1 2027, Next Monday Jan 4 2027", () => {
    const now = new Date("2027-01-01T01:00:00Z"); // Thu Dec 31, 20:00 EST
    expect(snoozeUntil({ preset: "tomorrow" }, now, NY)).toBe("2027-01-01T14:00:00.000Z");
    expect(snoozeUntil({ preset: "next_monday" }, now, NY)).toBe("2027-01-04T14:00:00.000Z");
    expect(snoozeMenuDates(now, NY)).toEqual({ tomorrow: "Fri Jan 1", nextMonday: "Mon Jan 4", minDate: "2027-01-01" });
  });

  it("Auckland (ahead of UTC) and Kolkata (half-hour offset) use their own local date and 9:00", () => {
    const now = new Date("2026-11-10T12:00:00Z"); // Wed Nov 11, 01:00 NZDT; Tue Nov 10, 17:30 IST
    expect(snoozeUntil({ preset: "tomorrow" }, now, "Pacific/Auckland")).toBe("2026-11-11T20:00:00.000Z"); // Thu Nov 12 09:00 NZDT
    expect(snoozeUntil({ preset: "tomorrow" }, now, "Asia/Kolkata")).toBe("2026-11-11T03:30:00.000Z"); // Wed Nov 11 09:00 IST
  });

  it("Pick a date: today is refused before and after 9:00, as the picker's min (tomorrow) and the copy say (D4b)", () => {
    const after9 = new Date("2026-11-10T15:00:00Z"); // 10:00 EST
    const before9 = new Date("2026-11-10T12:00:00Z"); // 07:00 EST
    expect(snoozeUntil({ preset: "date", date: "2026-11-10" }, after9, NY)).toBeNull();
    // Was: accepted before 9:00 (lead-tester D4b). Developer fix: the server refuses today too.
    expect(snoozeUntil({ preset: "date", date: "2026-11-10" }, before9, NY)).toBeNull();
    expect(snoozeUntil({ preset: "date", date: "2026-11-11" }, before9, NY)).toBe("2026-11-11T14:00:00.000Z");
    expect(snoozeMenuDates(before9, NY).minDate).toBe("2026-11-11");
  });
});

describe("date-only fields at 23:59 local", () => {
  it("expected-by on the fall-back day and the spring-forward day", () => {
    expect(endOfLocalDay("2026-11-01", NY)).toBe("2026-11-02T04:59:00.000Z");
    expect(endOfLocalDay("2027-03-14", NY)).toBe("2027-03-15T03:59:00.000Z");
  });

  it("Edit: a due time inside the spring-forward gap moves forward by the gap (02:30 → 03:30 EDT)", () => {
    const f = EditFields.parse({ due: { date: "2027-03-14", time: "02:30" } });
    expect(editFieldsToState(f, NY, new Date("2027-03-01T00:00:00Z"))).toEqual({
      ok: true,
      fields: { due_at: "2027-03-14T07:30:00.000Z", due_time_known: true },
    });
  });

  it("Edit refuses Feb 30 and a year outside 1900–2100 (D47 rule)", () => {
    expect(EditFields.safeParse({ due: { date: "2027-02-30", time: null } }).success).toBe(false);
    expect(EditFields.safeParse({ expected_by: "2101-01-01" }).success).toBe(false);
  });
});
