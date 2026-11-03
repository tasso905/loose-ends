import { describe, expect, it } from "vitest";
import { findCondition } from "@/lib/pipeline/conditional";
import { possessiveDatePhrase, resolveDate } from "@/lib/pipeline/resolveDates";
import { scoreItem } from "@/lib/pipeline/score";

/**
 * Lead-tester verification of fix/guard-followups-2 (7cfc259): T-G3 to T-G6 and T-D6, attacked with
 * cases beyond the developer's. Synthetic text only.
 * `it` = REGRESSION GUARD (verified behaviour). `it.fails` = OPEN DEFECT: it asserts the required
 * behaviour and currently fails; when fixed, the test goes red and the marker becomes `it`.
 * "REGRESSION" in a label means 5ea08d6 got that case right and 7cfc259 does not.
 */

const capped = (q: string) => expect(findCondition(q, true)).not.toBeNull();
const notCapped = (q: string) => expect(findCondition(q, true)).toBeNull();
const band = (q: string) =>
  scoreItem({ type: "commitment", owner: "user", certainty: "explicit", matchKinds: ["exact"], quotes: [q], dateAgreement: "agree" }).band;

describe("T-G3: a condition-only sentence attaches to the adjacent promise", () => {
  it.each([
    "I'll send the invites on Monday. Only if the venue confirms, though.",
    "I'll send the invites on Monday. If the venue confirms by Friday.",
    "I'll order the lumber Thursday. Assuming the budget passes.",
    "If the venue confirms by Friday. I'll send the invites Monday.",
    "I'll send it Monday. Provided the budget passes.",
    "I'll send it Monday. Once the venue confirms.",
    "I'll send it Monday. As soon as the venue confirms.",
    "I'll send it Monday! If the venue confirms!",
    "I'll send it Monday. But only if Priya agrees.",
    "I'll send it Monday. That is, if the venue confirms.",
    "Assuming the budget passes, of course. We'll order banners on Monday.",
    "I'm gonna send it Monday. If they confirm?",
  ])("caps: %s", capped);

  it.each([
    "I'll call you back. If I don't pick up, text me.",
    "I'll send the deck Friday. If the venue calls, tell them I'm out.",
    "I'll pay Friday. If you're busy, no worries.",
    "I'll send it Friday. If it's late, sorry.",
    "Bring cake if you can. I'll send the invites Monday.",
    "I'll be there Friday. Even if it rains.",
    "I'll be there Friday. Once I've finished up.",
  ])("a sentence with its own main clause stays out: %s", notCapped);

  // REGRESSION GUARD (T-G7, fixed in fix/guard-followups-3): isConditionFragment treats "no comma" as "no main
  // clause", so a chat-style conditional instruction attaches and a firm dated promise drops to Low.
  for (const q of [
    "I'll call you back. If I don't pick up text me.",
    "I'll call you Friday. If I miss you leave a message.",
    "I'll call you Friday. If it's urgent call Priya instead.",
    "I'll call you Friday. If I'm late - start without me.",
  ]) {
    it(`REGRESSION: a comma-less main clause stays out: ${q}`, () => notCapped(q));
  }

  // REGRESSION GUARD (T-G8, fixed in fix/guard-followups-3): words around the condition outside FRAGMENT_FILLER lose the fragment.
  for (const q of [
    "I'll send it Monday. Well, only if the venue confirms.",
    "I'll send it Monday. Again, only if the venue confirms.",
    "I'll send it Monday. If the venue confirms, by Friday.",
    "I'll send it Monday. Only if the venue confirms, and the budget passes.",
    "I'll send it Monday. Only if the venue confirms, I mean.",
  ]) {
    it(`a condition fragment with other trailing or leading words caps: ${q}`, () => capped(q));
  }
});

