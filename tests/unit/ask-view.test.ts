import { describe, expect, it } from "vitest";
import { NO_RECORD_MESSAGE, type AskWhyAnswer, type RetrievedDecision } from "@/lib/ai/askWhy";
import { answerView } from "@/lib/decisions/ask";
import { AskInput } from "@/lib/decisions/view";
import { apiError } from "@/lib/errors";

/** S9 F12: the Ask input and the answer view built from stored fields only (rule 6, rule 7, D33, D54). */

const D1: RetrievedDecision = {
  id: "d1",
  thread_id: "t1",
  thread_title: "Car insurance renewal",
  counterparty: "Northwind Mutual",
  choice: "Renewed with Northwind",
  reason_user: "  Cheaper,\nand windshield cover.  ",
  decided_at: "2026-10-18T14:05:00+00:00",
  context_facts: [
    { text: "Premium $1,284", evidence_id: "e1" },
    { text: "Renews Nov 30", evidence_id: "e2" },
  ],
};
const D2: RetrievedDecision = { ...D1, id: "d2", thread_id: "t2", choice: "Kept the rate", reason_user: null, context_facts: [] };

const answer = (over: Partial<AskWhyAnswer>): AskWhyAnswer => ({
  answer_found: true,
  decision_ids: [],
  parts: [],
  message: null,
  llm_called: true,
  model: "x",
  promptVersion: "ask-why.v2",
  schemaVersion: "ask-why.v1",
  inputTokens: null,
  outputTokens: null,
  latencyMs: 0,
  ...over,
});

describe("answerView()", () => {
  it("not found → the no-record message and nothing else", () => {
    expect(answerView(answer({ answer_found: false, message: NO_RECORD_MESSAGE }), [D1])).toEqual({
      found: false,
      message: NO_RECORD_MESSAGE,
      decisions: [],
      interpretations: [],
    });
  });

  it("the whole stored reason is shown verbatim for each cited decision, even when the model gave no user_reason part", () => {
    const v = answerView(answer({ decision_ids: ["d1"] }), [D1]);
    expect(v.decisions[0]!.reason_user).toBe(D1.reason_user);
  });

  it("groups stored facts and interpretations by decision, in order, without duplicates; loose interpretations stay separate", () => {
    const v = answerView(
      answer({
        decision_ids: ["d1", "d2"],
        parts: [
          { kind: "source_fact", text: "Renews Nov 30", decision_id: "d1", evidence_id: "e2" },
          { kind: "source_fact", text: "Renews Nov 30", decision_id: "d1", evidence_id: "e2" },
          { kind: "source_fact", text: "Not a stored fact", decision_id: "d1", evidence_id: null },
          { kind: "inference", text: "Price mattered.", decision_id: "d1", evidence_id: null },
          { kind: "inference", text: "Both were about cost.", decision_id: null, evidence_id: null },
          { kind: "user_reason", text: "Cheaper", decision_id: "d1", evidence_id: null },
        ],
      }),
      [D1, D2],
    );
    expect(v.decisions.map((d) => [d.id, d.reason_user, d.facts, d.interpretations])).toEqual([
      ["d1", D1.reason_user, ["Renews Nov 30"], ["Price mattered."]],
      ["d2", null, [], []],
    ]);
    expect(v.interpretations).toEqual(["Both were about cost."]);
  });

  it("a cited decision that was not retrieved is never shown; nothing left → no-record message", () => {
    expect(answerView(answer({ decision_ids: ["d9"] }), [D1])).toMatchObject({ found: false, message: NO_RECORD_MESSAGE });
  });

  it("a whitespace-only stored reason is the no-reason state", () => {
    expect(answerView(answer({ decision_ids: ["d1"] }), [{ ...D1, reason_user: "   " }]).decisions[0]!.reason_user).toBeNull();
  });
});

describe("AskInput", () => {
  it.each([
    ["  Why did I renew?  ", "Why did I renew?"],
    ["x".repeat(300), "x".repeat(300)],
    ["😀".repeat(300), "😀".repeat(300)],
  ])("accepts %#", (q, out) => {
    expect(AskInput.parse({ question: q }).question).toBe(out);
  });

  it.each([[""], ["   "], ["x".repeat(301)], [42], [null]])("refuses %#", (q) => {
    expect(AskInput.safeParse({ question: q }).success).toBe(false);
  });
});

describe("ask_failed (D54)", () => {
  it("has the approved copy and is retryable", () => {
    expect(apiError("ask_failed")).toEqual({ error: { code: "ask_failed", message: "I couldn't answer that just now. Try asking again.", retryable: true } });
  });
});
