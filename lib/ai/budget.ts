import { wrapLanguageModel, type LanguageModel } from "ai";
import type { RpcDb } from "@/lib/extraction/service";
import { log as defaultLog, type Logger } from "@/lib/log";

/**
 * The global daily AI spend cap, DAILY_AI_BUDGET_USD (PRD Technical Architecture "Rate limiting";
 * D62 keeps it). Migration 20261104120000_ai_budget.sql holds the spend.
 *
 * withBudget() wraps the model so that every call (each attempt, including the one retry D43
 * allows) first asks the database whether today's (UTC) spend is still below the cap, and after it
 * returns records its estimated cost from the token counts the provider reports. A refused call
 * makes no request and throws AiBudgetError, which classifyAiError() reports as kind "budget"
 * (not retried). Users see the existing copy: `extraction_failed` or `ask_failed`, never
 * `rate_limited`, which names the user's own daily limit (same reasoning as D43 and D54).
 *
 * The cap is checked before a call and spend recorded after, so calls already in flight when the
 * cap is reached can finish: the day's spend can pass the cap by at most those calls.
 *
 * Fails closed: with a live provider, a missing or invalid DAILY_AI_BUDGET_USD, or a check that
 * cannot be read, refuses the call. Only the fake recorded provider (tests, E2E, CI) runs without a
 * cap when the variable is unset.
 */

/**
 * Estimated price in US dollars per million tokens: Google's Jan 1, 2027 paid-tier rate for
 * gemini-3.6-flash (https://aistudio.google.com/docs/pricing, read Nov 3, 2026; output includes
 * thinking). Until Dec 31, 2026 the list is $0.75 / $3.75, so the estimate errs towards stopping early.
 * Re-check when AI_MODEL or Google's list changes.
 */
export const PRICE_USD_PER_MTOK = { input: 1.5, output: 7.5 } as const;

/** Mirrors private.ai_max_call_cost_micros() in the migration; a call with no usage report is charged this. */
export const MAX_CALL_COST_MICROS = 200_000;

export type BudgetConfig =
  | { mode: "off" }
  | { mode: "cap"; budgetMicros: number }
  | { mode: "refuse"; reason: "unset" | "invalid" };

const USD = /^\d{1,7}(\.\d{1,6})?$/;

export function budgetConfig(env: Record<string, string | undefined> = process.env): BudgetConfig {
  const raw = env.DAILY_AI_BUDGET_USD?.trim() ?? "";
  if (raw === "") {
    const provider = env.AI_PROVIDER?.trim() ?? "";
    // The fake provider spends nothing; any other configured provider is live and needs a cap.
    return provider === "" || provider === "fake" ? { mode: "off" } : { mode: "refuse", reason: "unset" };
  }
  if (!USD.test(raw)) return { mode: "refuse", reason: "invalid" };
  return { mode: "cap", budgetMicros: Math.round(Number(raw) * 1_000_000) };
}

/** Estimated cost of one call in micro-dollars; unknown token counts are charged the per-call maximum. */
export function costMicros(inputTokens: number | undefined, outputTokens: number | undefined): number {
  if (inputTokens === undefined || outputTokens === undefined || !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
    return MAX_CALL_COST_MICROS;
  }
  const usd = (Math.max(0, inputTokens) * PRICE_USD_PER_MTOK.input + Math.max(0, outputTokens) * PRICE_USD_PER_MTOK.output) / 1_000_000;
  return Math.min(MAX_CALL_COST_MICROS, Math.ceil(usd * 1_000_000));
}

export type BudgetRefusal = "exhausted" | "unset" | "invalid" | "check_failed";

export class AiBudgetError extends Error {
  constructor(readonly reason: BudgetRefusal) {
    super("AI budget refused the call");
    this.name = "AiBudgetError";
  }
}

export interface BudgetOptions {
  /** Which feature made the call (logs only). */
  feature: "extract" | "ask";
  env?: Record<string, string | undefined>;
  logger?: Logger;
}

/** The model with the budget applied, or the same model when no cap applies (fake provider, unset). */
export function withBudget(model: LanguageModel, db: RpcDb, opts: BudgetOptions): LanguageModel {
  const cfg = budgetConfig(opts.env);
  if (cfg.mode === "off") return model;
  const logger = opts.logger ?? defaultLog;
  const refuse = (reason: BudgetRefusal): never => {
    logger("ai_budget_refused", { feature: opts.feature, reason });
    throw new AiBudgetError(reason);
  };

  async function ensureOpen(): Promise<void> {
    if (cfg.mode === "refuse") refuse(cfg.reason);
    if (cfg.mode !== "cap") return;
    let open: unknown;
    try {
      const { data, error } = await db.rpc("ai_budget_open", { p_budget_micros: cfg.budgetMicros });
      open = error ? null : data;
    } catch {
      open = null;
    }
    if (open === null || typeof open !== "boolean") refuse("check_failed");
    if (open === false) refuse("exhausted");
  }

  async function record(micros: number): Promise<void> {
    try {
      const { data, error } = await db.rpc("record_ai_cost", { p_cost_micros: micros });
      if (error || data !== true) logger("ai_budget_record_failed", { feature: opts.feature, reason: error ? "error" : "refused" });
    } catch {
      logger("ai_budget_record_failed", { feature: opts.feature, reason: "error" });
    }
  }

  if (typeof model === "string") {
    // A gateway model id cannot be wrapped; every provider here returns a model object (lib/ai/provider.ts).
    throw new AiBudgetError("check_failed");
  }
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        await ensureOpen();
        const result = await doGenerate();
        await record(costMicros(result.usage.inputTokens.total, result.usage.outputTokens.total));
        return result;
      },
      // Nothing here streams; a streamed call would bypass the record step, so it is refused.
      wrapStream: async () => refuse("check_failed"),
    },
  });
}
