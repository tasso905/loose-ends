/**
 * Lead-tester edge cases (Oct 18 verification of day-1 foundations; re-verified after round 2).
 *
 * "REGRESSION GUARD" tests cover defects found in earlier rounds and since fixed; they must stay green.
 * Tests marked `it.fails` document an OPEN DEFECT: they assert the required behaviour and currently
 * fail. Vitest reports them as passing while the defect exists and as failing once it is fixed;
 * at that point change `it.fails` to `it` and relabel the comment REGRESSION GUARD.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { askWhy, NO_RECORD_MESSAGE, type RetrievedDecision } from "@/lib/ai/askWhy";
import { extract, ExtractionFailedError, type ExtractInput } from "@/lib/ai/extract";
import { createRecordedModel, type Recording } from "@/lib/ai/fake";
import { AiConfigError } from "@/lib/ai/provider";
import type { Extraction, Item } from "@/lib/ai/schema";
import type { LogEvent, LogProps } from "@/lib/log";
import { normalizeForMatch } from "@/lib/pipeline/normalize";
import { processExtraction } from "@/lib/pipeline/proposals";
import { resolveDate, type DateContext } from "@/lib/pipeline/resolveDates";
import { scoreItem } from "@/lib/pipeline/score";
import { containsWholePhrase, matchQuote, verifyBrief, verifyQuotes } from "@/lib/pipeline/verifyQuotes";
import { matchFactUnit } from "@/lib/ai/grounding";
import type { ThreadStatus } from "@/lib/schemas";
import { transition, type ThreadAction, type ThreadState } from "@/lib/threads/transition";

const NY: DateContext = { referenceDate: "2026-10-05", referenceDateSource: "user", timezone: "America/New_York" };
const silent = () => {};

function item(quote: string, over: Partial<Item> = {}): Item {
  return {
    type: "commitment",
    title: "t",
    owner: "user",
    counterparty: null,
    action: null,
    date_text: null,
    date_iso: null,
    amount_text: null,
    certainty: "explicit",
    uncertainty_notes: [],
    matches_thread_id: null,
    evidence: [{ quote, speaker: null }],
    ...over,
  };
}

function extraction(items: Item[]): Extraction {
  return { source_summary: "s", participants: [], items, brief: null };
}

/* ------------------------------------------------------------------ */
/* Rule 1: quote verification                                          */
/* ------------------------------------------------------------------ */

describe("rule 1: fuzzy threshold boundary (≥ 0.9)", () => {
  const src = normalizeForMatch("zzz abcdefghij zzz");

  it("one edit in a 10-character quote is exactly 0.9 and is accepted", () => {
    const m = matchQuote("abcdefghiX", src);
    expect(m.similarity).toBeCloseTo(0.9, 10);
    expect("match_kind" in m && m.match_kind).toBe("fuzzy");
  });

  it("one edit in a 9-character quote is 0.889 and is rejected", () => {
    const m = matchQuote("abcdefghX", src);
    expect("match_kind" in m).toBe(false);
    expect(m.similarity).toBeLessThan(0.9);
  });

  it("a 3-character quote must match exactly (one wrong letter is rejected)", () => {
    expect("match_kind" in matchQuote("abX", src)).toBe(false);
    expect("match_kind" in matchQuote("abc", src)).toBe(true);
  });
});

