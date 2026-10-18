import { describe, expect, it, vi } from "vitest";
import { askWhy, NO_RECORD_MESSAGE, type RetrievedDecision } from "@/lib/ai/askWhy";
import { extract, ExtractionFailedError, type ExtractInput } from "@/lib/ai/extract";
import { createRecordedModel, NoRecordingError } from "@/lib/ai/fake";
import { AiConfigError, getModel } from "@/lib/ai/provider";
import { loadPrompt } from "@/lib/ai/prompts";
import { processExtraction } from "@/lib/pipeline/proposals";

const input = (sourceText: string, over: Partial<ExtractInput> = {}): ExtractInput => ({
  sourceText,
  sourceKind: "paste",
  referenceDate: "2026-10-05",
  referenceDateSource: "user",
  timezone: "America/New_York",
  user: { displayName: "Sam", aliases: ["sam@example.com"] },
  ...over,
});

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";

describe("provider selection", () => {
  it("requires AI_PROVIDER and AI_MODEL and only accepts registered providers", () => {
    expect(() => getModel({})).toThrow(AiConfigError);
    expect(() => getModel({ AI_PROVIDER: "fake" })).toThrow(AiConfigError);
    expect(() => getModel({ AI_PROVIDER: "some-vendor", AI_MODEL: "x" })).toThrow(/not registered/);
    expect(getModel({ AI_PROVIDER: "fake", AI_MODEL: "recorded" }).label).toBe("fake:recorded");
  });
});

