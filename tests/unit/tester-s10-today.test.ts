/**
 * Lead-tester S10 (F10 Today ranking, F8 Why panel templates): independent checks of the cap,
 * threshold, deterministic order, snoozed threads whose snooze has passed, DST, year rollover and a
 * timezone change, plus a static check that nothing on the Today / Why path can reach a model
 * (rule 6) or read the wall clock (getNow() only). Pure functions; no network.
 *
 * `it.fails` pins a defect: it asserts the SAFE behaviour and currently fails.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attentionScore, calendarDaysFrom, todaySections, urgency, type ScoredThread } from "@/lib/threads/attention";
import { quoteContext, reasonLine, whyNow } from "@/lib/threads/why";
import { fromZonedTime } from "date-fns-tz";

/** Local wall time → instant (the same conversion the pipeline uses for stored deadlines). */
const zonedInstant = (date: string, hhmm: string, tz: string) => fromZonedTime(`${date}T${hhmm}:00`, tz);

const NY = "America/New_York";
let seq = 0;
function th(over: Partial<ScoredThread> = {}): ScoredThread {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    status: "open",
    due_at: null,
    expected_by: null,
    snoozed_until: null,
    resolved_at: null,
    confidence: 1,
    consequence: null,
    consequence_basis: null,
    created_at: "2026-10-01T12:00:00Z",
    ...over,
  };
}
/** 23:59 local on a calendar date: how the pipeline stores a date-only deadline. */
const dateOnly = (ymd: string, tz = NY) => zonedInstant(ymd, "23:59", tz).toISOString();

function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe("tester S10: Worth your attention (cap 5, score ≥ 0.3, deterministic)", () => {
  const now = new Date("2026-10-27T14:00:00Z");

  it("20 overdue threads: exactly 5, and the same 5 in the same order for 50 shuffles of the input", () => {
    const threads = Array.from({ length: 20 }, (_, i) => th({ due_at: dateOnly(`2026-10-${String(1 + i).padStart(2, "0")}`), confidence: i % 2 ? 0.9 : 1 }));
    const first = todaySections(threads, NY, now).attention.map((t) => t.id);
    expect(first).toHaveLength(5);
    for (let s = 1; s <= 50; s++) expect(todaySections(shuffle(threads, s), NY, now).attention.map((t) => t.id)).toEqual(first);
  });

  it("ties on score break by earliest due, then undated last, then oldest created, then id", () => {
    const a = th({ due_at: dateOnly("2026-10-20"), created_at: "2026-10-05T00:00:00Z" });
    const b = th({ due_at: dateOnly("2026-10-10"), created_at: "2026-10-06T00:00:00Z" });
    const c = th({ due_at: dateOnly("2026-10-10"), created_at: "2026-10-04T00:00:00Z" });
    const d = th({ id: "00000000-0000-4000-8000-ffffffffffff", due_at: dateOnly("2026-10-10"), created_at: "2026-10-04T00:00:00Z" });
    const e = th({ id: "00000000-0000-4000-8000-000000000000", due_at: dateOnly("2026-10-10"), created_at: "2026-10-04T00:00:00Z" });
    const ids = todaySections(shuffle([a, b, c, d, e], 7), NY, now).attention.map((t) => t.id);
    // All overdue (score 1.0). Due Oct 10 before Oct 20; among c, d, e (same due, same created) the id decides.
    expect(ids).toEqual([e.id, c.id, d.id, b.id, a.id]);
  });

  it("threshold edges: 0.3 exactly is in (upcoming × 1.0; waiting-past × 0.5), 0.297 is out, 0.2 (undated) is out", () => {
    const upcoming = th({ due_at: dateOnly("2026-11-05") }); // 9 days: upcoming 0.3
    const waitingHalf = th({ status: "waiting", expected_by: dateOnly("2026-10-20"), confidence: 0.5 }); // 0.6 × 0.5
    const justUnder = th({ due_at: dateOnly("2026-11-05"), confidence: 0.99 }); // 0.297
    const undated = th({});
    const ids = todaySections([upcoming, waitingHalf, justUnder, undated], NY, now).attention.map((t) => t.id);
    expect(ids).toContain(upcoming.id);
    expect(ids).toContain(waitingHalf.id);
    expect(ids).not.toContain(justUnder.id);
    expect(ids).not.toContain(undated.id);
  });

  it("a source-backed consequence lifts a due-soon thread above an unbacked one; an interpretation does not", () => {
    const backed = th({ due_at: dateOnly("2026-10-29"), consequence: "Late fee $40", consequence_basis: "source" });
    const interp = th({ due_at: dateOnly("2026-10-29"), consequence: "Might cost money", consequence_basis: "interpretation" });
    expect(attentionScore(backed, NY, now)).toBeCloseTo(0.84);
    expect(attentionScore(interp, NY, now)).toBeCloseTo(0.7);
  });
});

