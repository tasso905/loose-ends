import { describe, expect, it } from "vitest";
import {
  availableActions,
  EditInput,
  editFieldsToState,
  endOfLocalDay,
  MarkWaitingInput,
  snoozeDate,
  snoozeMenuDates,
  snoozeUntil,
  SnoozeInput,
} from "@/lib/threads/actions";

/** S12 (F9) pure rules: snooze presets (D11), date-only instants, input validation, which actions show. */

const NY = "America/New_York";
const ID = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
// Wed Nov 11 2026, 10:30 in New York.
const WED = new Date("2026-11-11T15:30:00Z");

describe("snooze presets (D11: Tomorrow 9:00, Next Monday 9:00, Pick a date, in the user's timezone)", () => {
  it("Tomorrow and Next Monday resolve in the user's timezone at 9:00", () => {
    expect(snoozeDate({ preset: "tomorrow" }, WED, NY)).toBe("2026-11-12");
    expect(snoozeDate({ preset: "next_monday" }, WED, NY)).toBe("2026-11-16");
    expect(snoozeUntil({ preset: "tomorrow" }, WED, NY)).toBe("2026-11-12T14:00:00.000Z");
    expect(snoozeUntil({ preset: "next_monday" }, WED, NY)).toBe("2026-11-16T14:00:00.000Z");
  });

  it("Next Monday is a week ahead on a Monday and tomorrow on a Sunday", () => {
    expect(snoozeDate({ preset: "next_monday" }, new Date("2026-11-16T15:00:00Z"), NY)).toBe("2026-11-23");
    expect(snoozeDate({ preset: "next_monday" }, new Date("2026-11-15T15:00:00Z"), NY)).toBe("2026-11-16");
  });

  it("uses the user's local date, not UTC's (late evening in New York is already tomorrow in UTC)", () => {
    const lateWed = new Date("2026-11-12T03:30:00Z"); // Wed 22:30 in New York
    expect(snoozeDate({ preset: "tomorrow" }, lateWed, NY)).toBe("2026-11-12");
  });

  it("a picked date wakes at 9:00 that day; a date whose 9:00 has passed is refused", () => {
    expect(snoozeUntil({ preset: "date", date: "2026-12-01" }, WED, NY)).toBe("2026-12-01T14:00:00.000Z");
    expect(snoozeUntil({ preset: "date", date: "2026-11-11" }, WED, NY)).toBeNull();
    expect(snoozeUntil({ preset: "date", date: "2026-02-30" }, WED, NY)).toBeNull();
  });

  it("the menu shows each preset's date and allows picking from tomorrow", () => {
    expect(snoozeMenuDates(WED, NY)).toEqual({ tomorrow: "Thu Nov 12", nextMonday: "Mon Nov 16", minDate: "2026-11-12" });
  });
});

describe("date-only fields", () => {
  it("expected-by and date-only due dates are stored at 23:59 local", () => {
    expect(endOfLocalDay("2026-11-20", NY)).toBe("2026-11-21T04:59:00.000Z");
  });

  it("Edit turns a local date and time into the due instant and marks the time known", () => {
    const f = EditInput.parse({ threadId: ID, fromStatus: "open", fields: { due: { date: "2026-11-20", time: "14:30" } } }).fields;
    expect(editFieldsToState(f, NY, WED)).toEqual({ ok: true, fields: { due_at: "2026-11-20T19:30:00.000Z", due_time_known: true } });
    const g = EditInput.parse({ threadId: ID, fromStatus: "open", fields: { due: { date: "2026-11-20", time: null } } }).fields;
    expect(editFieldsToState(g, NY, WED)).toEqual({ ok: true, fields: { due_at: "2026-11-21T04:59:00.000Z", due_time_known: false } });
  });

  it("Edit maps blank optional text to null and keeps text exactly as typed otherwise", () => {
    const f = EditInput.parse({ threadId: ID, fromStatus: "open", fields: { next_action: "  ", counterparty: " Ana  " } }).fields;
    expect(editFieldsToState(f, NY, WED)).toEqual({ ok: true, fields: { next_action: null, counterparty: " Ana  " } });
  });

  it("Edit refuses a snooze date that is not after now", () => {
    const f = EditInput.parse({ threadId: ID, fromStatus: "snoozed", fields: { snoozed_until: "2026-11-11" } }).fields;
    expect(editFieldsToState(f, NY, WED)).toEqual({ ok: false, field: "snoozed_until" });
  });
});

describe("input validation (Zod)", () => {
  it("Mark waiting needs a name; expected-by is optional but must be a real date", () => {
    expect(MarkWaitingInput.safeParse({ threadId: ID, fromStatus: "open", waitingOn: "Mike", expectedBy: null }).success).toBe(true);
    expect(MarkWaitingInput.safeParse({ threadId: ID, fromStatus: "open", waitingOn: " ", expectedBy: null }).success).toBe(false);
    expect(MarkWaitingInput.safeParse({ threadId: ID, fromStatus: "open", waitingOn: "x".repeat(101), expectedBy: null }).success).toBe(false);
    expect(MarkWaitingInput.safeParse({ threadId: ID, fromStatus: "open", waitingOn: "Mike", expectedBy: "2026-13-01" }).success).toBe(false);
  });

  it("Snooze accepts only the three choices", () => {
    expect(SnoozeInput.safeParse({ threadId: ID, fromStatus: "open", choice: { preset: "tomorrow" } }).success).toBe(true);
    expect(SnoozeInput.safeParse({ threadId: ID, fromStatus: "open", choice: { preset: "date", date: "2026-11-20" } }).success).toBe(true);
    expect(SnoozeInput.safeParse({ threadId: ID, fromStatus: "open", choice: { preset: "next_year" } }).success).toBe(false);
    expect(SnoozeInput.safeParse({ threadId: ID, fromStatus: "open", choice: { preset: "date", date: "soon" } }).success).toBe(false);
  });

  it("Edit refuses unknown fields, a blank or over-long title and a bad kind", () => {
    const parse = (fields: unknown) => EditInput.safeParse({ threadId: ID, fromStatus: "open", fields }).success;
    expect(parse({ title: "Renamed" })).toBe(true);
    expect(parse({ status: "resolved" })).toBe(false);
    expect(parse({ title: "" })).toBe(false);
    expect(parse({ title: "x".repeat(121) })).toBe(false);
    expect(parse({ kind: "project" })).toBe(false);
    expect(parse({ due: { date: "2026-11-20", time: "25:00" } })).toBe(false);
  });
});

describe("availableActions (PRD lifecycle table; D6)", () => {
  it("offers exactly the allowed actions per status", () => {
    expect(availableActions({ status: "open", kind: "commitment" })).toEqual({
      done: true, resolve: true, markWaiting: true, backToMe: false, wake: false, snooze: true, edit: true, dismiss: true, reopen: false,
    });
    expect(availableActions({ status: "waiting", kind: "commitment" })).toMatchObject({ markWaiting: false, snooze: false, backToMe: true, dismiss: true });
    expect(availableActions({ status: "snoozed", kind: "commitment" })).toMatchObject({ snooze: false, wake: true, done: true });
    expect(availableActions({ status: "resolved", kind: "commitment" })).toMatchObject({ done: false, dismiss: false, reopen: true, edit: true });
    expect(availableActions({ status: "dismissed", kind: "commitment" })).toMatchObject({ reopen: true });
    expect(availableActions({ status: "open", kind: "decision" })).toMatchObject({ done: false, resolve: true });
  });
});
