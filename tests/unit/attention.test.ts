import { describe, expect, it } from "vitest";
import {
  ATTENTION_MAX,
  attentionScore,
  calendarDaysFrom,
  todaySections,
  urgency,
  type ScoredThread,
} from "@/lib/threads/attention";

const NY = "America/New_York";
const NOW = new Date("2026-10-22T14:00:00Z"); // Thu Oct 22, 10:00 in New York

let n = 0;
function thread(over: Partial<ScoredThread> = {}): ScoredThread {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    status: "open",
    due_at: null,
    expected_by: null,
    snoozed_until: null,
    resolved_at: null,
    confidence: 0.9,
    consequence: null,
    consequence_basis: null,
    created_at: "2026-10-01T12:00:00Z",
    ...over,
  };
}

describe("urgency (PRD: user timezone + getNow())", () => {
  it("classifies by calendar day in the user's timezone", () => {
    expect(urgency(null, NY, NOW)).toBe("none");
    expect(urgency("2026-10-22T03:59:00Z", NY, NOW)).toBe("overdue"); // Oct 21, 23:59 NY
    expect(urgency("2026-10-22T04:00:00Z", NY, NOW)).toBe("due_today"); // Oct 22, 00:00 NY
    expect(urgency("2026-10-23T03:59:00Z", NY, NOW)).toBe("due_today"); // Oct 22, 23:59 NY
    expect(urgency("2026-10-23T16:00:00Z", NY, NOW)).toBe("due_soon"); // +1
    expect(urgency("2026-10-25T16:00:00Z", NY, NOW)).toBe("due_soon"); // +3
    expect(urgency("2026-10-26T16:00:00Z", NY, NOW)).toBe("upcoming"); // +4
    expect(urgency("2026-11-05T16:00:00Z", NY, NOW)).toBe("upcoming"); // +14
    expect(urgency("2026-11-06T17:00:00Z", NY, NOW)).toBe("later"); // +15
  });

  it("the same instant is overdue in one timezone and due today in another", () => {
    const due = "2026-10-22T02:00:00Z"; // Oct 21 22:00 NY, Oct 22 11:00 Tokyo
    expect(urgency(due, NY, NOW)).toBe("overdue");
    expect(urgency(due, "Asia/Tokyo", NOW)).toBe("due_today");
  });

  it("DST end (Nov 1 2026, a 25 h day in New York) still counts one calendar day", () => {
    const now = new Date("2026-10-31T16:00:00Z"); // Sat Oct 31, 12:00 EDT
    expect(calendarDaysFrom("2026-11-01T04:30:00Z", NY, now)).toBe(1); // Sun Nov 1, 00:30 EDT
    expect(calendarDaysFrom("2026-11-02T04:30:00Z", NY, now)).toBe(1); // Sun Nov 1, 23:30 EST
    expect(calendarDaysFrom("2026-11-02T05:30:00Z", NY, now)).toBe(2); // Mon Nov 2, 00:30 EST
    expect(urgency("2026-11-02T04:30:00Z", NY, now)).toBe("due_soon");
    // Late on the long day: 23:30 EST Sunday is still "today", not tomorrow.
    const lateSunday = new Date("2026-11-02T04:30:00Z");
    expect(urgency("2026-11-02T04:59:00Z", NY, lateSunday)).toBe("due_today");
    expect(urgency("2026-11-01T04:00:00Z", NY, lateSunday)).toBe("due_today"); // 00:00 EDT the same Sunday
    expect(urgency("2026-11-01T03:59:00Z", NY, lateSunday)).toBe("overdue");
  });

  it("DST start (Mar 14 2027, a 23 h day in New York) still counts one calendar day", () => {
    const now = new Date("2027-03-13T17:00:00Z"); // Sat Mar 13, 12:00 EST
    expect(calendarDaysFrom("2027-03-15T03:30:00Z", NY, now)).toBe(1); // Sun Mar 14, 23:30 EDT
    expect(calendarDaysFrom("2027-03-15T04:30:00Z", NY, now)).toBe(2); // Mon Mar 15, 00:30 EDT
    const lateSunday = new Date("2027-03-15T03:30:00Z");
    expect(urgency("2027-03-14T05:00:00Z", NY, lateSunday)).toBe("due_today"); // 00:00 EST Sunday
    expect(urgency("2027-03-14T04:59:00Z", NY, lateSunday)).toBe("overdue");
  });

  it("southern-hemisphere DST (Sydney, Oct 4 2026) uses the same rule", () => {
    const now = new Date("2026-10-03T02:00:00Z"); // Sat Oct 3, 12:00 AEST
    expect(urgency("2026-10-04T12:30:00Z", "Australia/Sydney", now)).toBe("due_soon"); // Sun Oct 4, 23:30 AEDT
    expect(urgency("2026-10-04T13:30:00Z", "Australia/Sydney", now)).toBe("due_soon"); // Mon Oct 5, 00:30 AEDT
    expect(calendarDaysFrom("2026-10-04T13:30:00Z", "Australia/Sydney", now)).toBe(2);
  });
});

