import { inspect } from "node:util";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askWhy, NO_RECORD_MESSAGE, type RetrievedDecision } from "@/lib/ai/askWhy";
import { AskWhyFailedError } from "@/lib/ai/errors";
import { extract, ExtractionFailedError, type ExtractInput } from "@/lib/ai/extract";
import { AiConfigError, getModel } from "@/lib/ai/provider";
import { processExtraction } from "@/lib/pipeline/proposals";

/**
 * Lead-tester independent checks for D42 (Gemini via @ai-sdk/google). No live calls: every test
 * either injects a mock model or stubs `fetch` and asserts what would have gone over the wire.
 * All data is synthetic.
 */

const KEY = "tester-fake-key-ZZZZ-0000-not-real";
const SOURCE = "Synthetic: Dana wrote that she will send the zoning memo on Friday. Unique-marker-QX7.";
const QUESTION = "Why did I pick the synthetic vendor marker-QQ9?";
const REASON = "Synthetic reason marker-RR3 that must never be logged.";

const input = (sourceText = SOURCE): ExtractInput => ({
  sourceText,
  sourceKind: "paste",
  referenceDate: "2026-10-05", // Monday
  referenceDateSource: "user",
  timezone: "America/New_York",
  user: { displayName: "Sam", aliases: [] },
});

const item = (over: Record<string, unknown> = {}) => ({
  type: "commitment",
  title: "Send zoning memo",
  owner: "other",
  counterparty: "Dana",
  action: null,
  date_text: "on Friday",
  date_iso: "2026-10-09",
  amount_text: null,
  certainty: "explicit",
  uncertainty_notes: [],
  matches_thread_id: null,
  evidence: [{ quote: "she will send the zoning memo on Friday", speaker: "Dana" }],
  ...over,
});
const valid = (over: Record<string, unknown> = {}) => ({ source_summary: "s", participants: [], items: [item()], brief: null, ...over });

const usage = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};
const mockReturning = (...texts: string[]) => {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: texts[Math.min(i++, texts.length - 1)]! }],
      finishReason: { unified: "stop", raw: "STOP" },
      usage,
      warnings: [],
    }),
  });
};

/** A Gemini generateContent success body carrying `obj` as the JSON text part. */
const geminiOk = (obj: unknown) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** A Gemini error body that echoes the request text, as real 400s can. */
const geminiErr = (status: number, echo: string) =>
  new Response(JSON.stringify({ error: { code: status, message: `bad request near: ${echo}`, status: "INVALID_ARGUMENT" } }), {
    status,
    headers: { "content-type": "application/json" },
  });

type Seen = { url: string; key: string | null; body: string };
function stubFetch(respond: (n: number) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), key: new Headers(init.headers).get("x-goog-api-key"), body: String(init.body) });
    return respond(seen.length);
  });
  return seen;
}

const google = () => getModel({ AI_PROVIDER: "google", AI_MODEL: "gemini-3.5-flash", AI_API_KEY: KEY });

/** Everything an error reporter or console could serialize from an error. */
const dump = (e: unknown) => {
  const err = e as Error & { cause?: unknown };
  return [String(err.message), String(err.stack), inspect(err, { depth: 6 }), JSON.stringify(err), String(err.cause ?? "")].join("\n");
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("tester D42: Zod limits still enforced through extract() (stripped keywords only affect the model schema)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["title maxLength 80", valid({ items: [item({ title: "x".repeat(81) })] })],
    ["source_summary maxLength 200", valid({ source_summary: "s".repeat(201) })],
    ["quote minLength 3", valid({ items: [item({ evidence: [{ quote: "ab", speaker: null }] })] })],
    ["quote maxLength 400", valid({ items: [item({ evidence: [{ quote: "q".repeat(401), speaker: null }] })] })],
    ["evidence minItems 1", valid({ items: [item({ evidence: [] })] })],
    ["evidence maxItems 3", valid({ items: [item({ evidence: Array(4).fill({ quote: "she will send", speaker: null }) })] })],
    ["uncertainty_notes maxItems 3", valid({ items: [item({ uncertainty_notes: ["a", "b", "c", "d"] })] })],
    ["items maxItems 12", valid({ items: Array(13).fill(item()) })],
  ];

  it.each(cases)("%s: rejected → retried once → extraction_failed (kind malformed)", async (_name, bad) => {
    const model = mockReturning(JSON.stringify(bad));
    const logger = vi.fn();
    const err = (await extract(input(), { model, logger }).catch((e) => e)) as ExtractionFailedError;
    expect(err).toBeInstanceOf(ExtractionFailedError);
    expect(err).toMatchObject({ code: "extraction_failed", kind: "malformed", attempts: 2 });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(logger).toHaveBeenCalledWith("extraction_retry", expect.objectContaining({ kind: "malformed" }));
  });

  it("out-of-range first answer, valid second answer → success on attempt 2", async () => {
    const model = mockReturning(JSON.stringify(valid({ items: [item({ title: "x".repeat(81) })] })), JSON.stringify(valid()));
    const run = await extract(input(), { model, logger: () => {} });
    expect(run.attempts).toBe(2);
    expect(run.output.items[0]!.title).toBe("Send zoning memo");
  });

  it("same through the real Google provider (fetch stubbed): out-of-range body → two requests → extraction_failed", async () => {
    const seen = stubFetch(() => geminiOk(valid({ items: [item({ evidence: [] })] })));
    const { model, label } = google();
    const err = await extract(input(), { model, modelLabel: label, logger: () => {} }).catch((e) => e);
    expect(err).toMatchObject({ code: "extraction_failed", kind: "malformed", attempts: 2, model: "google:gemini-3.5-flash" });
    expect(seen).toHaveLength(2);
    // The schema sent to Gemini has no constraint keywords but keeps required lists and enums.
    const schema = JSON.stringify((JSON.parse(seen[0]!.body) as { generationConfig: { responseJsonSchema: unknown } }).generationConfig.responseJsonSchema);
    expect(schema).not.toMatch(/"(minLength|maxLength|minItems|maxItems)"/);
    expect(schema).toContain('"required"');
    expect(schema).toContain('"commitment"');
  });
});