describe("T-G4: an I/we step that receives or waits caps; own actions stay exempt", () => {
  it.each([
    "I'll send it Friday, once I hear from the venue.",
    "I'll send it Friday, once I've heard back.",
    "I'll send it Friday, once I receive the deposit.",
    "I'll send it Friday, once I've received the deposit.",
    "I'll send it Friday, as soon as I get paid.",
    "I'll send it Friday, once we get approval.",
    "I'll send it Friday, once we get the go-ahead.",
    "I'll send it Friday, once I'm told.",
    "I'll send it Friday, once I am told.",
    "I'll send it Friday, once I’m told.",
    "I'll send it Friday, once I've been paid.",
    "I'll send it Friday, once we've been told.",
    "I'll send it Friday, once we're approved.",
    "I'll send it Friday, once I'm reimbursed.",
    "I'll send it Friday, once I've got approval.",
    "I'll send it Friday, once I got the OK.",
    "I'll send it Friday, as soon as we're given the OK.",
  ])("caps: %s", capped);

  it.each([
    "I'll send them Tuesday, once I've cleaned them up.",
    "I'll send them Tuesday, as soon as I finish the edits.",
    "I'll send them Tuesday, once I've signed the forms.",
    "I'll send them Tuesday, once I get back.",
    "I'll send them Tuesday, once I get home.",
    "I'll send them Tuesday, once I get it done.",
    "I'll send them Tuesday, once I get off work.",
    "I'll send them Tuesday, once I'm back.",
    "I'll send them Tuesday, once I’m back.",
    "I'll send them Tuesday, once we're back.",
    "I'll send them Tuesday, once I'm done.",
    "I'll send them Tuesday, once I've paid the deposit.",
    "I'll send them Tuesday, once we've approved the plan.",
    "I'll send them Tuesday, once I've told Sam.",
    "I'll send them Tuesday, once I've sent the file.",
    "I'll send them Tuesday, once I have a minute.",
  ])("own action exempt: %s", notCapped);

  // REGRESSION GUARD (T-G9, fixed in fix/guard-followups-3): any "get" outside GET_OWN caps, so an
  // ordinary dated promise on the speaker's own time scores Low. This is the false positive
  // explicit_dated_scored_low exists to catch; no golden has this wording. Note "once I have a minute"
  // is exempt and "once I get a minute" is not.
  for (const q of [
    "I'll send them Tuesday, once I get a chance.",
    "I'll send them Tuesday, once I get some time.",
    "I'll send them Tuesday, once I get a minute.",
    "I'll send them Tuesday, once I get everything sorted.",
    "I'll send them Tuesday, once I get my notes together.",
    "I'll send them Tuesday, once I get the kids to bed.",
  ]) {
    it(`REGRESSION: the speaker's own 'get' stays High: ${q}`, () => expect(band(q)).toBe("high"));
  }

  // REGRESSION GUARD (T-G10, fixed in fix/guard-followups-3): waiting wordings outside the lists read as own actions and stay High.
  for (const q of [
    "I'll send it Friday, once I have approval.",
    "I'll send it Friday, once we have the go-ahead.",
    "I'll send it Friday, once I have the funds.",
    "I'll send it Friday, once I find out.",
    "I'll send it Friday, once I actually hear from them.",
    "I'll send it Friday, once I eventually get paid.",
    "I'll send it Friday, once I'm granted access.",
    "I'll send it Friday, once we're signed off.",
    "I'll send it Friday, once I get it from Sam.",
    "I'll send it Friday, once I've cleaned up and the client approves.",
  ]) {
    it(`a step that still waits on someone caps: ${q}`, () => capped(q));
  }
});