describe("tester S10: snoozed threads", () => {
  const now = new Date("2026-10-27T14:00:00Z");

  it("snoozed_until in the past: ranked as open in attention (and Coming up does not repeat it)", () => {
    const woke = th({ status: "snoozed", snoozed_until: "2026-10-26T13:00:00Z", due_at: dateOnly("2026-10-25") });
    const s = todaySections([woke], NY, now);
    expect(s.attention.map((t) => t.id)).toEqual([woke.id]);
    expect(s.comingUp).toEqual([]);
    expect(whyNow({ ...woke, kind: "commitment", counterparty: null, waiting_on: null }, NY, now)).toBe("It's still open. It's 2 days overdue.");
  });

  it("snoozed_until exactly now counts as passed; one millisecond later it is still hidden everywhere", () => {
    const due = dateOnly("2026-10-28");
    const exactly = th({ status: "snoozed", snoozed_until: now.toISOString(), due_at: due });
    const later = th({ status: "snoozed", snoozed_until: new Date(now.getTime() + 1).toISOString(), due_at: due });
    const s = todaySections([exactly, later], NY, now);
    expect(s.attention.map((t) => t.id)).toEqual([exactly.id]);
    const all = [...s.attention, ...s.waiting, ...s.comingUp, ...s.resolved].map((t) => t.id);
    expect(all).not.toContain(later.id);
  });

  it("a passed snooze with a due date 10 days out is in Coming up, not attention", () => {
    const woke = th({ status: "snoozed", snoozed_until: "2026-10-20T00:00:00Z", due_at: dateOnly("2026-11-06"), confidence: 0.9 });
    const s = todaySections([woke], NY, now);
    expect(s.attention).toEqual([]);
    expect(s.comingUp.map((t) => t.id)).toEqual([woke.id]);
  });

  it("snoozed with snoozed_until null is never ranked (no crash)", () => {
    const odd = th({ status: "snoozed", snoozed_until: null, due_at: dateOnly("2026-10-20") });
    expect(attentionScore(odd, NY, now)).toBeNull();
  });
});