describe("attentionScore (PRD weights)", () => {
  it("multiplies urgency × confidence × consequence × freshness", () => {
    expect(attentionScore(thread({ due_at: "2026-10-20T16:00:00Z", confidence: 0.8 }), NY, NOW)).toBeCloseTo(0.8);
    expect(attentionScore(thread({ due_at: "2026-10-22T20:00:00Z", confidence: 1 }), NY, NOW)).toBeCloseTo(0.9);
    expect(attentionScore(thread({ due_at: "2026-10-24T16:00:00Z", confidence: 1 }), NY, NOW)).toBeCloseTo(0.7);
    expect(attentionScore(thread({ due_at: "2026-10-30T16:00:00Z", confidence: 1 }), NY, NOW)).toBeCloseTo(0.3);
    expect(attentionScore(thread({ confidence: 1 }), NY, NOW)).toBeCloseTo(0.2);
    expect(attentionScore(thread({ due_at: "2026-10-20T16:00:00Z", confidence: 0.5, consequence: "Late fee", consequence_basis: "source" }), NY, NOW)).toBeCloseTo(0.6);
    // An interpretation-backed consequence does not raise the score.
    expect(attentionScore(thread({ due_at: "2026-10-20T16:00:00Z", confidence: 0.5, consequence: "Maybe", consequence_basis: "interpretation" }), NY, NOW)).toBeCloseTo(0.5);
    expect(attentionScore(thread({ due_at: "2026-10-20T16:00:00Z", confidence: 1 }), NY, NOW, { seenInDigest: true })).toBeCloseTo(0.5);
  });

  it("a thread with no stored confidence counts as 1.0", () => {
    expect(attentionScore(thread({ due_at: "2026-10-20T16:00:00Z", confidence: null }), NY, NOW)).toBe(1);
  });

  it("waiting scores 0.6 only past expected-by; before that it is not ranked", () => {
    expect(attentionScore(thread({ status: "waiting", expected_by: "2026-10-20T16:00:00Z", confidence: 1 }), NY, NOW)).toBeCloseTo(0.6);
    expect(attentionScore(thread({ status: "waiting", expected_by: "2026-10-22T20:00:00Z", confidence: 1 }), NY, NOW)).toBeNull();
    expect(attentionScore(thread({ status: "waiting", confidence: 1 }), NY, NOW)).toBeNull();
  });

  it("resolved, dismissed and still-snoozed threads are not ranked; a snooze that has passed ranks as open", () => {
    expect(attentionScore(thread({ status: "resolved", due_at: "2026-10-20T16:00:00Z" }), NY, NOW)).toBeNull();
    expect(attentionScore(thread({ status: "dismissed", due_at: "2026-10-20T16:00:00Z" }), NY, NOW)).toBeNull();
    expect(attentionScore(thread({ status: "snoozed", snoozed_until: "2026-10-23T13:00:00Z", due_at: "2026-10-20T16:00:00Z" }), NY, NOW)).toBeNull();
    expect(attentionScore(thread({ status: "snoozed", snoozed_until: "2026-10-22T13:00:00Z", due_at: "2026-10-20T16:00:00Z", confidence: 1 }), NY, NOW)).toBe(1);
  });
});

