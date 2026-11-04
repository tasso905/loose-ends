import { describe, expect, it } from "vitest";
import type { Certainty, ItemType } from "@/lib/ai/schema";
import { findCondition } from "@/lib/pipeline/conditional";
import type { DateAgreement } from "@/lib/pipeline/resolveDates";
import { scoreItem } from "@/lib/pipeline/score";

/**
 * Conditional guard (user decision Nov 2, "3 yes"; a D36 change): a promise whose own verified quote
 * attaches a condition is capped at speculative certainty, so it never bands above Low. Synthetic text.
 */

const score = (quote: string, o: { type?: ItemType; certainty?: Certainty; date?: DateAgreement } = {}) =>
  scoreItem({
    type: o.type ?? "commitment",
    owner: "user",
    certainty: o.certainty ?? "explicit",
    matchKinds: ["exact"],
    quotes: [quote],
    dateAgreement: o.date ?? "agree",
  });

describe("findCondition(): triggers", () => {
  it.each([
    ["if the venue confirms by Friday, I'll send out the invites on Monday", "if", "leading"],
    ["If the client signs off, we'll start the build next week", "if", "leading"],
    ["I'll send the invites on Monday if the venue confirms", "if", "trailing"],
    ["Assuming the permit comes through, I'll order the lumber Thursday", "assuming", "leading"],
    ["I'll book the flights, assuming the dates still work", "assuming", "trailing"],
    ["Provided that the budget passes, I'll hire two helpers", "provided", "leading"],
    ["Provided the weather holds, we'll paint the fence Saturday", "provided", "leading"],
    ["I'll cover your shift providing the manager agrees", "provided", "trailing"],
    ["Once the parts arrive, I'll call you to schedule the repair", "once", "leading"],
    ["As soon as the check clears, I'll transfer your share", "once", "leading"],
    ["I'll pay you back once the refund comes through", "once", "trailing"],
    ["I'll ship it as soon as the stock arrives", "once", "trailing"],
    ["IF THE HALL IS FREE I'LL BOOK IT FRIDAY", "if", "leading"],
    ["if it doesn’t rain, I’ll mow the lawn Sunday", "if", "leading"],
  ])("'%s' → %s, %s", (quote, kind, position) => {
    expect(findCondition(quote, false)).toEqual({ kind, position });
  });

  it("a leading 'once' caps a dated promise too; any 'if' caps a dated promise", () => {
    expect(findCondition("Once the lumber is in on Friday, I'll call you Monday", true)).toEqual({ kind: "once", position: "leading" });
    expect(findCondition("I'll send the invites on Monday if the venue confirms", true)).toEqual({ kind: "if", position: "trailing" });
  });
});

describe("findCondition(): not conditions", () => {
  it.each([
    // Opt-out defaults (golden 34 g4 is implied / Medium).
    "Unless I hear otherwise, I'll have the crew come again on Friday, November 13.",
    "If I don't hear back by Thursday, I'll book the room.",
    "If we haven't heard from you, we'll renew the plan automatically.",
    "If nobody objects, I'll send the minutes tonight.",
    "If you don't object, I'll move the meeting to 3pm.",
    "If there are no objections, we'll go with the blue logo.",
    // Courtesies.
    "If you have questions, call me.",
    "I'll send the deck Friday; if you have any questions, ping me.",
    "I'll bring extra chairs if needed.",
    "I'll call you tomorrow if possible.",
    "Let me know if that's a problem, I'll send it Monday.",
    "I'll send the forms Friday, if that works.",
    "If you'd like, I'll drive you to the airport Sunday.",
    // Embedded questions.
    "I'll check if the room is free on Tuesday.",
    "I'll ask if they can deliver earlier.",
    "I'll find out if the store has it in stock.",
    "I'll see if Priya can cover it.",
    // Idioms.
    "I'll send it as soon as possible.",
    "I'll water the plants once a week while you're away.",
    "Thanks once again, I'll send the photos tomorrow.",
    "I'll start at once.",
    "I'll finish it even if it takes all night.",
    "I'll send the report on Monday.",
  ])("'%s' → no condition", (quote) => {
    expect(findCondition(quote, false)).toBeNull();
  });

  it.each([
    "I'll send the final logo files by Tuesday, once I've cleaned up the small-size version.",
    "I'll email everyone the final running order on Monday at 10am, once the clocks have changed.",
    "I'll ship it Friday as soon as we're back from the trade show.",
    "We'll paint the fence on Saturday once we've bought the primer.",
    "I'll send the recap Monday, as soon as the holidays are over.",
  ])("a trailing 'once' step on a dated promise is not a condition: '%s'", (quote) => {
    expect(findCondition(quote, true)).toBeNull();
    // Without its own date the same clause is a condition.
    expect(findCondition(quote, false)).not.toBeNull();
  });
});

