import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { createRecordedModel } from "./fake";

/**
 * Provider-agnostic model selection. The provider and model are config values
 * (`AI_PROVIDER`, `AI_MODEL`, PRD "Model choice"); nothing outside this file names a provider.
 *
 * Registered providers:
 *  - `fake`: serves recorded fixtures (tests, E2E, DEMO_REPLAY) and never touches the network.
 *  - `google`: Google Gemini via `@ai-sdk/google` (D42). The key comes from our generic
 *    `AI_API_KEY` and is passed explicitly, so `GOOGLE_GENERATIVE_AI_API_KEY` is never read.
 *    `AI_MODEL` must be an exact model ID (e.g. `gemini-3.5-flash`); moving aliases such as
 *    `gemini-flash-latest` are refused (case-insensitively) so eval results stay reproducible.
 *
 * Model IDs are never passed as bare strings to the AI SDK, so nothing is routed to a gateway
 * implicitly. The API key is never logged or included in an error message.
 */

export type ModelFactory = (modelId: string, env: Record<string, string | undefined>) => LanguageModel;

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

function googleModel(modelId: string, env: Record<string, string | undefined>): LanguageModel {
  if (/(^|-)latest$/i.test(modelId)) {
    throw new AiConfigError(`AI_MODEL "${modelId}" is a moving alias. Pin an exact model ID, e.g. gemini-3.5-flash.`);
  }
  const apiKey = env.AI_API_KEY?.trim();
  if (!apiKey) throw new AiConfigError("AI_API_KEY is not set.");
  return createGoogleGenerativeAI({ apiKey })(modelId);
}

const registry = new Map<string, ModelFactory>([
  ["fake", (modelId) => createRecordedModel({ modelId })],
  ["google", googleModel],
]);

export function registerProvider(name: string, factory: ModelFactory): void {
  registry.set(name, factory);
}

export interface ResolvedModel {
  model: LanguageModel;
  provider: string;
  modelId: string;
  /** Recorded on each extraction as `extractions.model`. */
  label: string;
}

export function getModel(env: Record<string, string | undefined> = process.env): ResolvedModel {
  const provider = env.AI_PROVIDER?.trim();
  const modelId = env.AI_MODEL?.trim();
  if (!provider) throw new AiConfigError("AI_PROVIDER is not set.");
  if (!modelId) throw new AiConfigError("AI_MODEL is not set.");
  const factory = registry.get(provider);
  if (!factory) throw new AiConfigError(`AI_PROVIDER "${provider}" is not registered in lib/ai/provider.ts.`);
  return { model: factory(modelId, env), provider, modelId, label: `${provider}:${modelId}` };
}
