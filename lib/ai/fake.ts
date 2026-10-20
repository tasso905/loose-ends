import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { readBlock } from "./prompts";

/**
 * A language model that replays recorded responses (AI_PROVIDER=fake). Used by unit tests,
 * Playwright E2E and DEMO_REPLAY. It never makes a network call: an input with no recording
 * throws NoRecordingError instead of falling back to anything live.
 *
 * Recordings are JSON files (default dir `tests/fixtures/llm`, override with AI_RECORDINGS_DIR):
 *   { "name": "...", "task": "extract" | "ask_why",
 *     "input": "<exact source text or question>"  (or "input_sha256": "<sha256 of it>"),
 *     "responses": [ <JSON object or raw string>, ... ] }
 * The key is the content of the prompt's <source> block (extract) or <question> block (ask_why).
 * Successive calls with the same input step through `responses` (the last one repeats), so a
 * malformed first response followed by a valid one exercises the retry path. An optional
 * `delay_ms` holds each response back, so tests can observe the progress stages of a slow call.
 */

export const Recording = z
  .object({
    name: z.string(),
    task: z.enum(["extract", "ask_why"]),
    input: z.string().optional(),
    input_sha256: z.string().optional(),
    responses: z.array(z.unknown()).min(1),
    delay_ms: z.number().int().min(0).max(120_000).optional(),
  })
  .refine((r) => r.input !== undefined || r.input_sha256 !== undefined, { message: "input or input_sha256 is required" });
export type Recording = z.infer<typeof Recording>;

export class NoRecordingError extends Error {
  constructor(
    readonly task: string,
    readonly inputSha256: string,
  ) {
    super(`No recorded ${task} response for input sha256 ${inputSha256}. Record one in tests/fixtures/llm.`);
    this.name = "NoRecordingError";
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function loadRecordings(dir = process.env.AI_RECORDINGS_DIR || join(process.cwd(), "tests", "fixtures", "llm")): Recording[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((f) => Recording.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))));
}

type PromptMessage = { role: string; content: unknown };

function promptText(prompt: readonly PromptMessage[]): string {
  return prompt
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : Array.isArray(m.content)
          ? m.content.flatMap((p: { type?: string; text?: string }) => (p.type === "text" && p.text ? [p.text] : []))
          : [],
    )
    .join("\n");
}

export function createRecordedModel(opts: { modelId?: string; recordings?: Recording[] } = {}): MockLanguageModelV4 {
  let recordings = opts.recordings;
  const calls = new Map<string, number>();

  return new MockLanguageModelV4({
    provider: "fake",
    modelId: opts.modelId ?? "recorded",
    doGenerate: async (options) => {
      recordings ??= loadRecordings();
      const text = promptText(options.prompt as readonly PromptMessage[]);
      const source = readBlock("source", text);
      const question = readBlock("question", text);
      const task = source !== null ? "extract" : "ask_why";
      const input = source ?? question ?? "";
      const key = sha256(input);
      const rec = recordings.find((r) => r.task === task && (r.input_sha256 ?? sha256(r.input as string)) === key);
      if (!rec) throw new NoRecordingError(task, key);

      const n = calls.get(rec.name) ?? 0;
      calls.set(rec.name, n + 1);
      const response = rec.responses[Math.min(n, rec.responses.length - 1)];
      const out = typeof response === "string" ? response : JSON.stringify(response);
      if (rec.delay_ms) await new Promise((resolve) => setTimeout(resolve, rec.delay_ms));

      return {
        content: [{ type: "text", text: out }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: Math.ceil(text.length / 4), noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: Math.ceil(out.length / 4), text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}
