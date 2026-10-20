/**
 * Extraction eval (`pnpm eval`). Runs the real extract() + deterministic pipeline over every
 * fixture in evals/fixtures and scores it against the golden output (see evals/harness.ts for the
 * fixture layout and scoring).
 *
 * Uses the configured AI_PROVIDER / AI_MODEL. With a real provider this makes live calls and
 * costs money. AI_PROVIDER=fake replays recordings and only checks the harness itself.
 *
 * Environment: the shell environment wins; `.env.local` (if present) fills only variables that are
 * not already set. Values are never printed. EVAL_RPM throttles provider calls (default
 * DEFAULT_EVAL_RPM for live providers, off for the fake; "0" or "off" disables it).
 *
 * Output: evals/results/extract-<timestamp>.json (full report) and scorecard-<timestamp>.md.
 *
 * Ask-why eval (10 answerable + 10 unanswerable questions) is not wired yet.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { AiConfigError, getModel } from "@/lib/ai/provider";
import { safeErrorFields } from "@/lib/ai/safeError";
import { getNow } from "@/lib/time";
import { createThrottle, evalRpm, NO_THROTTLE, renderScorecard, runEval } from "./harness";

/** Fills unset variables from .env.local; returns how many were filled (names and values stay unprinted). */
function loadEnvLocal(path = join(process.cwd(), ".env.local")): number {
  if (!existsSync(path)) return 0;
  let filled = 0;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      filled++;
    }
  }
  return filled;
}

async function main() {
  const filled = loadEnvLocal();
  if (filled) console.log(`Filled ${filled} unset variable(s) from .env.local.`);
  if (!process.env.AI_PROVIDER || !process.env.AI_MODEL) {
    console.error("Set AI_PROVIDER and AI_MODEL. A real provider makes live calls and costs money.");
    process.exit(2);
  }
  const fixturesDir = join(process.cwd(), "evals", "fixtures");
  const resolved = getModel();
  const rpm = evalRpm(process.env);
  const runAt = getNow().toISOString();

  const report = await runEval({
    fixturesDir,
    model: resolved.model,
    modelLabel: resolved.label,
    throttle: rpm === null ? NO_THROTTLE : createThrottle(rpm),
    runAt,
  });
  if (report.fixtures === 0) {
    console.log("No fixtures in evals/fixtures yet.");
    return;
  }

  const dir = join(process.cwd(), "evals", "results");
  mkdirSync(dir, { recursive: true });
  const stamp = runAt.replace(/[:.]/g, "-");
  const out = join(dir, `extract-${stamp}.json`);
  const card = join(dir, `scorecard-${stamp}.md`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  writeFileSync(card, renderScorecard(report));
  console.log(JSON.stringify({ ...report, perFixture: undefined }, null, 2));
  console.log(`Full report: ${out}\nScorecard: ${card}`);
  if (!report.complete) console.warn("Incomplete run: some fixtures hit the provider quota. Lower EVAL_RPM and re-run.");
  if (!report.pass) process.exit(1);
}

main().catch((err) => {
  // Rule 9: never print the error object (provider errors carry the request body). Our own config
  // and EVAL_RPM messages name variables, never values, so they are printed.
  if (err instanceof AiConfigError || err instanceof RangeError) console.error(err.message);
  else console.error(JSON.stringify({ event: "eval_failed", ...safeErrorFields(err) }));
  process.exit(1);
});