describe("prompts", () => {
  it("strips the comment header from versioned prompt files", () => {
    expect(loadPrompt("extract.v1")).not.toContain("prompt: extract.v1");
    expect(loadPrompt("extract.v1")).toMatch(/^You read one message/);
    expect(loadPrompt("ask-why.v1")).toMatch(/^You answer a user's question/);
  });
});

describe("extract() with the recorded fake model", () => {
  it("returns validated output and the trace fields an extractions row needs (F5)", async () => {
    const run = await extract(input(MIKE), { model: createRecordedModel(), modelLabel: "fake:recorded", logger: () => {} });
    expect(run).toMatchObject({ model: "fake:recorded", promptVersion: "extract.v1", schemaVersion: "extraction.v1", attempts: 1 });
    expect(run.inputTokens).toBeGreaterThan(0);
    expect(run.outputTokens).toBeGreaterThan(0);
    expect(run.latencyMs).toBeGreaterThanOrEqual(0);
    expect(run.output.items).toHaveLength(3);
    // matches_thread_id not in the provided list is cleared
    expect(run.output.items[2]!.matches_thread_id).toBeNull();
    expect(run.raw.items[2]!.matches_thread_id).toBe("not-a-real-thread");
  });

  it("end to end through the pipeline: hallucinated item dropped, proposal Likely, dates re-resolved", async () => {
    const run = await extract(input(MIKE), { model: createRecordedModel(), logger: () => {} });
    const out = processExtraction(run.output, {
      sourceText: MIKE,
      referenceDate: "2026-10-05",
      referenceDateSource: "user",
      timezone: "America/New_York",
      logger: () => {},
    });
    expect(out.droppedItemIndexes).toEqual([2]); // "Call the insurer" is not in the source
    expect(out.unverifiedQuoteCount).toBe(1);
    const [proposal, lunch] = out.proposals;
    expect(proposal).toMatchObject({ band: "high", label: { word: "Likely", reason: "Clear commitment with a date." } });
    expect(proposal!.date).toMatchObject({ due_date: "2026-10-09", due_certainty: "explicit" });
    expect(lunch!.band).toBe("low"); // PRD Question #11 option (b): no hedge penalty for intentions
    expect(lunch!.label?.word).toBe("Also noticed");
  });

  it("retries once on malformed output, then succeeds", async () => {
    const logger = vi.fn();
    const run = await extract(input("Acme said they'd pay by the 15th.", { sourceKind: "quick_add" }), { model: createRecordedModel(), logger });
    expect(run.attempts).toBe(2);
    expect(logger).toHaveBeenCalledWith("extraction_retry", expect.any(Object));
  });

  it("fails with extraction_failed after one retry; no partial output", async () => {
    const p = extract(input("This input always gets a malformed response."), { model: createRecordedModel(), logger: () => {} });
    await expect(p).rejects.toBeInstanceOf(ExtractionFailedError);
    await expect(p).rejects.toMatchObject({ code: "extraction_failed", attempts: 2 });
  });

  it("never falls back to anything live when there is no recording", async () => {
    const model = createRecordedModel();
    const p = extract(input("An input nobody recorded."), { model, logger: () => {} });
    await expect(p).rejects.toBeInstanceOf(ExtractionFailedError);
    expect(model.doGenerateCalls).toHaveLength(2);
    await expect(model.doGenerate(model.doGenerateCalls[0]!)).rejects.toBeInstanceOf(NoRecordingError);
  });

  it("rejects input over 30,000 characters before calling the model", async () => {
    const model = createRecordedModel();
    await expect(extract(input("x".repeat(30_001)), { model })).rejects.toBeInstanceOf(RangeError);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("sends source text as a delimited data block", async () => {
    const model = createRecordedModel();
    await extract(input(MIKE), { model, logger: () => {} });
    const user = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(user).toContain("<source>");
    expect(user).toContain("<context>");
  });
});

const DECISIONS: RetrievedDecision[] = [
  {
    id: "dec-1",
    thread_id: "thr-1",
    thread_title: "Home insurance renewal",
    counterparty: "Provider A",
    choice: "Renewed with Provider A",
    reason_user: "The alternatives were more expensive and this policy included windshield coverage.",
    decided_at: "2026-10-18T14:00:00.000Z",
    context_facts: [{ text: "Annual premium $1,470", evidence_id: "ev-1" }],
  },
];

describe("askWhy() (rule 7)", () => {
  it("zero retrieved decisions → fixed message, no LLM call", async () => {
    const model = createRecordedModel();
    const r = await askWhy("Why did I choose this insurance?", [], { model });
    expect(r).toMatchObject({ answer_found: false, message: NO_RECORD_MESSAGE, llm_called: false });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("drops IDs outside the retrieved set and shows only stored text for reasons and facts", async () => {
    const logger = vi.fn();
    const r = await askWhy("Why did I choose this insurance?", DECISIONS, { model: createRecordedModel(), logger });
    expect(r.answer_found).toBe(true);
    expect(r.decision_ids).toEqual(["dec-1"]);
    // The fixture has two user_reason parts (one invented) and two source_fact parts citing ev-1 (one padded):
    // both render as the same stored text and are de-duplicated.
    expect(r.parts.map((p) => [p.kind, p.text])).toEqual([
      ["user_reason", DECISIONS[0]!.reason_user],
      ["source_fact", "Annual premium $1,470"],
      ["inference", "Price and coverage seem to have mattered most."],
    ]);
    expect(r.parts[1]).toMatchObject({ evidence_id: "ev-1", decision_id: "dec-1" });
    expect(logger).toHaveBeenCalledWith("ask_why_ref_rejected", { reason: "decision_id_not_retrieved" });
    expect(logger).toHaveBeenCalledWith("ask_why_ref_rejected", { reason: "ref_not_retrieved" });
  });

  it("a decision-level source_fact ref needs exactly one candidate fact", async () => {
    const two = [{ ...DECISIONS[0]!, context_facts: [{ text: "A", evidence_id: null }, { text: "B", evidence_id: null }] }];
    const logger = vi.fn();
    const model = createRecordedModel({
      recordings: [
        {
          name: "amb",
          task: "ask_why",
          input: "Which fact?",
          responses: [{ answer_found: true, decision_ids: ["dec-1"], answer_parts: [{ kind: "source_fact", text: "x", ref: "dec-1" }] }],
        },
      ],
    });
    const r = await askWhy("Which fact?", two, { model, logger });
    expect(r.parts).toEqual([]);
    expect(logger).toHaveBeenCalledWith("ask_why_ref_rejected", { reason: "source_fact_ref_ambiguous" });
  });

  it("an answer citing only unretrieved decisions becomes the no-record answer", async () => {
    const r = await askWhy("Why did I pick the blue car?", DECISIONS, { model: createRecordedModel(), logger: () => {} });
    expect(r).toMatchObject({ answer_found: false, parts: [], message: NO_RECORD_MESSAGE, llm_called: true });
  });
});