describe("rule 1: drop and log", () => {
  it("a whitespace-only quote (passes Zod min(3)) is dropped and logged", () => {
    const logger = vi.fn();
    const r = verifyQuotes([item("   ")], "Anything at all here.", { logger });
    expect(r.items).toHaveLength(0);
    expect(r.droppedItemIndexes).toEqual([0]);
    expect(logger).toHaveBeenCalledWith("quote_unverified", expect.objectContaining({ item_index: 0, evidence_index: 0 }));
  });

  it("an em dash in the source matches a hyphen in the model's quote exactly", () => {
    const r = verifyQuotes([item("Thanks Mike - I'll send it")], "Thanks Mike — I’ll send it Friday.", { logger: silent });
    expect(r.items[0]!.evidence[0]!.match_kind).toBe("exact");
  });

  it("a fuzzy match that altered a number displays the source's number, and the made-up amount is cleared", () => {
    const source = "Your policy renews at $1,470 per year on Oct 31.";
    const r = verifyQuotes([item("Your policy renews at $1,740 per year", { amount_text: "$1,740" })], source, { logger: silent });
    expect(r.items).toHaveLength(1);
    const ev = r.items[0]!.evidence[0]!;
    expect(ev.match_kind).toBe("fuzzy");
    expect(ev.quote).toContain("$1,470");
    expect(ev.quote).not.toContain("$1,740");
    expect(source.slice(ev.start_offset, ev.end_offset)).toBe(ev.quote);
    expect(r.items[0]!.item.amount_text).toBeNull();
  });

  it("processExtraction never returns a proposal whose every quote failed, and counts each failure", () => {
    const source = "Legal still has the contract.";
    const out = processExtraction(
      extraction([
        item("Legal still has the contract", { type: "waiting_on", owner: "other" }),
        item("I promised to call Dana", { evidence: [{ quote: "I promised to call Dana", speaker: null }, { quote: "Dana is waiting", speaker: null }] }),
      ]),
      { ...NY, sourceText: source, logger: silent },
    );
    expect(out.proposals.map((p) => p.index)).toEqual([0]);
    expect(out.droppedItemIndexes).toEqual([1]);
    expect(out.unverifiedQuoteCount).toBe(2);
    for (const p of out.proposals) for (const e of p.evidence) expect(source.slice(e.start_offset, e.end_offset)).toBe(e.quote);
  });

  it("an Explain card line with basis=source but no quote is dropped and logged", () => {
    const logger = vi.fn();
    const b = verifyBrief(
      { what_this_is: [{ text: "A renewal notice", basis: "source", quote: null }], what_to_do: [], by_when: [], if_you_dont: [], worth_considering: [], not_sure_about: [] },
      "Your policy renews Oct 31.",
      { logger },
    );
    expect(b.what_this_is).toHaveLength(0);
    expect(logger).toHaveBeenCalledWith("quote_unverified", expect.objectContaining({ brief_section: "what_this_is", line_index: 0 }));
  });
});

/* ------------------------------------------------------------------ */
/* Rule 3: dates are deterministic, never filled                       */
/* ------------------------------------------------------------------ */

describe("rule 3: never fill a missing date", () => {
  // REGRESSION GUARD (round 1 B2, fixed round 2): date_text must appear in the source.
  it("a date_text that does not appear in the source gives no due date", () => {
    const source = "We should grab lunch sometime.";
    const out = processExtraction(
      extraction([item("We should grab lunch sometime", { type: "intention", date_text: "Friday", date_iso: "2026-10-09" })]),
      { ...NY, sourceText: source, logger: silent },
    );
    expect(out.proposals[0]!.date.due_at).toBeNull();
  });

  it("a model time is not added when the source phrase has none", () => {
    const r = resolveDate({ date_text: "Friday", date_iso: "2026-10-09T17:00:00" }, NY);
    expect(r).toMatchObject({ due_time_known: false, due_at: "2026-10-10T03:59:00.000Z" });
  });

  it("an impossible model date (Feb 30) counts as disagreement; chrono's value is kept", () => {
    expect(resolveDate({ date_text: "Friday", date_iso: "2026-02-30" }, NY)).toMatchObject({ due_date: "2026-10-09", agreement: "disagree", due_certainty: "inferred" });
  });

  it.each([
    ["the 31st", "2026-11-01"],
    ["Feb 29", "2027-01-10"],
  ])("'%s' written %s does not invent a calendar date", (text, ref) => {
    const r = resolveDate({ date_text: text, date_iso: null }, { ...NY, referenceDate: ref });
    if (r.due_date !== null) {
      const [y, m, d] = r.due_date.split("-").map(Number) as [number, number, number];
      const dt = new Date(Date.UTC(y, m - 1, d));
      expect(dt.getUTCDate()).toBe(d);
    } else {
      expect(r.due_certainty).toBe("none");
    }
  });
});

