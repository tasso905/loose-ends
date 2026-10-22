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
 * Ask-why eval (10 answerable + 10 unanswerable questions) is not wired yet (F12, slice S9). The
 * question set, its format and the fabrication judge are in evals/ask-why (see its README.md).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { AiConfigError, getModel } from "@/lib/ai/provider";
import { safeErrorFields } from "@/lib/ai/safeError";
import { getNow } from "@/lib/time";
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

  const report = await runEval({
    fixturesDir,
    model: resolved.model,
    modelLabel: resolved.label,
    throttle: rpm === null ? NO_THROTTLE : createThrottle(rpm),
    runAt,
  });
  if (report.fixtures === 0) {
    console.error("No fixtures in evals/fixtures: nothing was measured, so this is not a pass.");
    process.exit(1);
  }

  const dir = process.env.EVAL_RESULTS_DIR?.trim() || join(process.cwd(), "evals", "results");
  mkdirSync(dir, { recursive: true });
  const stamp = runAt.replace(/[:.]/g, "-");
  const out = join(dir, `extract-${stamp}.json`);
  const card = join(dir, `scorecard-${stamp}.md`);
  const markdown = renderScorecard(report);
  writeFileSync(out, JSON.stringify(report, null, 2));
  writeFileSync(card, markdown);
  const isFake = process.env.AI_PROVIDER.trim() === "fake";
  const publicCard = join(process.cwd(), "evals", "SCORECARD.md");
  if (!isFake || process.env.EVAL_WRITE_SCORECARD === "1") writeFileSync(publicCard, markdown);
  console.log(JSON.stringify({ ...report, perFixture: undefined }, null, 2));
  console.log(`Full report: ${out}\nScorecard: ${card}`);
  console.log(isFake && process.env.EVAL_WRITE_SCORECARD !== "1" ? "evals/SCORECARD.md not updated (fake provider)." : `Public scorecard: ${publicCard}`);

  if (report.result === "incomplete_quota") {
    console.error(
      `Eval incomplete: quota. ${report.scores.extraction_failures} fixture(s) hit the provider quota, so the run is not judged. Lower EVAL_RPM and re-run.`,
    );
    process.exit(3);
  }
  if (!report.pass) {
    console.error(`Eval FAIL${report.scores.extraction_failures ? ` (${report.scores.extraction_failures} extraction failure(s))` : ""}.`);
    process.exit(1);
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