describe("findCondition(): a dated trailing step on someone else's action caps (T-G1)", () => {
  it.each([
    "I'll ship it Friday as soon as the labels print.",
    "I will send out the invites on Monday once the venue confirms",
    "I'll pay the deposit on Friday once the contract is signed",
    "I'll book the van for Saturday as soon as Priya sends the address",
    "I'll send the deck Thursday once it's approved",
    "We'll start the build on Monday once they sign off",
  ])("caps: %s", (quote) => {
    expect(findCondition(quote, true)).toEqual({ kind: "once", position: "trailing" });
  });
});

describe("findCondition(): a condition belongs to the promise's own sentence (T-G2)", () => {
  it.each([
    "I'll call you back. If I don't pick up, text me.",
    "I'll send the forms Friday. Once you have them, sign page 2.",
    "I'll call Dr. Lee on Monday. Assuming nothing changes, see you at 3.",
  ])("does not cap: %s", (quote) => expect(findCondition(quote, true)).toBeNull());

  it.each([
    "Thanks for the note. If the venue confirms, I'll send the invites Monday.",
    "I'll call Dr. Lee on Monday if the clinic reopens.",
    "I'll call you back. If I can't, I'll send a text.",
  ])("still caps: %s", (quote) => expect(findCondition(quote, true)).not.toBeNull());
});

describe("findCondition(): 'provided' as a verb is not a condition (T-G2)", () => {
  it.each([
    "I'll resend the slides I provided the board last week on Monday",
    "I'll update the numbers we provided the auditors by Friday",
    "I'll forward the forms that were provided to us on Tuesday",
  ])("does not cap: %s", (quote) => expect(findCondition(quote, true)).toBeNull());

  it.each([
    "Provided the weather holds, we'll paint the fence on Saturday",
    "We'll paint the fence on Saturday provided the weather holds",
    "I'll sign on Friday, provided that the numbers match",
  ])("caps: %s", (quote) => expect(findCondition(quote, true)?.kind).toBe("provided"));
});

describe("scoreItem(): the cap", () => {
  it("an explicit, dated conditional commitment the model called High is Low, with the 'conditional' reason", () => {
    const r = score("if the venue confirms by Friday, I'll send out the invites on Monday");
    expect(r.band).toBe("low");
    expect(r.signals).toContain("conditional");
    expect(r.score).toBeLessThan(0.5);
  });

  it.each(["commitment", "waiting_on", "intention"] as const)("applies to %s", (type) => {
    const r = score("Once the lumber is in, I'll call you to pick a stain color.", { type, date: "none" });
    expect(r.band === "low" || r.band === "ignore").toBe(true);
    expect(r.signals).toContain("conditional");
  });

  it("implied certainty is capped too", () => {
    expect(score("Assuming the board approves, we'll repaint in March", { certainty: "implied" }).band).toBe("low");
  });

  it.each(["request", "deadline", "decision", "key_fact"] as const)("does not apply to %s (not a promise)", (type) => {
    const r = score("If you would like a retake, please return the form by Oct 30.", { type });
    expect(r.signals).not.toContain("conditional");
    expect(r.band).toBe("high");
  });

  // Tester's must-not-cap cases (Nov 2): non-promise types whose quotes carry trigger words. The
  // guard is restricted to commitment, waiting_on and intention, so these keep their band.
  // h02 quotes are written from the coordinator's excerpts, not from the holdout goldens.
  it.each([
    ["13 g1", "request", "Can you restart the backup job Sunday at 2:30am once the upgrade finishes?"],
    ["15 g1", "decision", "If you would like Leo to have his photo retaken, please return the order form by Oct 30."],
    ["22 g0", "deadline", "If you wish to renew, please sign and return the enclosed renewal agreement no later than December 1, 2026."],
    ["39 g1", "decision", "If you want to keep your FSA, you must re-enroll by Friday, November 13."],
    ["h02 g0", "request", "if you get a chance could you send me the slides by Thursday?"],
    ["h02 g1", "request", "It would be lovely if you could bring the folding table on Saturday."],
  ] as const)("%s (%s) is never capped", (_id, type, quote) => {
    const r = score(quote, { type });
    expect(r.signals).not.toContain("conditional");
    expect(r.band).toBe("high");
  });

  it("a request with a trailing step stays High (golden 13 g1)", () => {
    const r = score("Can you restart the backup job Sunday at 2:30am once the upgrade finishes?", { type: "request" });
    expect(r.band).toBe("high");
  });

  it("dated promises with a trailing step stay High (goldens 10 g0, 12 g1)", () => {
    expect(score("I'll send the final logo files by Tuesday, once I've cleaned up the small-size version.").band).toBe("high");
    expect(score("I'll email everyone the final running order on Monday at 10am, once the clocks have changed", { type: "waiting_on" }).band).toBe("high");
  });

  it("an opt-out default keeps its model certainty (golden 34 g4, implied → Medium)", () => {
    const r = score("Unless I hear otherwise, I'll have the crew come again on Friday, November 13.", { type: "waiting_on", certainty: "implied" });
    expect(r.signals).not.toContain("conditional");
    expect(r.band).toBe("medium");
  });

  it("a courtesy does not cap a plain promise", () => {
    expect(score("I'll send the deck Friday; if you have any questions, ping me.").band).toBe("high");
  });

  it("a speculative conditional the model already marked keeps its score (nothing to cap)", () => {
    const capped = score("If the plumber confirms the part is in stock, I'll have the sink fixed by Wednesday", { certainty: "speculative" });
    expect(capped.band).toBe("low");
    expect(capped.score).toBe(0.45);
  });

  it("any evidence quote can carry the condition", () => {
    const r = scoreItem({
      type: "commitment", owner: "user", certainty: "explicit", matchKinds: ["exact"], dateAgreement: "agree",
      quotes: ["I'll send out the invites on Monday", "but only if the venue confirms by Friday"],
    });
    expect(r.band).toBe("low");
  });
});