describe("T-G5: only the period itself passing is exempt", () => {
  it.each([
    "I'll pay the vendors on Friday once the month's invoices are approved",
    "I'll send the plan Monday once the quarter's budget is signed off",
    "I'll book the trip Friday once the season tickets go on sale",
    "I'll send it Friday once the week's numbers are in",
    "I'll send it Friday once the holiday schedule is posted",
    "I'll send it Friday once the term dates are published",
    "I'll send it Friday once the weekend crew finishes",
    "I'll send it Friday once the new year budget passes",
    "I'll send it Friday once the clocks are fixed",
  ])("caps: %s", capped);

  it.each([
    "I'll call you Monday at 10am, once the clocks have changed",
    "I'll call you Monday, once the clocks change",
    "I'll call you Monday, once the clocks go back",
    "I'll call you Monday, once the clocks go forward",
    "I'll call you Monday, once the clocks have gone back",
    "I'll send it Monday, as soon as the holidays are over",
    "I'll send it Monday, once the week is over",
    "I'll send it Monday, once the month ends",
    "I'll send it Monday, once the quarter starts",
    "I'll send it Monday, once the term has begun",
    "I'll send it Monday, once the new year starts",
    "I'll send it Monday, once next week starts",
    "I'll send it Monday, once the season begins",
    "I'll send it Monday, once the month has changed",
  ])("exempt: %s", notCapped);

  // REGRESSION GUARD (T-G11, fixed in fix/guard-followups-3): TIME_STEP's `'s over` alternative sits after a
  // mandatory \s+, so it can never match. "the week's over" is the same claim as "the week is over".
  for (const q of ["I'll send it Monday, once the week's over", "I'll send it Monday, once the weekend's over", "I'll send it Monday, once the holidays're over"]) {
    it(`REGRESSION: the contracted form is exempt too: ${q}`, () => notCapped(q));
  }

  // REGRESSION GUARD (T-G12, fixed in fix/guard-followups-3): TIME_STEP has no end anchor, so a time step joined to someone else's
  // action is exempt. T-G4's own-step check has the same gap (see T-G10, "and the client approves").
  for (const q of ["I'll send it Friday once the month is over and the invoices are approved", "I'll send it Friday once the week ends and Sam signs off"]) {
    it(`a time step joined to someone else's action caps: ${q}`, () => capped(q));
  }
});

describe("T-G6: sentence splitting", () => {
  it.each([
    "i'll call you back. if i don't pick up, text me.",
    "I'll call you back at 9 a.m. If I don't pick up, text me.",
    "I'll call you back at 9 A.M. If I don't pick up, text me.",
    "He said “I'll call you.” If I don't pick up, text me.",
    "“I'll call you back.” “If I don't pick up, text me.”",
    "I’ll call you back. If I don’t pick up, text me.",
    "'I'll call you back.' 'If I don't pick up, text me.'",
    "I'll call you back? if I don't pick up, text me.",
  ])("the 'if' is in another sentence: %s", notCapped);

  it.each([
    "I'll call you at 9 a.m. if the venue confirms",
    "I'll call you at 5 p.m. if Sam confirms",
    "I'll call at 9 A.M. if the venue confirms",
    "I'll bring e.g. chips, if Sam agrees.",
    "I'll bring snacks (e.g. chips) if Sam agrees.",
    "I'll bring i.e. chips if Sam agrees.",
    "I'll see Dr. Lin Friday if she's in.",
    "I'll book Friday if Dr. Lin confirms.",
    "If Dr. Lin confirms, I'll book Friday.",
  ])("an abbreviation does not split the condition off: %s", capped);

  // REGRESSION GUARD (T-G13, fixed in fix/guard-followups-3): a capital after "a.m." / "p.m." is usually a weekday
  // or month, not a new sentence. The condition lands in a sentence with no promise verb and no fragment
  // shape, is blanked, and the conditional promise scores High 0.95. D64(c) exists to stop exactly this.
  for (const q of ["I'll call at 9 a.m. Friday if the venue confirms.", "I'll call by 5 p.m. Friday, once the venue confirms.", "I'll call at 9 a.m. Monday, assuming the budget passes."]) {
    it(`REGRESSION: a.m./p.m. before a weekday is not a sentence end: ${q}`, () => expect(band(q)).toBe("low"));
  }

  // REGRESSION GUARD (T-G14, fixed in fix/guard-followups-3): any abbreviation outside ABBREV now splits
  // before a lowercase word too, with the same result: High.
  for (const q of ["I'll see you Fri. at 9 if Sam confirms.", "I'll ship to Acme Inc. on Friday if the deposit clears.", "I'll call the U.S. office Friday if the deal closes.", "I'll pay approx. 40 on Friday if the job is done."]) {
    it(`REGRESSION: an abbreviation before lowercase is not a sentence end: ${q}`, () => expect(band(q)).toBe("low"));
  }
  it("an abbreviation before a capital is not a sentence end (not a regression): I'll call Prof. Lin Friday if she's in.", () =>
    expect(band("I'll call Prof. Lin Friday if she's in.")).toBe("low"),
  );

  // REGRESSION GUARD (T-G15, fixed in fix/guard-followups-3): a semicolon or a line break does not split; pasted chat is line based.
  for (const q of ["I'll call you Friday; if I don't pick up, text me.", "I'll call you Friday\nIf I don't pick up, text me"]) {
    it(`an 'if' after a semicolon or line break with its own main clause stays out: ${JSON.stringify(q)}`, () => notCapped(q));
  }
});

