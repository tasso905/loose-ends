import { describe, expect, it } from "vitest";
import { findCondition } from "@/lib/pipeline/conditional";
import { resolveDate } from "@/lib/pipeline/resolveDates";

/**
 * Lead-tester verification of fix/guard-followups-3 (cd2c98f), the last round of guard rules.
 * Synthetic text only. `it` = REGRESSION GUARD. `it.fails` = OPEN BLOCKER. "known limit" = behaviour
 * we agreed to live with and document in docs/AI_BEHAVIOR.md, pinned so a change is noticed: a failing
 * limit test is good news, so move the case to a guard.
 */

const capped = (q: string) => expect(findCondition(q, true)).not.toBeNull();
const notCapped = (q: string) => expect(findCondition(q, true)).toBeNull();

describe("sentence rule: a period in doubt does not end the sentence", () => {
  it.each([
    "I'll call Acme Corp. Friday if the job is done.",
    "I'll pay on Oct. 5, if the job is done.",
    "I'll see you Mon. if Sam confirms.",
    "I'll call at 9 a.m. Friday. If the venue confirms.",
    "I'll call at 9 a.m. If the venue confirms.",
  ])("caps: %s", capped);

  it.each([
    "I'll call you back. Text me if I don't pick up.",
    "I'll send it Friday. Text me if it's late.",
    "I'll call Sam Friday. Text me if I don't pick up.",
    "I'll drop it off Friday at the U.S. Post Office. Text me if it's urgent.",
  ])("stays out: %s", notCapped);
});

describe("courtesy mask", () => {
  it.each([
    "If you have the contract signed by Thursday, I'll send it Friday.",
    "If you have the funds, I'll book it Friday.",
    "I'll book it Friday if you have the deposit.",
    "I'll book it Friday if that's fine with the board.",
    "I'll book it Friday if it's okay with the landlord.",
  ])("a real condition caps: %s", capped);

  it.each(["If you have a sec, I'll walk you through it Friday.", "If you have time, I'll walk you through it Friday.", "I'll call you Friday if you have any concerns."])(
    "a courtesy does not cap: %s",
    notCapped,
  );

  // REGRESSION GUARD (T-G17, fixed in fix/guard-followups-4; REGRESSION from the "if you have" narrowing in cd2c98f; 5ea08d6 got all of these
  // right). D64(c) names opt-outs as exempt, and "a moment" is on GET_OWN_TIME but not on this list.
  for (const q of [
    "If you have no objections, I'll send it Friday.",
    "I'll send it Friday if you have no objections.",
    "If you have a moment, I'll walk you through it Friday.",
    "If you have an issue, I'll fix it by Friday.",
  ]) {
    it(`opt-out or courtesy after "if you have" is not a condition: ${q}`, () => notCapped(q));
  }
});

describe("courtesy mask after T-G17", () => {
  // OPEN DEFECT (T-G19; REGRESSION from 0e65c60; c7c1f2c capped these): "no" now counts as a determiner before
  // every courtesy noun, so a real condition is masked and the conditional promise stays High.
  for (const q of ["If you have no time, I'll cover it Friday.", "If you have no trouble with the lift, I'll bring it Friday."]) {
    it.fails(`"no" before a noun that is not an opt-out is a condition: ${q}`, () => capped(q));
  }
});

describe("waiting on someone", () => {
  it.each(["I'll send it Friday, once I have approval.", "I'll send it Friday, once we have the go-ahead.", "I'll send it Friday, once I've got final approval."])("caps: %s", capped);

  // REGRESSION GUARD (T-G18, fixed in fix/guard-followups-4; a common wording, not a regression): the RECEIVED check reads only the first word
  // after determiners, so a word in front of "approval" reads as the speaker's own step and stays High.
  for (const q of ["I'll send it Friday, once I have final approval.", "I'll send it Friday, once we have board approval."]) {
    it(`an adjective before what is received still caps: ${q}`, () => capped(q));
  }
});

describe("joined clause", () => {
  it.each(["I'll send it Friday, once I've cleaned up and Sam signs off.", "I'll send it Friday, once I've cleaned up and the client approves."])("caps: %s", capped);
  it.each([
    "I'll send it Friday, once I've finished the deck and the slides.",
    "I'll send it Friday, once I've called Sam and Mike.",
    "I'll send it Friday, once I've cleaned up and packed.",
    "I'll send it Friday, once I've sorted the deck and the budget.",
  ])("own work stays exempt: %s", notCapped);
});