describe("findCondition(): a condition fragment sentence attaches to the promise (T-G3)", () => {
  it.each([
    ["I'll send the invites Monday. Only if the venue confirms, though.", "trailing"],
    ["If the venue confirms by Friday. I'll send the invites Monday.", "leading"],
    ["Assuming the budget passes. We'll order the banners on Monday.", "leading"],
    ["We'll paint Saturday. Provided the weather holds.", "trailing"],
    ["I'll ship it Friday. Once the labels print.", "trailing"],
  ] as const)("caps: %s (%s)", (quote, position) => {
    expect(findCondition(quote, true)?.position).toBe(position);
  });

  it.each([
    "I'll call you back. If I don't pick up, text me.",
    "I'll send it Monday. Once I'm back, though.",
    "I'll book Friday. If you have questions, ask Sam.",
  ])("does not cap: %s", (quote) => expect(findCondition(quote, true)).toBeNull());
});

describe("findCondition(): an I/we step that waits on someone else caps (T-G4)", () => {
  it.each([
    "I'll book the room Friday once I hear from the venue",
    "We'll order the chairs Monday once we get approval from the board",
    "I'll pay you Friday once I get paid",
    "I'll start Monday as soon as I'm told the budget is final",
    "I'll ship it Friday once we've received the parts",
    "I'll send the deck Thursday once I get the go-ahead",
    "We'll start Monday once we're approved",
  ])("caps: %s", (quote) => expect(findCondition(quote, true)).toEqual({ kind: "once", position: "trailing" }));

  it.each([
    "I'll send the files by Tuesday, once I've cleaned them up",
    "I'll call you Friday as soon as I get back",
    "I'll send the slides Monday once I've finished the edits",
    "We'll send the contract Friday once we've signed it",
    "I'll send the forms Friday once I'm home",
  ])("does not cap: %s", (quote) => expect(findCondition(quote, true)).toBeNull());
});

describe("findCondition(): only the period itself passing is a time step (T-G5)", () => {
  it.each([
    "I'll pay the vendors on Friday once the month's invoices are approved",
    "I'll send the plan Monday once the quarter's budget is signed off",
    "I'll book the trip Friday once the season tickets go on sale",
    "I'll file it Monday once the week's numbers come in",
  ])("caps: %s", (quote) => expect(findCondition(quote, true)).not.toBeNull());

  it.each([
    "I'll call you Monday at 10am, once the clocks have changed",
    "I'll start the report on Monday once the week is over",
    "I'll send the recap Monday, as soon as the holidays are over",
    "I'll call Monday once the clocks go back",
    "I'll book it Friday once the term starts",
  ])("does not cap: %s", (quote) => expect(findCondition(quote, true)).toBeNull());
});