describe("opt-outs, courtesies, idioms and plain promises", () => {
  it.each([
    "Unless I hear otherwise, I'll have the crew come again on Friday, November 13.",
    "If I don't hear back by Thursday, I'll book the room.",
    "If I don't hear from you by Friday, I'll book it.",
    "If I do not hear from you, I'll renew Friday.",
    "If we haven't heard from you, we'll renew the plan on Friday.",
    "If nobody objects, I'll send the minutes tonight.",
    "If no one objects, I'll send the minutes tonight.",
    "If you don't object, I'll move the meeting to 3pm Friday.",
    "If there are no objections, we'll go with the blue logo on Friday.",
    "If I don't get a reply, I'll book Friday.",
    "If you have questions, call me.",
    "I'll send the deck Friday; if you have any questions, ping me.",
    "I'll bring extra chairs if needed.",
    "I'll call you tomorrow if possible.",
    "Let me know if that's a problem, I'll send it Monday.",
    "I'll send the forms Friday, if that works.",
    "If you'd like, I'll drive you to the airport Sunday.",
    "I'll send it as soon as possible.",
    "I'll send it as soon as I can.",
    "I'll send it as soon as I'm able.",
    "I'll water the plants once a week while you're away.",
    "Thanks once again, I'll send the photos tomorrow.",
    "I'll start at once.",
    "I'll finish it even if it takes all night.",
    "I'll send the report on Monday.",
    "We'll start the repair on Tuesday.",
    "Mike will send the contract by Friday.",
  ])("no cap: %s", notCapped);

  // REGRESSION GUARD (T-G16, fixed in fix/guard-followups-3): dated, firm promises capped to Low, each a
  // live risk to explicit_dated_scored_low. The opt-out wordings are named by D64(c) as exempt.
  for (const q of [
    "If I don't get a response, I'll book Friday.",
    "If I hear nothing by Thursday, I'll book the room Friday.",
    "If nobody says otherwise, I'll book the room Friday.",
    "Assuming no one objects, I'll send the minutes on Friday.",
    "Assuming I don't hear otherwise, I'll book the room Friday.",
    "I'll send the forms Friday, if that's fine.",
    "I'll send the forms Friday, if that's alright.",
    "I'll call you Friday, if you don't mind.",
    "I'll call you Friday, if it's okay.",
    "I'll drop it off Friday, if you wish.",
    "I'll let you know by Friday if I can make it.",
    "I'll decide by Friday if we renew.",
    "I'll verify if the room is free by Friday.",
    "I'll fix it once and for all on Friday.",
    "I'll cover for you just this once on Friday.",
    "I'll call at least once on Friday.",
    "We'll start as soon as Monday.",
    "I'll send it as soon as tomorrow.",
  ]) {
    it(`opt-out, courtesy, embedded question or idiom is not a condition: ${q}`, () => notCapped(q));
  }
});

describe("scope and band (D64(c))", () => {
  it.each([
    ["commitment", "user"],
    ["waiting_on", "other"],
    ["intention", "user"],
  ] as const)("%s: a condition caps at Low whatever the model said", (type, owner) => {
    const r = scoreItem({ type, owner, certainty: "explicit", matchKinds: ["exact"], quotes: ["If the venue confirms, I'll send the invites Monday."], dateAgreement: "agree" });
    expect(r.band).toBe("low");
    expect(r.score).toBeLessThanOrEqual(0.45);
    expect(r.signals).toContain("conditional");
  });

  it.each(["request", "deadline", "decision", "key_fact"] as const)("%s is out of scope: not capped", (type) => {
    const r = scoreItem({ type, owner: "user", certainty: "explicit", matchKinds: ["exact"], quotes: ["If you wish to renew, please sign by Dec 1."], dateAgreement: "agree" });
    expect(r.signals).not.toContain("conditional");
  });

  it("the exempt own step on a dated promise is High; undated it caps", () => {
    const q = "I'll send them, once I've cleaned them up";
    expect(findCondition(q, true)).toBeNull();
    expect(findCondition(q, false)).not.toBeNull();
    expect(band("I'll send them Tuesday, once I've cleaned them up.")).toBe("high");
  });
});

