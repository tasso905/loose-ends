import { APICallError, NoObjectGeneratedError, zodSchema } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askWhy, type RetrievedDecision } from "@/lib/ai/askWhy";
import { AskWhyFailedError, classifyAiError } from "@/lib/ai/errors";
import { extract, ExtractionFailedError, type ExtractInput } from "@/lib/ai/extract";
import { AiConfigError, getModel } from "@/lib/ai/provider";
import { AskWhyOutput, Extraction, ExtractionModelSchema, MODEL_SCHEMA_STRIPPED_KEYWORDS } from "@/lib/ai/schema";

/**
 * D42: Google Gemini provider wiring, provider-failure classification and the Gemini-compatible
 * model schema. No test here makes a network call: `fetch` is stubbed where the real provider runs.
 */

const SECRET = "test-key-not-real-0123456789";
const SOURCE = "Synthetic: Priya said she'd send the signed lease by the 14th.";

const input = (sourceText = SOURCE): ExtractInput => ({
  sourceText,
  sourceKind: "paste",
  referenceDate: "2026-10-05",
  referenceDateSource: "user",
  timezone: "America/New_York",
  user: { displayName: "Sam", aliases: [] },
});

const DECISIONS: RetrievedDecision[] = [
  {
    id: "dec-1",
    thread_id: "thr-1",
    thread_title: "Synthetic lease renewal",
    counterparty: "Synthetic Landlord",
    choice: "Renewed the lease",
    reason_user: "Synthetic reason that must never reach a log.",
    decided_at: "2026-10-18T14:00:00.000Z",
    context_facts: [],
  },
];

const apiError = (statusCode: number) =>
  new APICallError({ message: "provider said no", url: "https://example.invalid", requestBodyValues: { prompt: SOURCE }, statusCode, isRetryable: statusCode === 429 || statusCode >= 500 });

const usage = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

const throwing = (err: unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw err;
    },
  });

afterEach(() => vi.unstubAllGlobals());

describe("google provider (D42)", () => {
  it("registers google, requires AI_API_KEY and labels runs with the exact model ID", () => {
    expect(() => getModel({ AI_PROVIDER: "google", AI_MODEL: "gemini-3.5-flash" })).toThrow(/AI_API_KEY is not set/);
    const r = getModel({ AI_PROVIDER: "google", AI_MODEL: "gemini-3.5-flash", AI_API_KEY: SECRET });
    expect(r.label).toBe("google:gemini-3.5-flash");
    expect(typeof r.model === "object" && r.model.modelId).toBe("gemini-3.5-flash");
  });

  it("refuses moving -latest aliases so eval results stay reproducible", () => {
    expect(() => getModel({ AI_PROVIDER: "google", AI_MODEL: "gemini-flash-latest", AI_API_KEY: SECRET })).toThrow(AiConfigError);
  });

  it("never echoes the key in a config error", () => {
    try {
      getModel({ AI_PROVIDER: "google", AI_MODEL: "gemini-pro-latest", AI_API_KEY: SECRET });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(SECRET);
    }
  });

  it("sends AI_API_KEY explicitly, ignores GOOGLE_GENERATIVE_AI_API_KEY, and sends a constraint-free schema", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "the-wrong-key");
    const seen: Array<{ url: string; key: string | null; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), key: new Headers(init.headers).get("x-goog-api-key"), body: String(init.body) });
      return new Response(JSON.stringify({ error: { code: 503, message: "stub", status: "UNAVAILABLE" } }), { status: 503 });
    });
    const { model, label } = getModel({ AI_PROVIDER: "google", AI_MODEL: "gemini-3.5-flash", AI_API_KEY: SECRET });
    await expect(extract(input(), { model, modelLabel: label, logger: () => {} })).rejects.toMatchObject({ kind: "unavailable", status: 503, attempts: 2 });
    vi.unstubAllEnvs();

    expect(seen).toHaveLength(2); // one retry for a 5xx, no SDK-level retries (maxRetries: 0)
    expect(seen[0]!.url).toContain("/models/gemini-3.5-flash:generateContent");
    expect(seen[0]!.key).toBe(SECRET);
    expect(seen[0]!.url).not.toContain(SECRET);
    const body = JSON.parse(seen[0]!.body) as { generationConfig: { temperature: number; responseJsonSchema: object } };
    expect(body.generationConfig.temperature).toBe(0);
    const schema = JSON.stringify(body.generationConfig.responseJsonSchema);
    for (const k of MODEL_SCHEMA_STRIPPED_KEYWORDS) expect(schema).not.toContain(`"${k}"`);
    expect(schema).toContain('"additionalProperties":false');
  });
});