describe("findCondition(): sentence splitting (T-G6)", () => {
  it.each([
    ["I'll call you back. if I don't pick up, text me.", false],
    ["I'll call you back. \u201cIf I don't pick up, text me.\u201d", false],
    ["I'll call at 9 a.m. If you're busy, text me.", true],
  ] as const)("does not cap: %s", (quote, dated) => expect(findCondition(quote, dated)).toBeNull());

  it.each([
    "I'll call at 9 a.m. tomorrow if the clinic is open.",
    "I'll bring snacks, e.g. chips, if the store is open.",
  ])("a.m. or e.g. before lowercase does not split: %s", (quote) => expect(findCondition(quote, true)).not.toBeNull());
});

describe("findCondition(): sentence ends, in doubt the condition stays attached (T-G13, T-G14, T-G15)", () => {
  it.each([
    "I'll call at 9 a.m. Friday if the venue confirms.",
    "I'll call at 5 p.m. June 3 if the venue confirms.",
    "I'll see you Fri. at 9 if Sam confirms.",
    "I'll see you Fri. if Sam confirms.",
    "I'll ship to Acme Inc. on Friday if the deposit clears.",
    "I'll ship to Acme Inc. if the deposit clears.",
    "I'll call the U.S. office Friday if the deal closes.",
    "I'll pay approx. 40 on Friday if the job is done.",
    "I'll call Prof. Lin Friday if she's in.",
    "I'll send it Monday; if the venue confirms.",
    "I'll send it Monday\nif the venue confirms",
    "If the venue\nconfirms, I'll send it Monday",
  ])("caps: %s", (q) => expect(findCondition(q, true)).not.toBeNull());

  it.each([
    "I'll call you back at 9 a.m. If I don't pick up, text me.",
    "I'll call Sam. If I don't pick up, text me.",
    "I'll call you back. Text me if I don't pick up.",
    "i'll call you back. if i don't pick up, text me.",
    "I'll call you Friday; if I don't pick up, text me.",
    "I'll call you Friday\r\nIf I don't pick up, text me",
  ])("does not cap: %s", (q) => expect(findCondition(q, true)).toBeNull());
});

describe("findCondition(): a condition sentence with no comma (T-G7)", () => {
  it.each([
    "I'll call you back. If I don't pick up text me.",
    "I'll call you Friday. If it's urgent call Priya instead.",
    "I'll call you Friday. If the venue confirms call me.",
    "I'll call you Friday. If I'm late - start without me.",
  ])("its own instruction stays out: %s", (q) => expect(findCondition(q, true)).toBeNull());

  it.each([
    "I'll send it Monday. If they call.",
    "I'll send it Monday. If they can call.",
    "I'll send it Monday. If I don't call.",
    "I'll send it Monday. If the venue people leave.",
    "I'll send it Monday. Only if the venue confirms.",
  ])("a condition with a verb from the list is still a fragment: %s", (q) => expect(findCondition(q, true)).not.toBeNull());
});

describe("findCondition(): 'get' and 'have' in the speaker's step (T-G9, T-G10)", () => {
  it.each([
    "I'll send them Tuesday, once I get a chance.",
    "I'll send them Tuesday, once I get a moment.",
    "I'll send them Tuesday, once I get some time.",
    "I'll send them Tuesday, once I get round to it.",
    "I'll send them Tuesday, once I get around to it.",
    "I'll send them Tuesday, once I get everything sorted.",
    "I'll send them Tuesday, once I get the kids to bed.",
    "I'll send them Tuesday, once I get the slides finished.",
    "I'll send them Tuesday, once I have a minute.",
    "I'll send them Tuesday, once I've had a chance.",
  ])("exempt: %s", (q) => expect(findCondition(q, true)).toBeNull());

  it.each([
    "I'll send them Tuesday, once I get paid.",
    "I'll send them Tuesday, once I get approval.",
    "I'll send them Tuesday, once I get the go-ahead.",
    "I'll send them Tuesday, once I get it from Sam.",
    "I'll send them Tuesday, once I get word.",
    "I'll send them Tuesday, once I have approval.",
    "I'll send them Tuesday, once I've got the OK.",
    "I'll send them Tuesday, once I have the green light.",
    "I'll send them Tuesday, once I know.",
    "I'll send them Tuesday, once I've found out.",
    "I'll send them Tuesday, once I've cleaned up and Sam signs off.",
  ])("caps: %s", (q) => expect(findCondition(q, true)).not.toBeNull());

  it("an own step with its own second noun is not a joined clause", () => {
    expect(findCondition("I'll send them Tuesday, once I've cleaned up the deck and the slides.", true)).toBeNull();
    expect(findCondition("I'll send them Tuesday, once I've cleaned up and I'm back.", true)).toBeNull();
  });
});