describe("dates: this vs next, year rollover, timezone change, DST", () => {
  it("'this Friday' written on a Saturday is the following Friday", () => {
    expect(resolveDate({ date_text: "this Friday", date_iso: null }, { ...NY, referenceDate: "2026-10-10" }).due_date).toBe("2026-10-16");
  });

  it("'next Friday' written Mon Dec 28, 2026 crosses into 2027 and the reasoning shows the year", () => {
    const r = resolveDate({ date_text: "next Friday", date_iso: null }, { ...NY, referenceDate: "2026-12-28" });
    expect(r.due_date).toBe("2027-01-08");
    expect(r.reasoning).toContain("Fri Jan 8, 2027");
  });

  it("timezone change: same phrase keeps the local day and moves the instant", () => {
    const ny = resolveDate({ date_text: "Friday", date_iso: "2026-10-09" }, NY);
    const la = resolveDate({ date_text: "Friday", date_iso: "2026-10-09" }, { ...NY, timezone: "America/Los_Angeles" });
    expect(ny.due_date).toBe(la.due_date);
    expect(new Date(la.due_at!).getTime() - new Date(ny.due_at!).getTime()).toBe(3 * 3600_000);
  });

  it("a time inside the spring-forward gap still yields a valid instant", () => {
    const r = resolveDate({ date_text: "Sunday at 2:30am", date_iso: null }, { ...NY, referenceDate: "2027-03-12" });
    expect(r.due_date).toBe("2027-03-14");
    expect(Number.isNaN(new Date(r.due_at!).getTime())).toBe(false);
  });

  it("missing reference date (defaulted): 'tomorrow' is Assumed with a Not sure about line", () => {
    const r = resolveDate({ date_text: "tomorrow", date_iso: "2026-10-06" }, { ...NY, referenceDateSource: "defaulted" });
    expect(r.due_certainty).toBe("inferred");
    expect(r.not_sure).toHaveLength(1);
    expect(r.not_sure[0]).toContain("I assumed this was written today");
  });

  // REGRESSION GUARD (round 1 M1, fixed round 2): a month-day just before the written-on date stays overdue.
  it("a month-day just before the reference date is not moved a year ahead", () => {
    const r = resolveDate({ date_text: "Oct 4", date_iso: "2026-10-04" }, NY);
    expect(r.due_date).toBe("2026-10-04");
  });
});

/* ------------------------------------------------------------------ */
/* Confidence: PRD lunch example arithmetic (open doc conflict)        */
/* ------------------------------------------------------------------ */

describe("PRD lunch example arithmetic (PRD Question #11 option b, user decision Oct 18)", () => {
  // Changed in round 8 by lead-developer: hedge words no longer lower the score of an `intention`
  // (the hedge_words signal is still recorded for the label).
  const lunch = { type: "intention" as const, owner: "user" as const, quotes: ["We should grab lunch sometime"], dateAgreement: "none" as const };

  it("speculative 0.30 + exact 0.05 = 0.35 → Low (no hedge penalty for intentions)", () => {
    const r = scoreItem({ ...lunch, certainty: "speculative", matchKinds: ["exact"] });
    expect(r.signals).toEqual(["exact_quote", "no_date", "hedge_words"]);
    expect(r).toMatchObject({ score: 0.35, band: "low" });
  });

  it("implied gives Medium (0.60); explicit gives High (0.85)", () => {
    expect(scoreItem({ ...lunch, certainty: "implied", matchKinds: ["exact"] })).toMatchObject({ score: 0.6, band: "medium" });
    expect(scoreItem({ ...lunch, certainty: "explicit", matchKinds: ["exact"] })).toMatchObject({ score: 0.85, band: "high" });
  });
});

/* ------------------------------------------------------------------ */
/* transition(): extra invariants                                      */
/* ------------------------------------------------------------------ */

function thread(status: ThreadStatus, over: Partial<ThreadState> = {}): ThreadState {
  return {
    title: "Send revised proposal to Mike",
    kind: "commitment",
    next_action: null,
    counterparty: "Mike",
    due_at: null,
    due_certainty: "none",
    due_time_known: false,
    consequence: null,
    consequence_basis: null,
    status,
    resolution: status === "resolved" ? "done" : null,
    waiting_on: status === "waiting" ? "Mike" : null,
    expected_by: null,
    snoozed_until: status === "snoozed" ? "2026-10-06T13:00:00.000Z" : null,
    resolved_at: status === "resolved" ? "2026-10-04T13:00:00.000Z" : null,
    primary_source_id: null,
    confidence: 0.9,
    ...over,
  };
}
const NOW = new Date("2026-10-05T16:00:00.000Z");

