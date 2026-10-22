import { describe, expect, it } from "vitest";
import { TOAST_HARD_LIMIT_MS, TOAST_MS } from "@/components/toast/UndoToast";
import { resolveDate, type DateContext } from "@/lib/pipeline/resolveDates";
import { UNDO_GRACE_MS, UNDO_WINDOW_MS } from "@/lib/threads/transition";

/**
 * Lead-tester verification of fix/toast-11s-and-night-hours (ee8c08b): D51 toast limit and T-D2
 * (night + a small hour is the next day's small hours). `it.fails` pins a defect: it asserts the
 * SAFE behaviour and currently fails; when fixed it turns red and must be flipped to `it`.
 */

const ctx = (referenceDate: string, timezone = "America/New_York"): DateContext => ({ referenceDate, referenceDateSource: "user", timezone });
const NY = ctx("2026-10-05"); // Mon Oct 5, 2026
const r = (text: string, iso: string | null = null, c: DateContext = NY) => resolveDate({ date_text: text, date_iso: iso }, c);
const local = (iso: string | null, tz = "America/New_York") =>
  iso
    ? new Date(iso).toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : null;
const ampmLine = (x: { not_sure: string[] }) => x.not_sure.some((l) => l.includes("doesn't say AM or PM"));

describe("D51: toast and server windows", () => {
  it("the toast closes 11 s after the action: after its 8 s countdown, 1 s inside the server's 12 s window", () => {
    expect(TOAST_MS).toBe(8_000);
    expect(TOAST_HARD_LIMIT_MS).toBe(11_000);
    expect(UNDO_WINDOW_MS + UNDO_GRACE_MS).toBe(12_000);
    expect(UNDO_WINDOW_MS + UNDO_GRACE_MS - TOAST_HARD_LIMIT_MS).toBe(1_000);
  });
});

describe("T-D2 guards: small hours after night/tonight", () => {
  it.each([
    ["tonight at 12:30", "2026-10-06, 00:30"],
    ["tonight at 4:59", "2026-10-06, 04:59"],
    ["tonight at midnight", "2026-10-06, 00:00"],
    ["midnight tonight", "2026-10-06, 00:00"],
    ["Saturday night at 1", "2026-10-11, 01:00"],
    ["Oct 9 night at 3", "2026-10-10, 03:00"],
  ])("'%s' → %s local, inferred", (t, at) => {
    const x = r(t);
    expect(local(x.due_at)).toBe(at);
    expect(x.due_certainty).toBe("inferred");
  });

  it("evening hours are unchanged and 5 stays 5 PM with no AM/PM line (D50 guard)", () => {
    expect(local(r("tonight at 5").due_at)).toBe("2026-10-05, 17:00");
    expect(ampmLine(r("tonight at 5"))).toBe(false);
    expect(local(r("tonight at 6").due_at)).toBe("2026-10-05, 18:00");
    expect(local(r("tonight at 11").due_at)).toBe("2026-10-05, 23:00");
  });

  it("year rollover: 'tonight at 1' written Dec 31 is Jan 1 of the next year", () => {
    const x = r("tonight at 1", null, ctx("2026-12-31"));
    expect(x.due_date).toBe("2027-01-01");
    expect(local(x.due_at)).toBe("2027-01-01, 01:00");
  });

  it("DST fall back (Nov 1, 2026, New York): 'tonight at 1' written Oct 31 is a real instant on Nov 1", () => {
    const x = r("tonight at 1", null, ctx("2026-10-31"));
    expect(x.due_date).toBe("2026-11-01");
    expect(local(x.due_at)).toBe("2026-11-01, 01:00");
  });

  it("DST spring forward (Mar 8, 2026): 'tonight at 2' written Mar 7 lands on Mar 8 (2:00 does not exist; a valid instant is kept)", () => {
    const x = r("tonight at 2", null, ctx("2026-03-07"));
    expect(x.due_date).toBe("2026-03-08");
    expect(x.due_at).not.toBeNull();
    expect(local(x.due_at)!.startsWith("2026-03-08, 0")).toBe(true);
  });

  it("timezone: Tokyo 'tonight at 1' is 1:00 AM Tokyo the next day", () => {
    const x = r("tonight at 1", null, ctx("2026-10-05", "Asia/Tokyo"));
    expect(local(x.due_at, "Asia/Tokyo")).toBe("2026-10-06, 01:00");
  });

  it("chrono wins over a model reading 'Friday night at 1' as Friday 1 PM: Saturday 1 AM, disagree, inferred", () => {
    const x = r("Friday night at 1", "2026-10-09T13:00:00");
    expect(x.agreement).toBe("disagree");
    expect(local(x.due_at)).toBe("2026-10-10, 01:00");
    expect(x.due_certainty).toBe("inferred");
  });

  it("'this Friday night at 2' and 'next Friday night at 2' are the day after 'this/next Friday'", () => {
    for (const p of ["this Friday", "next Friday"]) {
      const day = r(p).due_date!;
      const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(r(`${p} night at 2`).due_date, p).toBe(next);
    }
  });

  it("'tonight' with no hour stays the written-on day", () => {
    expect(r("tonight").due_date).toBe("2026-10-05");
  });
});

describe("T-D2 residual defects (non-blocking)", () => {
  // DEFECT: the fix skips any text with an explicit am/pm, so "tonight at 1am" stays at 1:00 AM on
  // the written-on day: the start of the day the message was written, before "tonight". The safe
  // reading is the next day's 1:00 AM, as for "tonight at 1".
  it.each(["tonight at 1am", "tonight at 1 am", "tonight at 2:30am"])("'%s' is the next day's small hours", (t) => {
    expect(r(t).due_date).toBe("2026-10-06");
  });

  // DEFECT: a 24-hour time states the half of the day, but the fix turns "tonight at 13:00" into
  // 1:00 AM the next day and says the text "doesn't say AM or PM" (untrue). Safe: no AM/PM line for a
  // 24-hour time, and 13:00 is never read as 1:00 AM.
  it.each(["tonight at 13:00", "tonight at 14:30"])("'%s' is not rewritten as a small hour with an AM/PM line", (t) => {
    const x = r(t);
    expect(ampmLine(x)).toBe(false);
    expect(Number(local(x.due_at)!.slice(-5, -3))).toBeGreaterThanOrEqual(12);
  });

  // DEFECT (copy): "tonight at 01:00" resolves correctly to 1:00 AM the next day, but the zero-padded
  // 24-hour time states AM; the line "doesn't say AM or PM" is untrue (outside T-D2, "at 01:00" gets
  // no such line: meridiemGuessed excludes 0d:dd).
  it("'tonight at 01:00' has no 'doesn't say AM or PM' line", () => {
    const x = r("tonight at 01:00");
    expect(local(x.due_at)).toBe("2026-10-06, 01:00");
    expect(ampmLine(x)).toBe(false);
  });
});