describe("findCondition(): time steps (T-G11, T-G12)", () => {
  it.each(["once the week's over", "once the weekend's over", "once the holidays're over", "as soon as the term's over", "once the week is over, and the term starts"])(
    "exempt: %s",
    (step) => expect(findCondition(`I'll send it Monday, ${step}.`, true)).toBeNull(),
  );

  it.each(["once the month's invoices are in", "once the month is over and the invoices are approved", "once the week ends and Sam signs off"])(
    "caps: %s",
    (step) => expect(findCondition(`I'll send it Monday ${step}.`, true)).not.toBeNull(),
  );
});

describe("findCondition(): more wordings that set no condition (T-G16)", () => {
  it.each([
    "If I don't get a response, I'll book Friday.",
    "Assuming no one objects, I'll send the minutes on Friday.",
    "I'll let you know by Friday if I can make it.",
    "I'll decide by Friday if we renew.",
    "I'll fix it once and for all on Friday.",
    "We'll start as soon as Monday.",
  ])("does not cap: %s", (q) => expect(findCondition(q, true)).toBeNull());

  it.each([
    "If I get a response, I'll book Friday.",
    "Assuming someone objects, I'll call on Friday.",
    "If that's fine with the board, I'll book Friday.",
    "I'll send it as soon as Monday's numbers are in.",
    "I'll book Friday if we renew.",
    "I'll book Friday, if that works for the board.",
    "I'll send it as soon as next week's numbers are in.",
  ])("near misses still cap: %s", (q) => expect(findCondition(q, true)).not.toBeNull());

  it.each(["I'll book Friday, if that's fine with you.", "I'll book Friday, if that works for you.", "I'll book Friday if that's okay"])("a courtesy to the reader: %s", (q) =>
    expect(findCondition(q, true)).toBeNull(),
  );
});

describe("findCondition(): words around a condition-only sentence (T-G8)", () => {
  it.each([
    "I'll send it Monday. Well, only if the venue confirms.",
    "I'll send it Monday. Just to be clear, only if the venue confirms.",
    "I'll send it Monday. If the venue confirms, by Friday.",
    "I'll send it Monday. Only if the venue confirms, and the budget passes.",
    "I'll send it Monday. Only if the venue confirms, I mean.",
    "I'll send it Monday. Again, assuming the budget passes.",
  ])("caps: %s", (q) => expect(findCondition(q, true)).not.toBeNull());

  it.each([
    "I'll call you back. If I don't pick up, text me.",
    "I'll call you Friday. If the venue calls, then tell them I'm out.",
    "I'll pay Friday. If you're busy, no worries.",
    "I'll send it Friday. Bring cake if you can.",
  ])("a main clause stays out: %s", (q) => expect(findCondition(q, true)).toBeNull());
});

describe("findCondition(): the 'if you have' courtesy is only about offering help", () => {
  it.each([
    "If you have the contract signed by Thursday, I'll send it Friday.",
    "If you have the address, I'll book the van Friday.",
    "I'll send it Friday if you have the funds.",
  ])("a real condition caps: %s", (q) => expect(findCondition(q, true)).not.toBeNull());

  it.each([
    "If you have questions, call me.",
    "I'll send the deck Friday; if you have any questions, ping me.",
    "I'll send the deck Friday, if you have a problem with it, tell me.",
    "If you have time, I'll walk you through it on Friday.",
    "If you have any further comments about the draft, I'll fold them in on Friday.",
    "If you need anything, I'll be in on Friday.",
    "If you want, I'll pick you up on Friday.",
  ])("a courtesy does not cap: %s", (q) => expect(findCondition(q, true)).toBeNull());
});

describe("findCondition(): 'have' as the main verb looks at the whole step (T-G18)", () => {
  it.each([
    "I'll send it Friday, once I have final approval.",
    "I'll send it Friday, once we have board approval.",
    "I'll send it Friday, once we have the client's written permission.",
    "I'll send it Friday, once I have the final go-ahead from Sam.",
  ])("caps: %s", (q) => expect(findCondition(q, true)).not.toBeNull());

  it.each([
    "I'll send it Friday, once I've paid the deposit.",
    "I'll send it Friday, once I've sent the reply.",
    "I'll send it Friday, once I've written the response.",
    "I'll send it Friday, once we have moved the funds.",
    "I'll send it Friday, once I have a minute.",
    "I'll send it Friday, once I've had a chance.",
  ])("the speaker's own work stays exempt: %s", (q) => expect(findCondition(q, true)).toBeNull());
});
