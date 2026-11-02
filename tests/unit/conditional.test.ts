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
    "I'll ship it Friday as soon as the labels print.",
  ])("a trailing 'once' step on a dated promise is not a condition: '%s'", (quote) => {
    expect(findCondition(quote, true)).toBeNull();
    // Without its own date the same clause is a condition.
    expect(findCondition(quote, false)).not.toBeNull();
  });
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
