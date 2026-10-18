import type { LanguageModel } from "ai";
import { createRecordedModel } from "./fake";

/**
 * Provider-agnostic model selection. The provider and model are config values
 * (`AI_PROVIDER`, `AI_MODEL`, PRD "Model choice"); nothing outside this file names a provider.
 *
 * No real provider is registered yet: the choice is pending (Questions #1, D15). To add one,
 * install its `@ai-sdk/*` package and register a factory here, e.g.
 *   registerProvider("<name>", (modelId) => <name>(modelId));
 * Model IDs are never passed as bare strings, so nothing is routed to a gateway implicitly.
 *
 * `AI_PROVIDER=fake` serves recorded fixtures (tests, E2E, DEMO_REPLAY) and never touches the network.
 */

export type ModelFactory = (modelId: string) => LanguageModel;

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

const registry = new Map<string, ModelFactory>([["fake", (modelId) => createRecordedModel({ modelId })]]);

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
  return { model: factory(modelId), provider, modelId, label: `${provider}:${modelId}` };
}
