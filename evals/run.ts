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
 * Output: evals/results/extract-<timestamp>.json (full report) and scorecard-<timestamp>.md
 * (untracked; EVAL_RESULTS_DIR overrides the folder), plus evals/SCORECARD.md (tracked; the public Trust Scorecard). AI_PROVIDER=fake runs
 * do not overwrite evals/SCORECARD.md unless EVAL_WRITE_SCORECARD=1, so replayed recordings are
 * never published as a model's score.
 *
 * Exit codes: 0 pass; 1 fail (a gate missed, any non-quota extraction failure, no fixtures, or a
 * crash); 3 incomplete because only provider quota failed (not a pass, not judged).
 *
 * Ask-why eval (F12, S9): after the extraction fixtures, the 20 questions in evals/ask-why are
 * retrieved with the real F12 query (public.search_decisions over a seeded in-process Postgres) and
 * answered by askWhy() with the same model and throttle; gate 0 fabrications (README.md there).
 * Its report is evals/results/ask-why-<timestamp>.json and its row is in the scorecard. The run
 * passes only if both evals pass; quota-only failures in either make it incomplete (exit 3).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { AiConfigError, getModel } from "@/lib/ai/provider";
import { safeErrorFields } from "@/lib/ai/safeError";
import { getNow } from "@/lib/time";
import { runAskWhyEval } from "./ask-why/harness";
import { pgliteRetriever } from "./ask-why/retrieve";
import { loadAskWhySet } from "./ask-why/set";
import { createThrottle, EvalRpmError, evalRpm, NO_THROTTLE, renderScorecard, runEval } from "./harness";

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

  const throttle = rpm === null ? NO_THROTTLE : createThrottle(rpm);
  const report = await runEval({
    fixturesDir,
    model: resolved.model,
    modelLabel: resolved.label,
    throttle,
    runAt,
  });
  const askSet = loadAskWhySet();
  const retriever = await pgliteRetriever(askSet);
  const ask = await runAskWhyEval({ set: askSet, retrieve: retriever.retrieve, model: resolved.model, modelLabel: resolved.label, throttle }).finally(
    () => retriever.close(),
  );
  if (report.fixtures === 0) {
    console.error("No fixtures in evals/fixtures: nothing was measured, so this is not a pass.");
    process.exit(1);
  }

  const dir = process.env.EVAL_RESULTS_DIR?.trim() || join(process.cwd(), "evals", "results");
  mkdirSync(dir, { recursive: true });
  const stamp = runAt.replace(/[:.]/g, "-");
  const out = join(dir, `extract-${stamp}.json`);
  const card = join(dir, `scorecard-${stamp}.md`);
  const askOut = join(dir, `ask-why-${stamp}.json`);
  const markdown = renderScorecard(report, ask);
  writeFileSync(out, JSON.stringify(report, null, 2));
  writeFileSync(askOut, JSON.stringify(ask, null, 2));
  writeFileSync(card, markdown);
  const isFake = process.env.AI_PROVIDER.trim() === "fake";
  const publicCard = join(process.cwd(), "evals", "SCORECARD.md");
  if (!isFake || process.env.EVAL_WRITE_SCORECARD === "1") writeFileSync(publicCard, markdown);
  console.log(JSON.stringify({ ...report, perFixture: undefined }, null, 2));
  console.log(JSON.stringify({ ask_why: { ...ask, perQuestion: undefined } }, null, 2));
  console.log(`Full report: ${out}\nAsk-why report: ${askOut}\nScorecard: ${card}`);
  console.log(isFake && process.env.EVAL_WRITE_SCORECARD !== "1" ? "evals/SCORECARD.md not updated (fake provider)." : `Public scorecard: ${publicCard}`);

  if (report.result === "fail") {
    console.error(`Eval FAIL${report.scores.extraction_failures ? ` (${report.scores.extraction_failures} extraction failure(s))` : ""}.`);
    process.exit(1);
  }
  if (ask.result === "fail") {
    console.error(`Ask-why eval FAIL (${ask.fabrications} fabrication(s), ${ask.failures} failed call(s)).`);
    process.exit(1);
  }
  if (report.result === "incomplete_quota" || ask.result === "incomplete_quota") {
    console.error(
      `Eval incomplete: quota. ${report.scores.extraction_failures} fixture(s) and ${ask.failures} Ask-why question(s) hit the provider quota, so the run is not judged. Lower EVAL_RPM and re-run.`,
    );
    process.exit(3);
  }
  console.log("Eval PASS.");
}

main().catch((err) => {
  // Rule 9: never print the error object (provider errors carry the request body). Only our own
  // config errors are printed: EvalRpmError names the variable only; AiConfigError names variables
  // and may echo the AI_PROVIDER / AI_MODEL setting, never the API key or any source text.
  if (err instanceof AiConfigError || err instanceof EvalRpmError) console.error(err.message);
  else console.error(JSON.stringify({ event: "eval_failed", ...safeErrorFields(err) }));
  process.exit(1);
});