describe("known limits for docs/AI_BEHAVIOR.md", () => {
  it.each([
    // Claimed by the developer; confirmed.
    "If you need the deck, I'll send it Monday.",
    "I'll send it Monday. That's if the venue confirms.",
    "I'll send it Monday. If the venue confirms, Friday works.",
    "I'll send it Friday, once I have the numbers.",
    "I'll send it Friday, once I see the contract.",
    "I'll send it Friday, once the week ends and sam signs off",
    // Added by the tester.
    "If you like the design, we'll order it Friday.",
    "I'll send it Friday, once I've cleaned up and they approve.",
    "I'll send it Friday, once I've cleaned up, and the client approves.",
    "I'll call at 9 am. Friday if the venue confirms.",
    "I'll send it Monday. If they let me go early.",
    // T-G18's participle check (0e65c60): a participle straight after "have" reads as the speaker's own work.
    "I'll send it Friday, once I have signed approval.",
    "I'll send it Friday, once I have written approval.",
    "I'll send it Friday, once I have written confirmation.",
  ])("under-cap, stays High on a dated promise: %s", notCapped);

  it.each([
    // Claimed by the developer; confirmed.
    "i'll call you friday. text me if i don't pick up",
    "I'll send it Friday, once I get a few minutes.",
    "I'll call Sam. Text me if I don't pick up.",
    "I'll call you back. If I can't, I'll send a text.",
    // Added by the tester. Each of these got High at 5ea08d6.
    "I'll call you Friday. If I'm late save me a seat.",
    "I'll call you Friday. If it rains we stay in.",
    "I'll send it Friday, once I've finished the deck and the client notes.",
    "I'll send it Friday, once I've cleaned up and the kids are in bed.",
    // T-G18 (0e65c60): any received word in a "have" step caps, unless the verb is on PARTICIPLE.
    "I'll send it Friday, once I have a draft response.",
    "I'll send it Friday, once I have a word with Sam.",
    "I'll send it Friday, once I've spent the money.",
    "I'll send it Friday, once I've come up with an answer.",
  ])("over-cap, Low on a firm dated promise: %s", capped);
});

describe("possessive months after the noun removals", () => {
  const ctx = { referenceDate: "2026-10-20", referenceDateSource: "user" as const, timezone: "America/New_York" };
  const r = (t: string, iso: string | null = null) => resolveDate({ date_text: t, date_iso: iso }, ctx);

  it.each(["June's meeting", "June's bill", "May's invoice", "April's payment", "August's calendar", "June's budget", "May's shipment", "June's end", "June's start", "June's party"])(
    "%s: no date, and a line saying so, rather than an invented 1st of the month",
    (t) => {
      const d = r(t);
      expect(d.due_date).toBeNull();
      expect(d.not_sure.join(" ")).toContain("couldn't work out a date");
    },
  );

  it.each([
    ["May's order", "2027-05-15"],
    ["May's 3 kids", "2027-05-03"],
  ])("%s: a model date does not bring the date back (rule 3)", (t, iso) => {
    expect(r(t, iso).due_date).toBeNull();
    expect(r(t, iso).agreement).toBe("model_only");
  });

  it.each([
    ["June's 15th", "2027-06-15"],
    ["June's 15 at noon", "2027-06-15"],
    ["May's rent", "2027-05-01"],
    ["June's deadline", "2027-06-01"],
    ["April's board meeting", "2027-04-01"],
    ["the end of June", "2027-06-30"],
    ["by the end of May", "2027-05-31"],
    ["June 15", "2027-06-15"],
  ])("still dated: %s → %s", (t, day) => expect(r(t).due_date).toBe(day));

  it.each([
    ["June's 15th birthday", "2027-06-15"], // reads as a day; flagged inferred
    ["December's end", "2026-12-01"], // T-D9 covers name months only; flagged inferred
    ["March's meeting", "2027-03-01"], // non-name months keep the old reading; flagged inferred
  ])("known limit: %s → %s, flagged inferred", (t, day) => {
    const d = r(t);
    expect(d.due_date).toBe(day);
    expect(d.due_certainty).toBe("inferred");
  });
});