describe("tester D42: rule 1 and rule 3 still apply to Gemini output", () => {
  it("a schema-valid item whose quote is not in the source is dropped and logged quote_unverified", async () => {
    stubFetch(() => geminiOk(valid({ items: [item(), item({ title: "Invented", evidence: [{ quote: "she promised a pony by Monday", speaker: null }] })] })));
    const { model, label } = google();
    const run = await extract(input(), { model, modelLabel: label, logger: () => {} });
    const logger = vi.fn();
    const out = processExtraction(run.output, { sourceText: SOURCE, referenceDate: "2026-10-05", referenceDateSource: "user", timezone: "America/New_York", logger });
    expect(out.proposals).toHaveLength(1);
    expect(out.droppedItemIndexes).toEqual([1]);
    expect(logger).toHaveBeenCalledWith("quote_unverified", expect.any(Object));
    expect(JSON.stringify(logger.mock.calls)).not.toContain("pony");
  });

  it("the model's date_iso is overridden by chrono on disagreement (inferred + Not sure about)", async () => {
    stubFetch(() => geminiOk(valid({ items: [item({ date_iso: "2026-10-16" })] }))); // model says next week's Friday
    const { model, label } = google();
    const run = await extract(input(), { model, modelLabel: label, logger: () => {} });
    const out = processExtraction(run.output, { sourceText: SOURCE, referenceDate: "2026-10-05", referenceDateSource: "user", timezone: "America/New_York", logger: () => {} });
    const d = out.proposals[0]!.date;
    expect(d.due_date).toBe("2026-10-09");
    expect(d.agreement).toBe("disagree");
    expect(d.due_certainty).toBe("inferred");
    expect(d.not_sure.length).toBeGreaterThan(0);
  });
});

describe("tester D42: rule 7 with the Google provider configured", () => {
  it("zero retrieved decisions → no-record message, no fetch, no provider config needed", async () => {
    const seen = stubFetch(() => geminiOk({}));
    vi.stubEnv("AI_PROVIDER", "google");
    vi.stubEnv("AI_MODEL", "gemini-3.5-flash");
    vi.stubEnv("AI_API_KEY", ""); // a config error would throw if a model were resolved
    const a = await askWhy(QUESTION, []);
    expect(a).toMatchObject({ answer_found: false, llm_called: false, message: NO_RECORD_MESSAGE });
    expect(seen).toHaveLength(0);
  });

  const DEC: RetrievedDecision[] = [
    { id: "dec-a", thread_id: "t", thread_title: "Synthetic vendor", counterparty: null, choice: "Picked vendor B", reason_user: REASON, decided_at: "2026-10-10T00:00:00.000Z", context_facts: [] },
  ];

  it("IDs outside the retrieved set from Gemini are rejected → no-record", async () => {
    stubFetch(() => geminiOk({ answer_found: true, decision_ids: ["dec-zzz"], answer_parts: [{ kind: "user_reason", text: "made up", ref: "dec-zzz" }] }));
    const { model, label } = google();
    const a = await askWhy(QUESTION, DEC, { model, modelLabel: label, logger: () => {} });
    expect(a).toMatchObject({ answer_found: false, llm_called: true, message: NO_RECORD_MESSAGE });
  });

  it("user_reason text from Gemini is replaced by the stored reason verbatim", async () => {
    stubFetch(() => geminiOk({ answer_found: true, decision_ids: ["dec-a"], answer_parts: [{ kind: "user_reason", text: "paraphrase", ref: "dec-a" }] }));
    const { model, label } = google();
    const a = await askWhy(QUESTION, DEC, { model, modelLabel: label, logger: () => {} });
    expect(a.parts).toEqual([{ kind: "user_reason", text: REASON, decision_id: "dec-a", evidence_id: null }]);
  });
});