describe("model schema: Gemini-compatible JSON, full Zod validation", () => {
  it("strips only constraint keywords; structure, enums and required lists are unchanged", async () => {
    const full = (await zodSchema(Extraction).jsonSchema) as object;
    const sent = (await ExtractionModelSchema.jsonSchema) as object;
    const strip = (o: unknown): unknown =>
      Array.isArray(o)
        ? o.map(strip)
        : o && typeof o === "object"
          ? Object.fromEntries(Object.entries(o).filter(([k]) => !(MODEL_SCHEMA_STRIPPED_KEYWORDS as readonly string[]).includes(k)).map(([k, v]) => [k, strip(v)]))
          : o;
    expect(sent).toEqual(strip(full));
    expect(JSON.stringify(full)).toContain('"maxLength":80'); // the source of truth still has the limits
  });

  it("keeps a property whose NAME is a constraint keyword", async () => {
    const { z } = await import("zod");
    const { modelSchema } = await import("@/lib/ai/schema");
    const js = (await modelSchema(z.object({ maxLength: z.string().max(3) })).jsonSchema) as { properties: Record<string, object> };
    expect(Object.keys(js.properties)).toEqual(["maxLength"]);
    expect(js.properties.maxLength).toEqual({ type: "string" });
  });

  const ok = {
    source_summary: "s",
    participants: [],
    items: [
      {
        type: "commitment", title: "Send lease", owner: "other", counterparty: "Priya", action: null,
        date_text: "by the 14th", date_iso: "2026-10-14", amount_text: null, certainty: "explicit",
        uncertainty_notes: [], matches_thread_id: null,
        evidence: [{ quote: "she'd send the signed lease by the 14th", speaker: null }],
      },
    ],
    brief: null,
  };

  it("still rejects what the stripped keywords used to bound", async () => {
    const v = async (x: unknown) => (await ExtractionModelSchema.validate!(x)) as { success: boolean };
    expect((await v(ok)).success).toBe(true);
    const item = ok.items[0]!;
    expect((await v({ ...ok, items: [{ ...item, title: "x".repeat(81) }] })).success).toBe(false); // maxLength 80
    expect((await v({ ...ok, items: [{ ...item, evidence: [] }] })).success).toBe(false); // minItems 1
    expect((await v({ ...ok, items: [{ ...item, evidence: [{ quote: "ab", speaker: null }] }] })).success).toBe(false); // minLength 3
    expect((await v({ ...ok, items: Array(13).fill(item) })).success).toBe(false); // maxItems 12
    expect((await v({ ...ok, extra: 1 })).success).toBe(true); // Zod object strips unknown keys, as before
  });

  it("an out-of-bounds model response fails extraction (retry, then extraction_failed)", async () => {
    const bad = JSON.stringify({ ...ok, items: [{ ...ok.items[0], title: "x".repeat(81) }] });
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: bad }], finishReason: { unified: "stop", raw: "STOP" }, usage, warnings: [] }),
    });
    await expect(extract(input(), { model, logger: () => {} })).rejects.toMatchObject({ code: "extraction_failed", kind: "malformed", attempts: 2 });
  });

  it("Ask-why output keeps its schema (no constraints to strip)", async () => {
    const { AskWhyModelSchema } = await import("@/lib/ai/schema");
    expect(await AskWhyModelSchema.jsonSchema).toEqual(await zodSchema(AskWhyOutput).jsonSchema);
  });
});

describe("classifyAiError", () => {
  it.each([
    [429, "quota", false],
    [500, "unavailable", true],
    [503, "unavailable", true],
    [400, "rejected", false],
    [401, "config", false],
    [403, "config", false],
    [404, "config", false],
  ])("HTTP %i → %s (retryable %s)", (status, kind, retryable) => {
    expect(classifyAiError(apiError(status))).toEqual({ kind, status, retryable });
  });

  it("safety blocks and malformed output", () => {
    const base = { response: { id: "r", timestamp: new Date(0), modelId: "m" }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as never;
    expect(classifyAiError(new NoObjectGeneratedError({ ...(base as object), finishReason: "content-filter" } as never)).kind).toBe("safety");
    expect(classifyAiError(new NoObjectGeneratedError({ ...(base as object), finishReason: "stop" } as never)).kind).toBe("malformed");
    expect(classifyAiError(new NoObjectGeneratedError({ ...(base as object), finishReason: "length" } as never)).kind).toBe("malformed");
  });

  it("config and unknown", () => {
    expect(classifyAiError(new AiConfigError("x")).kind).toBe("config");
    expect(classifyAiError(new Error("boom"))).toEqual({ kind: "unknown", status: null, retryable: true });
  });
});

describe("extract() provider failures", () => {
  it("429 quota → extraction_failed after ONE call (no retry spends more quota); log has no content", async () => {
    const logger = vi.fn();
    const model = throwing(apiError(429));
    await expect(extract(input(), { model, logger })).rejects.toMatchObject({ code: "extraction_failed", kind: "quota", status: 429, attempts: 1 });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(logger.mock.calls)).not.toContain("Priya");
  });

  it("safety block → extraction_failed, not retried", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [], finishReason: { unified: "content-filter", raw: "SAFETY" }, usage, warnings: [] }),
    });
    const p = extract(input(), { model, logger: () => {} });
    await expect(p).rejects.toBeInstanceOf(ExtractionFailedError);
    await expect(p).rejects.toMatchObject({ kind: "safety", attempts: 1 });
  });

  it("5xx → retried once; the retry log carries IDs and enums only", async () => {
    const logger = vi.fn();
    const model = throwing(apiError(503));
    const err = (await extract(input(), { model, logger, extractionId: "ext-1" }).catch((e) => e)) as ExtractionFailedError;
    expect(err).toMatchObject({ kind: "unavailable", attempts: 2 });
    expect(err.message).not.toContain("Priya");
    expect(err.cause).toBeUndefined();
    expect(logger).toHaveBeenCalledWith("extraction_retry", { extraction_id: "ext-1", error: "AI_APICallError", kind: "unavailable", status: 503 });
  });
});

describe("askWhy() provider failures (rule 9)", () => {
  it("throws AskWhyFailedError with the kind only: no provider message, request body or cause", async () => {
    const logger = vi.fn();
    const err = (await askWhy("Why did I renew?", DECISIONS, { model: throwing(apiError(429)), logger }).catch((e) => e)) as AskWhyFailedError;
    expect(err).toBeInstanceOf(AskWhyFailedError);
    expect(err).toMatchObject({ kind: "quota", status: 429, retryable: false });
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify({ m: err.message, s: err.stack, l: logger.mock.calls })).not.toMatch(/renew|Synthetic|provider said no/);
    expect(logger).toHaveBeenCalledWith("ask_why_failed", expect.objectContaining({ kind: "quota", status: 429 }));
  });
});
