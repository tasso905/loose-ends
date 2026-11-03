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

// REGRESSION GUARD (T-G1, fixed in 5ea08d6): the trailing "once" / "as soon as" exemption on a dated
// promise covers only the speaker's own step or time passing, so a condition on someone else's action
// caps (the held-out venue example with its clause moved after the promise).
describe("guard: a dated trailing condition on someone else's action still caps", () => {
  it.each([
    "I will send out the invites on Monday once the venue confirms",
    "I will send out the invites on Monday as soon as the venue confirms",
    "I'll pay the deposit on Friday once the contract is signed",
  ])("caps: %s", (q) => expect(findCondition(q, true)).not.toBeNull());
});

// REGRESSION GUARD (T-G2, fixed in 5ea08d6): an "if" in another capitalised sentence, or "provided"
// used as a verb, no longer caps a plain promise.
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

// REGRESSION GUARD (T-D5, fixed in 5ea08d6): a month that is a common first name in a possessive
// ("June's", "May's") is not a date unless a day number or a date-ish noun follows.
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

// --- fix/guard-followups (5ea08d6) verification -------------------------------------------------

describe("guard follow-ups: verified behaviour", () => {
  it.each([
    ["I'll call you back! If I don't pick up, text me.", false],
    ['I\'ll call you back. "If I don\'t pick up, text me."', false],
    ["I'll bring snacks, e.g. chips. If you're hungry, grab some.", false],
    ["I'll send the files by Tuesday, once I'm back", true],
    ["I'll send the contract Friday once we've signed", true],
    ["I'll send the slides Monday as soon as I finish the edits", true],
    ["I'll start the report on Monday once the week is over", true],
    ["I'll call you Monday at 10am, once the clocks have changed", true],
    ["I'll forward what was provided the team on Monday", true],
    ["I'll use the template they provided you on Monday", true],
  ] as const)("does not cap: %s", (q, dated) => expect(findCondition(q, dated)).toBeNull());

  it.each([
    "The venue might fall through. If it confirms, I'll send the invites Monday.",
    "Dr. Lin will call you Monday if the results are in.",
    "I'll send the docs Monday, provided the bank has approved them",
  ])("caps: %s", (q) => expect(findCondition(q, true)).not.toBeNull());
});

// OPEN DEFECT (proposed T-G3, medium; a REGRESSION from the T-G2 sentence scoping in 5ea08d6: all three
// capped at aa4b7a0): a condition written as its own fragment sentence, with no promise verb, is
// blanked out, so the promise is not capped and a model's "explicit" gives High.
describe("guard: a condition in its own fragment sentence still caps", () => {
  it.fails.each([
    "I'll send the invites Monday. Only if the venue confirms, though.",
    "If the venue confirms by Friday. I'll send the invites Monday.",
    "Assuming the budget passes. We'll order the banners on Monday.",
  ])("caps: %s", (q) => expect(findCondition(q, true)).not.toBeNull());
});

// OPEN DEFECT (proposed T-G4, medium): OWN_STEP matches any "I" / "we" subject, so a step that waits on
// someone else ("once I hear from the venue", "once we get approval from the board") is exempt.
describe("guard: an I/we step that waits on someone else still caps", () => {
  it.fails.each([
    "I'll book the room Friday once I hear from the venue",
    "We'll order the chairs Monday once we get approval from the board",
    "I'll pay you Friday once I get paid",
  ])("caps: %s", (q) => expect(findCondition(q, true)).not.toBeNull());
});

// OPEN DEFECT (proposed T-G5, low-medium): TIME_STEP matches a period word used as a possessive or a
// modifier, so someone else's action on that period's things is exempt.
describe("guard: a period word that owns someone else's action still caps", () => {
  it.fails.each([
    "I'll pay the vendors on Friday once the month's invoices are approved",
    "I'll send the plan Monday once the quarter's budget is signed off",
    "I'll book the trip Friday once the season tickets go on sale",
  ])("caps: %s", (q) => expect(findCondition(q, true)).not.toBeNull());
});

// OPEN DEFECT (proposed T-G6, low): sentence splitting needs a capital after straight punctuation, so a
// lowercase chat continuation, a curly opening quote, or a sentence ending in "a.m." keeps the unrelated
// "if" in the promise's sentence (a false cap: the plain promise is Low).
describe("guard: an unrelated 'if' in the next sentence, any casing or quote style", () => {
  it.fails.each([
    ["I'll call you back. if I don't pick up, text me.", false],
    ["I'll call you back. “If I don't pick up, text me.”", false],
    ["I'll call at 9 a.m. If you're busy, text me.", true],
  ] as const)("does not cap: %s", (q, dated) => expect(findCondition(q, dated)).toBeNull());
});

describe("possessive follow-ups: verified behaviour", () => {
  it.each(["April's", "August's"])("%s → no date", (t) => expect(due(t)).toBeNull());
  it.each([
    ["May's rent", "2027-05-01"],
    ["April's board meeting", "2027-04-01"],
  ])("%s → %s", (t, want) => expect(due(t)).toBe(want));
});

// OPEN DEFECT (proposed T-D6, low): "June's 15th" keeps only "June" and resolves to Jun 1, not Jun 15
// (a wrong day). Reached only when the model offers that phrase as date_text.
describe("possessive: a day number after the possessive month is kept", () => {
  it.fails("June's 15th → 2027-06-15", () => expect(due("June's 15th")).toBe("2027-06-15"));
});