describe("tester D42: rule 9, no source/question/key text in errors or logs (real provider, stubbed fetch)", () => {
  it("extract(): a 400 that echoes the source leaves no source or key in the error, its cause, or the log", async () => {
    const seen = stubFetch(() => geminiErr(400, SOURCE));
    const logger = vi.fn();
    const { model, label } = google();
    const err = await extract(input(), { model, modelLabel: label, logger }).catch((e) => e);
    expect(err).toMatchObject({ code: "extraction_failed", kind: "rejected", status: 400, attempts: 1 });
    expect(seen).toHaveLength(1);
    expect((err as Error).cause).toBeUndefined();
    const all = dump(err) + JSON.stringify(logger.mock.calls);
    for (const s of ["Unique-marker-QX7", "zoning", KEY, "bad request near"]) expect(all).not.toContain(s);
  });

  it("extract(): a 401 leaves no key in the error", async () => {
    stubFetch(() => geminiErr(401, "API key not valid"));
    const { model, label } = google();
    const err = await extract(input(), { model, modelLabel: label, logger: () => {} }).catch((e) => e);
    expect(err).toMatchObject({ kind: "config", status: 401, attempts: 1 });
    expect(dump(err)).not.toContain(KEY);
  });

  it("askWhy(): a 400 echoing the question leaves no question, reason or key anywhere", async () => {
    stubFetch(() => geminiErr(400, `${QUESTION} ${REASON}`));
    const logger = vi.fn();
    const { model, label } = google();
    const err = await askWhy(QUESTION, [{ id: "d", thread_id: "t", thread_title: "x", counterparty: null, choice: "c", reason_user: REASON, decided_at: "2026-10-10T00:00:00.000Z", context_facts: [] }], { model, modelLabel: label, logger }).catch((e) => e);
    expect(err).toBeInstanceOf(AskWhyFailedError);
    expect((err as Error).cause).toBeUndefined();
    const all = dump(err) + JSON.stringify(logger.mock.calls);
    for (const s of ["marker-QQ9", "marker-RR3", KEY, "bad request near"]) expect(all).not.toContain(s);
  });

  it("askWhy(): request count on a provider 429 (records the SDK-level retry; maxRetries: 1)", async () => {
    const seen = stubFetch(() => geminiErr(429, "quota"));
    const { model, label } = google();
    const err = await askWhy(QUESTION, [{ id: "d", thread_id: "t", thread_title: "x", counterparty: null, choice: "c", reason_user: null, decided_at: "2026-10-10T00:00:00.000Z", context_facts: [] }], { model, modelLabel: label, logger: () => {} }).catch((e) => e);
    expect(err).toMatchObject({ kind: "quota", status: 429 });
    // Fact for the report: Ask why repeats a quota-exhausted call once; extract() does not.
    expect(seen).toHaveLength(2);
  }, 20_000);
});

describe("tester D42: key and model ID handling", () => {
  it("GOOGLE_GENERATIVE_AI_API_KEY is never a fallback when AI_API_KEY is missing or blank", () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "env-fallback-key");
    for (const k of [undefined, "", "   "]) {
      expect(() => getModel({ AI_PROVIDER: "google", AI_MODEL: "gemini-3.5-flash", AI_API_KEY: k })).toThrow(AiConfigError);
    }
  });

  it("the header carries AI_API_KEY even when GOOGLE_GENERATIVE_AI_API_KEY is set; the key is never in the URL", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "env-fallback-key");
    const seen = stubFetch(() => geminiOk(valid()));
    const { model, label } = google();
    await extract(input(), { model, modelLabel: label, logger: () => {} });
    expect(seen[0]!.key).toBe(KEY);
    expect(seen[0]!.url).not.toContain(KEY);
    expect(seen[0]!.url).not.toContain("env-fallback-key");
  });

  it.each(["gemini-flash-latest", "gemini-2.5-flash-latest", "latest", " gemini-pro-latest "])("refuses moving alias %j", (m) => {
    expect(() => getModel({ AI_PROVIDER: "google", AI_MODEL: m, AI_API_KEY: KEY })).toThrow(AiConfigError);
  });

  it("documents current behaviour for an upper-case alias (regex is case-sensitive)", () => {
    let refused = false;
    try {
      getModel({ AI_PROVIDER: "google", AI_MODEL: "gemini-flash-LATEST", AI_API_KEY: KEY });
    } catch {
      refused = true;
    }
    expect(refused).toBe(false); // reported as a non-blocking gap, not asserted as desired behaviour
  });
});