describe("transition(): invariants", () => {
  const STATE_CHANGES: Array<[ThreadStatus, ThreadAction]> = [
    ["open", { type: "mark_waiting", waitingOn: "Legal" }],
    ["open", { type: "snooze", until: "2026-10-07T13:00:00.000Z" }],
    ["open", { type: "done" }],
    ["open", { type: "resolve", resolution: "decided" }],
    ["open", { type: "dismiss" }],
    ["waiting", { type: "done" }],
    ["waiting", { type: "back_to_me" }],
    ["waiting", { type: "dismiss" }],
    ["snoozed", { type: "wake" }],
    ["snoozed", { type: "resolve", resolution: "not_needed" }],
    ["resolved", { type: "reopen" }],
    ["dismissed", { type: "reopen" }],
    ["open", { type: "edit", fields: { title: "New title" } }],
  ];

  it.each(STATE_CHANGES)("from %s, %o writes an event with non-empty before and after (F9)", (from, action) => {
    const r = transition(thread(from), action, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).not.toBeNull();
    expect(Object.keys(r.event!.before ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(r.event!.after ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(r.event!.before!).sort()).toEqual(Object.keys(r.event!.after!).sort());
  });

  it("is pure: the input thread is not mutated", () => {
    const t = thread("open");
    const copy = structuredClone(t);
    transition(t, { type: "done" }, { now: NOW });
    transition(t, { type: "edit", fields: { title: "X" } }, { now: NOW });
    expect(t).toEqual(copy);
  });

  it("Done is refused on a waiting thread of kind decision (D6)", () => {
    const r = transition(thread("waiting", { kind: "decision" }), { type: "done" }, { now: NOW });
    expect(r.ok).toBe(false);
  });

  // REGRESSION GUARD (round 1 low, fixed round 2): resolution is validated at runtime.
  it("an unknown resolution value returns invalid_transition", () => {
    const r = transition(thread("open"), { type: "resolve", resolution: "archived" as never }, { now: NOW });
    expect(r.ok).toBe(false);
  });

  // REGRESSION GUARD (round 1 M2, fixed round 2): the AI never closes threads on its own
  // (PRD "Explicit non-behaviors"; CLAUDE.md never-build "auto-complete").
  it("actor 'ai' cannot close a thread", () => {
    expect(transition(thread("open"), { type: "done" }, { now: NOW, actor: "ai" }).ok).toBe(false);
    expect(transition(thread("open"), { type: "dismiss" }, { now: NOW, actor: "ai" }).ok).toBe(false);
    expect(transition(thread("open"), { type: "resolve", resolution: "done" }, { now: NOW, actor: "ai" }).ok).toBe(false);
  });

  // REGRESSION GUARD (round 1 low, fixed round 2): Edit, like Snooze, needs a future snoozed_until.
  it("editing snoozed_until into the past is refused, as Snooze is", () => {
    const r = transition(thread("snoozed"), { type: "edit", fields: { snoozed_until: "2026-10-01T13:00:00.000Z" } }, { now: NOW });
    expect(r.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Rule 7: Ask why                                                     */
/* ------------------------------------------------------------------ */

const DECISION: RetrievedDecision = {
  id: "dec-1",
  thread_id: "thr-1",
  thread_title: "Home insurance renewal",
  counterparty: "Provider A",
  choice: "Renewed with Provider A",
  reason_user: "The alternatives were more expensive and this policy included windshield coverage.",
  decided_at: "2026-10-18T14:00:00.000Z",
  context_facts: [{ text: "Annual premium $1,470", evidence_id: "ev-1" }],
};

function askModel(question: string, response: unknown) {
  const rec: Recording = { name: `t-${question}`, task: "ask_why", input: question, responses: [response] };
  return createRecordedModel({ recordings: [rec] });
}

describe("rule 7: Ask why", () => {
  it("zero matches returns the exact PRD sentence with no model call", async () => {
    const model = askModel("Why?", { answer_found: true, decision_ids: [], answer_parts: [] });
    const r = await askWhy("Why?", [], { model });
    expect(r.message).toBe("I don't have a recorded decision about that.");
    expect(NO_RECORD_MESSAGE).toBe("I don't have a recorded decision about that.");
    expect(r.llm_called).toBe(false);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("model answer_found=false gives the fixed sentence and no parts", async () => {
    const q = "Why did I sell the boat?";
    const r = await askWhy(q, [DECISION], { model: askModel(q, { answer_found: false, decision_ids: [], answer_parts: [] }), logger: silent });
    expect(r).toMatchObject({ answer_found: false, parts: [], message: NO_RECORD_MESSAGE, llm_called: true });
  });

  it("a user_reason citing a decision with no recorded reason is rejected", async () => {
    const q = "Why did I renew?";
    const r = await askWhy(
      q,
      [{ ...DECISION, reason_user: null }],
      { model: askModel(q, { answer_found: true, decision_ids: ["dec-1"], answer_parts: [{ kind: "user_reason", text: "It was cheaper.", ref: "dec-1" }] }), logger: silent },
    );
    expect(r.parts.filter((p) => p.kind === "user_reason")).toHaveLength(0);
  });

  it("an inference citing an unretrieved id is dropped", async () => {
    const q = "Why did I renew the policy?";
    const r = await askWhy(q, [DECISION], {
      model: askModel(q, { answer_found: true, decision_ids: ["dec-1"], answer_parts: [{ kind: "inference", text: "x", ref: "dec-999" }] }),
      logger: silent,
    });
    expect(r.parts).toHaveLength(0);
    expect(r.decision_ids).toEqual(["dec-1"]);
  });

  // REGRESSION GUARD (round 1 B1, rule 7, fixed round 2). Changed in round 6 by lead-developer: the server now
  // ignores the model's text for source_fact and shows the cited stored fact, so invented text is never shown.
  it("a source_fact never shows text that is not the cited stored fact", async () => {
    const q = "Why did I keep Provider A?";
    const r = await askWhy(q, [DECISION], {
      model: askModel(q, {
        answer_found: true,
        decision_ids: ["dec-1"],
        answer_parts: [{ kind: "source_fact", text: "Provider B quoted $2,900 and dropped flood cover.", ref: "ev-1" }],
      }),
      logger: silent,
    });
    expect(r.parts.filter((p) => p.kind === "source_fact").map((p) => p.text)).toEqual(["Annual premium $1,470"]);
  });

  // REGRESSION GUARD (round 1 low, fixed round 2). Changed in round 6 by lead-developer: a cited user_reason
  // always shows the whole stored reason_user, whatever (or however empty) the model's text.
  it("a user_reason shows the whole stored reason, never the model's text", async () => {
    const q = "Why did I renew it?";
    const r = await askWhy(q, [DECISION], {
      model: askModel(q, { answer_found: true, decision_ids: ["dec-1"], answer_parts: [{ kind: "user_reason", text: " ", ref: "dec-1" }] }),
      logger: silent,
    });
    expect(r.parts.filter((p) => p.kind === "user_reason").map((p) => p.text)).toEqual([DECISION.reason_user]);
  });
});

/* ------------------------------------------------------------------ */
/* Rule 9: log events carry IDs, enums and counts only                 */
/* ------------------------------------------------------------------ */

describe("rule 9: logger payloads never contain content", () => {
  it("pipeline + Ask why logs contain no words from the source, quotes, amounts, names or reasons", async () => {
    const calls: Array<[LogEvent, LogProps]> = [];
    const logger = (e: LogEvent, p: LogProps) => void calls.push([e, p]);
    const source = "Priyanka said the Zephyr invoice of $4,321 is overdue.";
    processExtraction(
      {
        ...extraction([
          item("Priyanka will wire Quentin the money", { amount_text: "$9,999", counterparty: "Quentin" }),
          item("Zephyr invoice of $4,321 is overdue", { amount_text: "$7,777", counterparty: "Bartholomew" }),
        ]),
        brief: { what_this_is: [{ text: "Invoice from Zephyr", basis: "source", quote: "Totally invented sentence here" }], what_to_do: [], by_when: [], if_you_dont: [], worth_considering: [], not_sure_about: [] },
      },
      { ...NY, sourceText: source, logger, extractionId: "ex-9" },
    );
    const q = "Why did I renew with Provider A?";
    await askWhy(q, [DECISION], {
      model: askModel(q, {
        answer_found: true,
        decision_ids: ["dec-1", "dec-404"],
        answer_parts: [{ kind: "user_reason", text: "Windshield secretword", ref: "dec-1" }, { kind: "source_fact", text: "x", ref: "ev-404" }],
      }),
      logger,
    });

    expect(calls.map((c) => c[0])).toEqual(expect.arrayContaining(["quote_unverified", "field_unverified", "ask_why_ref_rejected"]));
    const forbidden = ["Priyanka", "Quentin", "Zephyr", "4,321", "9,999", "7,777", "Bartholomew", "invented", "secretword", "Windshield", "Provider", "renew"];
    for (const [, props] of calls) {
      for (const v of Object.values(props)) {
        if (typeof v !== "string") continue;
        for (const w of forbidden) expect(v.toLowerCase()).not.toContain(w.toLowerCase());
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Fake provider: never live                                           */
/* ------------------------------------------------------------------ */

describe("fake provider never falls back to a live call", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  const input: ExtractInput = {
    sourceText: "An input nobody recorded, for the network test.",
    sourceKind: "paste",
    referenceDate: "2026-10-05",
    referenceDateSource: "user",
    timezone: "America/New_York",
    user: { displayName: "Sam", aliases: [] },
  };

  it("AI_PROVIDER=fake with no recording fails without any fetch", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network used")));
    vi.stubGlobal("fetch", fetchSpy);
    process.env.AI_PROVIDER = "fake";
    process.env.AI_MODEL = "recorded";
    await expect(extract(input, { logger: silent })).rejects.toBeInstanceOf(ExtractionFailedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with no AI_PROVIDER there is no default provider: extract() and askWhy() refuse", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network used")));
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;
    await expect(extract(input, { logger: silent })).rejects.toBeInstanceOf(AiConfigError);
    await expect(askWhy("Why?", [DECISION], { logger: silent })).rejects.toBeInstanceOf(AiConfigError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Round 2 findings (all fixed in round 3)                             */
/* ------------------------------------------------------------------ */

describe("round 2: date_text presence check needs word boundaries (rule 3)", () => {
  // REGRESSION GUARD (round 2 N2, rule 3, fixed round 3): date_text must be a whole phrase of the source,
  // so "May" is not found in "Maybe" (nor Wed/wedding, March/marched, Mon/Monica).
  it("a date_text found only inside another word gives no due date", () => {
    for (const [source, dateText] of [
      ["Maybe we can catch up.", "May"],
      ["Bring the wedding photos.", "Wed"],
      ["They marched on.", "March"],
      ["Call Monica back.", "Mon"],
    ] as const) {
      const out = processExtraction(
        extraction([item(source.replace(/\.$/, ""), { type: "intention", date_text: dateText })]),
        { ...NY, sourceText: source, logger: silent },
      );
      expect(out.proposals[0]!.date.due_at, `${dateText} in "${source}"`).toBeNull();
    }
  });

  it("a date_text that is a whole word of the source still resolves", () => {
    const source = "I'll send it Friday.";
    const out = processExtraction(extraction([item("I'll send it Friday", { date_text: "Friday", date_iso: "2026-10-09" })]), {
      ...NY,
      sourceText: source,
      logger: silent,
    });
    expect(out.proposals[0]!.date.due_date).toBe("2026-10-09");
  });
});

describe("round 2: Ask why fragments (rule 7)", () => {
  // REGRESSION GUARD (round 2 N4, rule 7, fixed round 3). Changed in round 6 by lead-developer: instead of
  // rejecting the fragment, the server shows the whole stored text, so the negation is always shown.
  it("a fragment that drops a negation is replaced by the whole stored text", async () => {
    const q = "Why did I keep Provider A over B?";
    const decision: RetrievedDecision = {
      ...DECISION,
      reason_user: "Provider B did not include flood cover, so I kept A.",
      context_facts: [{ text: "Provider B does not include flood cover", evidence_id: "ev-1" }],
    };
    const r = await askWhy(q, [decision], {
      model: askModel(q, {
        answer_found: true,
        decision_ids: ["dec-1"],
        answer_parts: [
          { kind: "source_fact", text: "include flood cover", ref: "ev-1" },
          { kind: "user_reason", text: "include flood cover", ref: "dec-1" },
        ],
      }),
      logger: silent,
    });
    expect(r.parts.map((p) => [p.kind, p.text])).toEqual([
      ["source_fact", "Provider B does not include flood cover"],
      ["user_reason", "Provider B did not include flood cover, so I kept A."],
    ]);
  });
});

describe("round 2: AI-set fields are not user-explicit", () => {
  // REGRESSION GUARD (round 2 N6, fixed round 3): a due_at set by actor 'ai' is stored as inferred (shows Assumed).
  it("an AI edit of due_at is not marked explicit", () => {
    const r = transition(thread("open"), { type: "edit", fields: { due_at: "2026-10-09T03:59:00.000Z" } }, { now: NOW, actor: "ai" });
    expect(r.ok && r.thread?.due_certainty).not.toBe("explicit");
  });
});

/* ------------------------------------------------------------------ */
/* Round 3 findings (all fixed in round 4)                             */
/* ------------------------------------------------------------------ */

describe("round 3: whole-phrase check treats digit groups as part of the number (rule 3)", () => {
  // REGRESSION GUARD (medium, fixed round 4): containsWholePhrase only refused a letter or digit directly next to the match,
  // so "$2,400" is "present" in "$2,400,000" (1,000x smaller) and "10/9" in "10/9/2027" (year lost).
  it("an amount or date that is only the front of a longer number is not present", () => {
    expect(containsWholePhrase("Pay $2,400,000 now", "$2,400")).toBe(false);
    expect(containsWholePhrase("Pay $1,470.50 today", "$1,470")).toBe(false);
    expect(containsWholePhrase("Due 10/9/2027", "10/9")).toBe(false);
  });

  it("the whole amount as written is still present", () => {
    expect(containsWholePhrase("Pay $2,400,000 now", "$2,400,000")).toBe(true);
    expect(containsWholePhrase("Pay $2,400.", "$2,400")).toBe(true);
  });
});

describe("round 3: quote fallback must not turn idioms into due dates (rule 3)", () => {
  // REGRESSION GUARD (high, rule 3, fixed round 4): the round-3 quote fallback (resolveDateFromQuotes) turned
  // "now", "in a sec", "a week" (from "once a week") and a bare "at 5" into due dates. The fallback is removed:
  // a date_text that is not in the source means no due date.
  it.each([["I'm free now"], ["I'll check in a sec"], ["We meet once a week"], ["Call me at 5"]])(
    "%j with an invented date_text gets no due date",
    (source) => {
      const out = processExtraction(extraction([item(source, { date_text: "Tuesday" })]), { ...NY, sourceText: source, logger: silent });
      expect(out.proposals[0]!.date.due_at).toBeNull();
    },
  );

  // Rewritten in round 4 by lead-developer when the fallback was removed; reviewed and accepted by lead-tester.
  // An invented date_text gives no due date even when the quote has a real day phrase. Losing a date is
  // acceptable; inventing one is not. (A correct date_text still resolves: see "a date_text that is a whole word".)
  it("an invented date_text gives no due date even if the quote contains a day phrase", () => {
    const source = "Send it by Friday";
    const out = processExtraction(extraction([item(source, { date_text: "Tuesday" })]), { ...NY, sourceText: source, logger: silent });
    expect(out.proposals[0]!.date).toMatchObject({ due_at: null, due_date: null, due_certainty: "none" });
  });
});

describe("round 3: same-day phrases", () => {
  // REGRESSION GUARD (round 3, fixed round 4): "this morning" in a message dated Mon Oct 5 is Mon Oct 5
  // (forwardDate with a noon reference used to read it as Tue Oct 6).
  it("'this morning' is the written-on day", () => {
    expect(resolveDate({ date_text: "this morning", date_iso: null }, NY).due_date).toBe("2026-10-05");
  });
});

describe("round 3: Ask why clauses that drop a condition or exception (rule 7)", () => {
  // REGRESSION GUARD (medium, fixed round 4): matchFactUnit allowed one comma clause when the rest of the fact has no negation
  // word, so a clause can drop "unless", "except", "provided" or "only if" and say the opposite of the record.
  it.each([
    ["Provider B covers floods, unless you live in zone A", "Provider B covers floods"],
    ["All plans include windshield cover, except Basic", "All plans include windshield cover"],
    ["We'll refund you, provided you cancel by Oct 31", "We'll refund you"],
    ["Flood cover applies, but only if the house is raised", "Flood cover applies"],
  ])("fact %j: clause %j is rejected", (fact, part) => {
    expect(matchFactUnit(part, fact)).toBeNull();
  });

  // Round 5 (lead-developer, reviewed by lead-tester): with the whole-text rule, "$1,740" no longer fuzzy-matches
  // the stored "$1,470" fact and is dropped instead of shown as stored text. Stricter, so accepted.
  it("negation guards hold: curly apostrophes, 'no longer', double negation, stored amount shown", () => {
    expect(matchFactUnit("Provider A is cheaper", "Provider A isn’t cheaper")).toBeNull();
    expect(matchFactUnit("Provider A is cheaper", "Provider A is no longer cheaper")).toBeNull();
    expect(matchFactUnit("we never renew", "It's not that we never renew")).toBeNull();
    // Changed in round 5 by lead-developer (user/tester decision: source_fact must be the whole stored fact):
    // a clause, even one fuzzily matching, is no longer accepted.
    expect(matchFactUnit("Annual premium $1,740", "Annual premium $1,470, renewing Oct 31")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Round 4 findings (all fixed in round 5)                             */
/* ------------------------------------------------------------------ */

describe("round 4: a year written after the day is not dropped (rule 3)", () => {
  // REGRESSION GUARD (round 4, rule 3, fixed round 5): a date_text may not drop a year written after it
  // ("Oct 9" for "Oct 9, 2027" used to resolve to Oct 9, 2026).
  it.each([
    ["Renewal is due Oct 9, 2027.", "Oct 9", "2027-10-09"],
    ["Renew by January 8, 2028.", "January 8", "2028-01-08"],
    ["Due 9 Oct 2027.", "9 Oct", "2027-10-09"],
  ])("%j with date_text %j never resolves to a different year", (source, dateText, written) => {
    const out = processExtraction(extraction([item(source.replace(/\.$/, ""), { date_text: dateText })]), { ...NY, sourceText: source, logger: silent });
    expect([null, written]).toContain(out.proposals[0]!.date.due_date);
  });
});

describe("round 4: values chrono supplies that the source did not state (rule 3)", () => {
  // REGRESSION GUARD (round 4, rule 3, fixed round 5): reference_date is a day, not a time, so relative
  // sub-day phrases keep the day and show no clock time (it used to be computed from an assumed noon).
  it.each([["in 2 hours"], ["now"], ["in a sec"]])("%j sets the written-on day without a clock time", (text) => {
    const r = resolveDate({ date_text: text, date_iso: null }, NY);
    expect(r.due_date).toBe("2026-10-05");
    expect(r.due_time_known).toBe(false);
  });

  // REGRESSION GUARD (round 4, rule 3, fixed round 5): an hour with no AM/PM is inferred, with a
  // "doesn't say AM or PM" line, even when the model agrees.
  it("an AM/PM-ambiguous time is never explicit", () => {
    const r = resolveDate({ date_text: "tomorrow at 5", date_iso: "2026-10-06T05:00:00" }, NY);
    expect(r.due_certainty).toBe("inferred");
  });

  it("a stated meridiem stays as written", () => {
    const r = resolveDate({ date_text: "tomorrow at 5pm", date_iso: "2026-10-06T17:00:00" }, NY);
    expect(r).toMatchObject({ due_at: "2026-10-06T21:00:00.000Z", due_time_known: true });
  });
});

describe("round 4: Ask why clause qualifiers beyond the word list (rule 7)", () => {
  // REGRESSION GUARD (round 4, rule 7, fixed round 5): source_fact must be the whole stored fact, so no
  // clause can drop "only", "when", "as long as", "subject to", "excluding" or a later "now".
  it.each([
    ["Covers floods, only in zone A", "Covers floods"],
    ["Covers floods, when the house is raised", "Covers floods"],
    ["Covers floods, as long as you pay on time", "Covers floods"],
    ["Covers floods, subject to approval", "Covers floods"],
    ["Covers floods, excluding basements", "Covers floods"],
    ["Provider A was cheaper; Provider B is now cheaper", "Provider A was cheaper"],
  ])("fact %j: clause %j is rejected", (fact, part) => {
    expect(matchFactUnit(part, fact)).toBeNull();
  });

  it("listed qualifiers and temporal words are honoured", () => {
    expect(matchFactUnit("Cover ends Oct 31", "Cover ends Oct 31 unless renewed")).toBeNull();
    expect(matchFactUnit("the premium is $1,470", "If you renew, the premium is $1,470")).toBeNull();
    expect(matchFactUnit("Provider A was cheaper", "Provider A was cheaper. That changed")).toBeNull();
    expect(matchFactUnit("Provider A is cheaper", "Provider A is cheaper but slower")).toBeNull();
  });
});