describe("T-D6: possessive month and day", () => {
  const ctx = { referenceDate: "2026-10-20", referenceDateSource: "user" as const, timezone: "America/New_York" };
  const r = (t: string, iso: string | null = null) => resolveDate({ date_text: t, date_iso: iso }, ctx);

  it.each([
    ["June's 15th", "2027-06-15"],
    ["June’s 15th", "2027-06-15"],
    ["JUNE'S 15TH", "2027-06-15"],
    ["june's 15th", "2027-06-15"],
    ["by June's 15th", "2027-06-15"],
    ["June's the 15th", "2027-06-15"],
    ["June's 15", "2027-06-15"],
    ["May's 5th", "2027-05-05"],
    ["April's 3rd", "2027-04-03"],
    ["August's 5th", "2027-08-05"],
    ["March's 1st", "2027-03-01"],
    ["Oct's 3rd", "2026-10-03"],
  ])("%s → %s", (t, day) => expect(r(t).due_date).toBe(day));

  it("agreeing with the model is explicit and unflagged", () => {
    const d = r("June's 15th", "2027-06-15");
    expect({ due: d.due_date, agreement: d.agreement, certainty: d.due_certainty, notes: d.not_sure }).toEqual({ due: "2027-06-15", agreement: "agree", certainty: "explicit", notes: [] });
  });

  it("a model date that disagrees is overridden by chrono's reading and flagged (rule 3)", () => {
    const d = r("June's 15th", "2027-06-01");
    expect(d.due_date).toBe("2027-06-15");
    expect(d.due_certainty).toBe("inferred");
    expect(d.not_sure.length).toBeGreaterThan(0);
  });

  it.each(["June's 32nd", "Feb's 30th"])("an impossible day gives no date: %s", (t) => expect(r(t).due_date).toBeNull());

  it.each(["June's report", "May's report", "Call June", "call June", "ask June", "see June", "email May", "June's", "May's", "April's", "August's"])(
    "a person, not a date: %s",
    (t) => {
      expect(possessiveDatePhrase(t)).toBeNull();
      expect(r(t).due_date).toBeNull();
    },
  );

  it("the first-name rule is exactly May, June, April, August", () => {
    for (const m of ["May", "June", "April", "August"]) expect(possessiveDatePhrase(`${m}'s`)).toBeNull();
    for (const m of ["January", "Jan", "March", "July", "Sept", "October", "December"]) expect(possessiveDatePhrase(`${m}'s`)).toBe(m);
  });

  // REGRESSION GUARD (T-D7, fixed in fix/guard-followups-3): a count
  // after a name that is a month is read as the day. Reached only if the model offers this as date_text.
  for (const t of ["May's 3 kids", "June's 2 cents", "April's 12 tickets", "June's 15 minutes", "Jan's 5 kids"]) {
    it(`a count after the possessive is not a day: ${t}`, () => expect(r(t).due_date).toBeNull());
  }

  // REGRESSION GUARD (T-D8, fixed in fix/guard-followups-3): the reasoning that removed "report" applies to these nouns too.
  for (const t of ["May's order", "June's review", "June's schedule", "April's statement"]) {
    it(`a noun a person can own is not a date: ${t}`, () => expect(r(t).due_date).toBeNull());
  }

  // REGRESSION GUARD (T-D9, fixed in fix/guard-followups-3): "June's end" is flagged inferred but dated the first of the month.
  it("'June's end' is not Jun 1", () => expect(r("June's end").due_date).not.toBe("2027-06-01"));
});
