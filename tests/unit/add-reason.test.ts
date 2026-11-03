import { describe, expect, it } from "vitest";
import { AddReasonInput } from "@/lib/decisions/addReason";
import { clampChars } from "@/lib/threads/transition";
import { historyLine } from "@/lib/threads/view";

const ID = "11111111-1111-4111-8111-111111111111";
const E = "\u{1F600}";

describe("clampChars (fields count characters like the server)", () => {
  it("keeps text at or under the limit unchanged", () => {
    expect(clampChars("abc", 3)).toBe("abc");
    expect(clampChars(E.repeat(300), 300)).toBe(E.repeat(300));
  });
  it("cuts by code points and never splits a surrogate pair", () => {
    expect(clampChars(E.repeat(301), 300)).toBe(E.repeat(300));
    expect(clampChars(`ab${E}`, 3)).toBe(`ab${E}`);
    expect(clampChars(`abc${E}`, 3)).toBe("abc");
  });
});

describe("AddReasonInput (same checks as Resolve)", () => {
  it("accepts any non-blank text up to 2,000 characters, unchanged", () => {
    const r = AddReasonInput.safeParse({ decisionId: ID, reason: "  Pool,\nclose.  " });
    expect(r.success && r.data.reason).toBe("  Pool,\nclose.  ");
    expect(AddReasonInput.safeParse({ decisionId: ID, reason: E.repeat(2000) }).success).toBe(true);
  });
  it.each([
    ["blank", "", "blank"],
    ["whitespace", " \n ", "blank"],
    ["zero-width", "​", "blank"],
    ["too long", "a".repeat(2001), "too_long"],
  ])("refuses %s", (_, reason, message) => {
    const r = AddReasonInput.safeParse({ decisionId: ID, reason });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(message);
  });
  it("refuses a malformed id", () => {
    expect(AddReasonInput.safeParse({ decisionId: "x", reason: "ok" }).success).toBe(false);
  });
});

describe("history", () => {
  it("a reason_added event has its own line", () => {
    expect(historyLine({ type: "reason_added", actor: "user", before: { reason_user: null }, after: { reason_user: "x" } })).toBe("You added a reason for your decision.");
  });
});
