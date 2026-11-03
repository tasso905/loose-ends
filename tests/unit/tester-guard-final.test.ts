import { describe, expect, it } from "vitest";
import { findCondition } from "@/lib/pipeline/conditional";
import { unbackedDateFree } from "@/lib/pipeline/proposals";
import { resolveDate } from "@/lib/pipeline/resolveDates";

/**
 * Lead-tester final verification of fix/eval-gate (f5604a8): the D64(c) conditional guard beyond the
 * developer's cases, the possessive-date fallback, and rule 3 after the T-T1 narrowing.
 * Synthetic text only. `it` = REGRESSION GUARD (verified behaviour). `it.fails` = OPEN DEFECT: it
 * asserts the required (safe) behaviour and currently fails; when fixed, change it to `it`.
 */

describe("conditional guard: verified behaviour", () => {
  it.each([
    "I'll send the deck Friday, if that's okay with you",
    "If you want, I'll pick you up at 7",
    "I'll call the plumber tomorrow, if not today",
    "I'll send you the What If deck tomorrow",
    "I'll send it over as soon as possible",
    "I'll review it once more before Friday",
    "I will pay you back Friday, even if it's late",
    "I'll check if the room is free",
    "I'll bring the chairs, if needed",
    "I'll email the draft Monday - happy to adjust if you'd prefer another format",
  ])("does not cap: %s", (q) => expect(findCondition(q, true)).toBeNull());

  it.each([
    ["If I can, I'll come by Saturday", true],
    ["I'll grab milk if I pass the store", false],
    ["Assuming you're free, I'll book Friday", true],
    ["Provided the weather holds, we'll paint the fence on Saturday", true],
    ["Once the permit arrives, I'll call you Monday", true],
    ["I'll send the invoice once the job is done", false],
    ["IF the board approves, I WILL order the chairs", false],
    ["I will send out the invites on Monday if the venue confirms", true],
  ] as const)("caps: %s", (q, dated) => expect(findCondition(q, dated)).not.toBeNull());
});

// OPEN DEFECT (proposed T-G1): the approved exemption for a trailing "once" / "as soon as" step on a
// dated promise also exempts conditions on OTHER people's actions. The held-out venue example with
// its clause moved after the promise is not capped, so a model's "explicit" makes it High
// (a speculative→High gate violation). The exemption was meant for the user's own steps ("once I've
// cleaned them up").
describe("guard: a dated trailing condition on someone else's action still caps", () => {
  it.each([
    "I will send out the invites on Monday once the venue confirms",
    "I will send out the invites on Monday as soon as the venue confirms",
    "I'll pay the deposit on Friday once the contract is signed",
  ])("caps: %s", (q) => expect(findCondition(q, true)).not.toBeNull());
});

// OPEN DEFECT (proposed T-G2, low): false caps. An "if" in a second sentence of a multi-sentence
// quote caps the first sentence's plain promise; "provided" used as a verb reads as "provided that".
// A capped plain promise is Low, so it never surfaces in Today unasked (rule 4).
describe("guard: no cap from an unrelated sentence or a verb 'provided'", () => {
  it.each([
    "I'll call you back. If I don't pick up, text me.",
    "I'll resend the slides I provided the board last week on Monday",
  ])("does not cap: %s", (q) => expect(findCondition(q, true)).toBeNull());
});

const ctx = { referenceDate: "2026-10-22", referenceDateSource: "user" as const, timezone: "America/Chicago" };
const due = (t: string) => resolveDate({ date_text: t, date_iso: null }, ctx).due_date;

describe("possessive dates: verified behaviour", () => {
  it.each([
    ["Saturday's", "2026-10-24"],
    ["last Friday's", "2026-10-16"],
    ["tomorrow's 10am call", "2026-10-23"],
    ["tonight's game at 7", "2026-10-22"],
  ])("%s → %s", (t, want) => expect(due(t)).toBe(want));

  it.each(["Mike's", "Oct's"])("%s → no date", (t) => expect(due(t)).toBeNull());
});

// OPEN DEFECT (proposed T-D5, low): a month that is a person's name in a possessive ("June's", "May's")
// becomes a due date (Jun 1 / May 1, 2027, inferred). Rule 3: never fill a date that is not there.
// Reached only when the model offers the possessive name as date_text.
describe("possessive dates: a name that is a month is not a date", () => {
  it.each(["June's", "May's"])("%s → no date", (t) => expect(due(t)).toBeNull());
});

describe("rule 3 after the T-T1 narrowing: an unbacked date in a title is still stripped", () => {
  it.each([
    ["Get forms from Priya by Thursday", null, "Get forms from Priya"],
    ["Call clinic Thursday at 10:30", null, "Call clinic"],
  ] as const)("'%s' (date_text %s) → '%s'", (title, dateText, want) => {
    expect(unbackedDateFree(title, dateText, () => "FALLBACK")).toBe(want);
  });
});