describe("todaySections", () => {
  it("never shows more than 5, all ≥ 0.3, highest first, deterministic ties", () => {
    const rows = [
      thread({ due_at: "2026-10-23T16:00:00Z", confidence: 0.9 }), // 0.63
      ...Array.from({ length: 6 }, (_, i) => thread({ due_at: `2026-10-1${i}T16:00:00Z`, confidence: 0.9 })), // 0.9 overdue
      thread({ due_at: "2026-10-30T16:00:00Z", confidence: 0.9 }), // 0.27 < 0.3
      thread({ confidence: 1 }), // 0.2
    ];
    const a = todaySections(rows, NY, NOW);
    const b = todaySections([...rows].reverse(), NY, NOW);
    expect(a.attention).toHaveLength(ATTENTION_MAX);
    expect(a.attention.map((t) => t.id)).toEqual(b.attention.map((t) => t.id));
    // Equal scores: the earliest due first.
    expect(a.attention.map((t) => t.due_at)).toEqual(["2026-10-10T16:00:00Z", "2026-10-11T16:00:00Z", "2026-10-12T16:00:00Z", "2026-10-13T16:00:00Z", "2026-10-14T16:00:00Z"]);
    for (const t of a.attention) expect(attentionScore(t, NY, NOW)!).toBeGreaterThanOrEqual(0.3);
  });

  it("keeps a score of exactly 0.3 (upcoming × 1.0) and drops 0.27", () => {
    const at = thread({ due_at: "2026-10-30T16:00:00Z", confidence: 1 });
    const below = thread({ due_at: "2026-10-30T16:00:00Z", confidence: 0.9 });
    const s = todaySections([at, below], NY, NOW);
    expect(s.attention.map((t) => t.id)).toEqual([at.id]);
    expect(s.comingUp.map((t) => t.id)).toEqual([below.id]);
  });

  it("an accepted Low thread is ranked like any other (D4)", () => {
    const low = thread({ due_at: "2026-10-20T16:00:00Z", confidence: 0.35 });
    expect(todaySections([low], NY, NOW).attention).toEqual([low]);
  });

  it("splits waiting, coming up and recently resolved", () => {
    const pastWaiting = thread({ status: "waiting", expected_by: "2026-10-20T16:00:00Z", due_at: "2026-10-20T16:00:00Z", confidence: 1 });
    const waitingLater = thread({ status: "waiting", expected_by: "2026-10-28T16:00:00Z", due_at: "2026-10-28T16:00:00Z" });
    const waitingUndated = thread({ status: "waiting" });
    const soon = thread({ due_at: "2026-11-01T16:00:00Z", confidence: 0.5 }); // upcoming, 0.15
    const far = thread({ due_at: "2026-12-01T16:00:00Z" });
    const undated = thread();
    const snoozed = thread({ status: "snoozed", snoozed_until: "2026-10-30T13:00:00Z", due_at: "2026-10-25T16:00:00Z" });
    const resolvedRecent = thread({ status: "resolved", resolved_at: "2026-10-20T12:00:00Z" });
    const resolvedOld = thread({ status: "resolved", resolved_at: "2026-10-14T12:00:00Z" });
    const dismissed = thread({ status: "dismissed", due_at: "2026-10-20T16:00:00Z" });
    const s = todaySections([pastWaiting, waitingLater, waitingUndated, soon, far, undated, snoozed, resolvedRecent, resolvedOld, dismissed], NY, NOW);
    expect(s.attention.map((t) => t.id)).toEqual([pastWaiting.id]);
    expect(s.waiting.map((t) => t.id)).toEqual([waitingLater.id, waitingUndated.id]);
    expect(s.comingUp.map((t) => t.id)).toEqual([soon.id]);
    expect(s.resolved.map((t) => t.id)).toEqual([resolvedRecent.id]);
  });
});