describe("tester S10: dates (DST, rollover, timezone change)", () => {
  it("DST start in New York (Mar 8 2026, 2 AM skipped): a date-only deadline that day is due today from 00:30 to 23:58", () => {
    const due = dateOnly("2026-03-08");
    expect(urgency(due, NY, new Date(zonedInstant("2026-03-08", "00:30", NY)))).toBe("due_today");
    expect(urgency(due, NY, new Date(zonedInstant("2026-03-08", "23:58", NY)))).toBe("due_today");
    expect(urgency(due, NY, new Date(zonedInstant("2026-03-09", "00:01", NY)))).toBe("overdue");
    expect(urgency(due, NY, new Date(zonedInstant("2026-03-07", "23:30", NY)))).toBe("due_soon");
  });

  it("DST end in London (Oct 25 2026): Oct 26 date-only deadline is 'due tomorrow' all of Oct 25", () => {
    const L = "Europe/London";
    const due = dateOnly("2026-10-26", L);
    for (const hm of ["00:10", "01:30", "12:00", "23:50"]) {
      const now = new Date(zonedInstant("2026-10-25", hm, L));
      expect(calendarDaysFrom(due, L, now), hm).toBe(1);
      expect(whyNow({ status: "open", kind: "commitment", counterparty: null, waiting_on: null, expected_by: null, created_at: "2026-10-01T00:00:00Z", due_at: due, resolved_at: null, snoozed_until: null }, L, now)).toBe("It's still open. It's due tomorrow.");
    }
  });

  it("year rollover: Dec 31 23:30 → a Jan 1 deadline is tomorrow (due soon); a Dec 30 one is 1 day overdue", () => {
    const now = new Date(zonedInstant("2026-12-31", "23:30", NY));
    expect(calendarDaysFrom(dateOnly("2027-01-01"), NY, now)).toBe(1);
    expect(urgency(dateOnly("2027-01-01"), NY, now)).toBe("due_soon");
    expect(urgency(dateOnly("2026-12-30"), NY, now)).toBe("overdue");
    expect(urgency(dateOnly("2027-01-14"), NY, now)).toBe("upcoming");
    expect(urgency(dateOnly("2027-01-15"), NY, now)).toBe("later");
  });

  it("far-east and half-hour zones (Auckland, Kolkata, Chatham): calendar days are local", () => {
    for (const tz of ["Pacific/Auckland", "Asia/Kolkata", "Pacific/Chatham", "Pacific/Kiritimati"]) {
      const now = new Date(zonedInstant("2026-10-27", "08:00", tz));
      expect(urgency(dateOnly("2026-10-27", tz), tz, now), tz).toBe("due_today");
      expect(urgency(dateOnly("2026-10-26", tz), tz, now), tz).toBe("overdue");
    }
  });

  it("west to east: a date-only deadline set in New York stays on its calendar day after the user moves to Los Angeles", () => {
    const due = dateOnly("2026-10-28", NY); // 23:59 NY = 20:59 LA, same day
    const now = new Date(zonedInstant("2026-10-28", "09:00", "America/Los_Angeles"));
    expect(urgency(due, "America/Los_Angeles", now)).toBe("due_today");
  });

  it.fails("DEFECT (timezone change): a date-only deadline set in Los Angeles moves to the next day after the user switches to New York", () => {
    // Stored as 23:59 LA on Oct 28 = 02:59 NY on Oct 29. A user who moved east sees it as due a day later.
    const due = dateOnly("2026-10-28", "America/Los_Angeles");
    const now = new Date(zonedInstant("2026-10-28", "09:00", NY));
    expect(urgency(due, NY, now)).toBe("due_today");
  });
});

describe("tester S8/S10: reason line and quote context", () => {
  it("reason line never names a deleted source's date and never invents a counterparty", () => {
    const t = { kind: "admin" as const, status: "open" as const, counterparty: null, waiting_on: null, expected_by: null, created_at: "2026-10-05T15:00:00Z" };
    expect(reasonLine(t, { dateText: "Nov 1", source: null, timezone: NY, now: new Date("2026-10-27T12:00:00Z") })).toBe("You added this on Oct 5");
  });

  it("quote context is ±200 UTF-16 units and the quote itself is verbatim", () => {
    const text = `${"a".repeat(500)}PAY THE RENT BY FRIDAY${"b".repeat(500)}`;
    const q = quoteContext(text, { quote: "PAY THE RENT BY FRIDAY", start_offset: 500, end_offset: 522 });
    expect(q.before).toHaveLength(200);
    expect(q.after).toHaveLength(200);
    expect(q.quote).toBe("PAY THE RENT BY FRIDAY");
    expect(q.clippedBefore && q.clippedAfter).toBe(true);
  });

  it("stale offsets pointing at different text never highlight the wrong words", () => {
    const text = "Call the bank Monday. Email Mike Friday.";
    const q = quoteContext(text, { quote: "Email Mike Friday.", start_offset: 0, end_offset: 18 });
    expect(q.quote).toBe("Email Mike Friday.");
    expect(q.before).toBe("Call the bank Monday. ");
  });
});

describe("tester S10: rule 6 and getNow() on the Today / Why path (static)", () => {
  const files = [
    "lib/threads/attention.ts",
    "lib/threads/today.ts",
    "lib/threads/why.ts",
    "lib/threads/whyRead.ts",
    "components/threads/WhySheet.tsx",
    "app/today/page.tsx",
    "lib/decisions/addReason.ts",
  ];
  it.each(files)("%s imports nothing from the AI layer and never reads the wall clock", (f) => {
    const src = readFileSync(join(process.cwd(), f), "utf8");
    expect(src).not.toMatch(/from\s+["'](@\/lib\/ai\/|ai["'/]|@ai-sdk)/);
    expect(src).not.toMatch(/generateObject|generateText|askWhy\(|extract\(/);
    expect(src).not.toMatch(/new Date\(\)|Date\.now\(\)/);
  });
});
