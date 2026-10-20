import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvalRpmError, evalRpm, failedGates, quoteHash, renderScorecard, runEval, type EvalReport } from "@/evals/harness";
import { askWhy, type RetrievedDecision } from "@/lib/ai/askWhy";
import { classifyAiError, safeErrorName } from "@/lib/ai/errors";
import { extract } from "@/lib/ai/extract";
import { createRecordedModel } from "@/lib/ai/fake";
import { safeErrorFields } from "@/lib/ai/safeError";
import { Extraction, type Item } from "@/lib/ai/schema";

/**
 * Eval runner fixes (tester B1 + fixture-tester gaps + hardening nits N1, N3, N4, N5).
 * Synthetic data only; MARK stands in for content that must never reach a report or log.
 */

const MARK = "ZQ9-marker";
const RUN_AT = "2026-10-20T00:00:00.000Z";
const usage = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};
const apiErr = (statusCode: number) =>
  new APICallError({ message: `echo ${MARK}`, url: "https://x.invalid", requestBodyValues: { prompt: MARK }, statusCode, isRetryable: statusCode >= 500 || statusCode === 429 });
const broken = () =>
  new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text" as const, text: "{broken" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] }) });
const throwing = (e: () => unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw e();
    },
  });

// Reference date Mon 2026-10-05, America/New_York.
const TEXT = `Synthetic ${MARK}. I'll send Dana the invoice on Friday. We should grab lunch sometime. Ravi will fix the gate. I'll water the plants.`;
const Q = {
  invoice: "I'll send Dana the invoice on Friday.",
  lunch: "We should grab lunch sometime.",
  gate: "Ravi will fix the gate.",
  plants: "I'll water the plants.",
};
type Golden = { type: string; owner: string; quote: string; due_date: string | null; band: string; due_certainty?: string; certainty?: string };
const G: Record<keyof typeof Q, Golden> = {
  invoice: { type: "commitment", owner: "user", quote: Q.invoice, due_date: "2026-10-09", band: "high", due_certainty: "explicit", certainty: "explicit" },
  lunch: { type: "intention", owner: "user", quote: Q.lunch, due_date: null, band: "low", due_certainty: "none", certainty: "speculative" },
  gate: { type: "commitment", owner: "other", quote: Q.gate, due_date: null, band: "high", due_certainty: "none", certainty: "explicit" },
  plants: { type: "commitment", owner: "user", quote: Q.plants, due_date: null, band: "ignore", due_certainty: "none" },
};

const item = (quote: string, o: Partial<Item> = {}): Item => ({
  type: "commitment",
  title: "Synthetic item",
  owner: "user",
  counterparty: null,
  action: null,
  date_text: null,
  date_iso: null,
  amount_text: null,
  certainty: "explicit",
  uncertainty_notes: [],
  matches_thread_id: null,
  evidence: [{ quote, speaker: null }],
  ...o,
});
const response = (items: Item[]) => Extraction.parse({ source_summary: "Synthetic", participants: [], items, brief: null });
const recorded = (byText: Record<string, Item[]>) =>
  createRecordedModel({ recordings: Object.entries(byText).map(([input, items], i) => ({ name: `r${i}`, task: "extract" as const, input, responses: [response(items)] })) });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "le-evalscore-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, items: Golden[], o: { text?: string; ambiguous?: boolean } = {}) {
  mkdirSync(join(dir, name));
  writeFileSync(join(dir, name, "input.txt"), o.text ?? TEXT);
  writeFileSync(join(dir, name, "meta.json"), JSON.stringify({ reference_date: "2026-10-05", timezone: "America/New_York", user: { display_name: "Sam", aliases: [] }, ambiguous: o.ambiguous ?? true }));
  writeFileSync(join(dir, name, "expected.json"), JSON.stringify({ items }));
}
const run = (model: MockLanguageModelV4) => runEval({ fixturesDir: dir, model, modelLabel: "fake:t", runAt: RUN_AT });
const noContent = (r: EvalReport) => {
  const s = JSON.stringify(r) + renderScorecard(r);
  expect(s).not.toContain(MARK);
  for (const q of Object.values(Q)) expect(s).not.toContain(q);
  expect(s).not.toMatch(/invoice|lunch|plants|Dana|Ravi|broken|echo/);
};

/** The perfect model for TEXT. */
const perfect = () => [
  item(Q.invoice, { date_text: "on Friday", date_iso: "2026-10-09" }),
  item(Q.lunch, { type: "intention", certainty: "speculative" }),
  item(Q.gate, { owner: "other" }),
];

describe("B1: failed fixtures cannot pass", () => {
  it("all fixtures malformed → fail, complete false, golden items counted as missed (recall 0)", async () => {
    for (const n of ["a", "b"]) fixture(n, [G.invoice, G.gate]);
    const r = await run(broken());
    expect(r.scores.extraction_failures).toBe(2);
    expect(r.scores.recall).toBe(0);
    expect(r.result).toBe("fail");
    expect(r.pass).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.perFixture[0]).toMatchObject({ ok: false, shown: null, counts: { matched: 0, missed: 2, extra: 0 } });
    expect(renderScorecard(r)).toContain("Result: FAIL");
    expect(failedGates(r.fixtures, r.scores)).toEqual(expect.arrayContaining(["recall", "precision_not_measured", "extraction_failures"]));
    noContent(r);
  });

  it("only quota failures → incomplete_quota, not a pass", async () => {
    fixture("a", [G.invoice]);
    const r = await run(throwing(() => apiErr(429)));
    expect(r).toMatchObject({ result: "incomplete_quota", pass: false, complete: false, failures_by_kind: { quota: 1 } });
    expect(renderScorecard(r)).toContain("Result: INCOMPLETE (quota)");
    noContent(r);
  });

  it("quota plus another failure kind → fail", async () => {
    fixture("a", [G.invoice], { text: `${TEXT} A` });
    fixture("b", [G.invoice], { text: `${TEXT} B` });
    let n = 0;
    const r = await run(throwing(() => (n++ === 0 ? apiErr(429) : apiErr(400))));
    expect(r.failures_by_kind).toEqual({ quota: 1, rejected: 1 });
    expect(r.result).toBe("fail");
  });

  it("one failed fixture among perfect ones still fails the run", async () => {
    fixture("a-good", [G.invoice, G.lunch, G.gate, G.plants]);
    fixture("b-bad", [G.invoice], { text: "Synthetic no recording." });
    const r = await run(recorded({ [TEXT]: perfect() }));
    expect(r.perFixture.map((f) => f.ok)).toEqual([true, false]);
    expect(r.result).toBe("fail");
    expect(r.complete).toBe(false);
  });

  it("a null gated metric is not a pass (nothing golden, nothing predicted)", async () => {
    fixture("empty", [], { text: "Synthetic nothing here." });
    const r = await run(recorded({ "Synthetic nothing here.": [] }));
    expect(r.scores.recall).toBeNull();
    expect(r.pass).toBe(false);
    expect(failedGates(r.fixtures, r.scores)).toContain("recall_not_measured");
  });

  it("no fixtures is not a pass", async () => {
    const r = await run(broken());
    expect(r.pass).toBe(false);
    expect(failedGates(0, r.scores)).toContain("no_fixtures");
  });

  it("the perfect model passes, with per-item detail by index and hash only", async () => {
    fixture("a", [G.invoice, G.lunch, G.gate, G.plants]);
    const r = await run(recorded({ [TEXT]: perfect() }));
    expect(r.scores).toMatchObject({ recall: 1, precision: 1, date: 1, owner: 1, band: 1, due_certainty: 1, type: 1, verified_quotes: 1, false_positive_rate: 0, speculative_scored_high: 0, explicit_dated_scored_low: 0 });
    expect(r).toMatchObject({ result: "pass", pass: true, complete: true });
    expect(r.perFixture[0]!.items.map((i) => [i.status, i.golden_index])).toEqual([
      ["matched", 0],
      ["matched", 1],
      ["matched", 2],
      ["ignore_ok", 3],
    ]);
    expect(r.perFixture[0]!.items[0]!.quote_sha256).toBe(quoteHash(Q.invoice));
    expect(r.perFixture[0]!.items[0]!.quote_sha256).toMatch(/^[0-9a-f]{12}$/);
    noContent(r);
  });
});

describe("runner gaps", () => {
  it("rule 3: a date on a dateless golden is a date error ('invented')", async () => {
    fixture("a", [G.invoice, G.gate]);
    const r = await run(recorded({ [TEXT]: [item(Q.invoice, { date_text: "on Friday", date_iso: "2026-10-09" }), item(Q.gate, { owner: "other", date_text: "on Friday", date_iso: "2026-10-09" })] }));
    expect(r.scores.date).toBe(0.5);
    const gate = r.perFixture[0]!.items.find((i) => i.golden_index === 1)!;
    expect(gate.diffs).toContainEqual({ field: "due_date", error: "invented" });
    expect(r.pass).toBe(false);
    noContent(r);
  });

  it("a dropped date is 'missing'; correct nulls on both sides are not counted", async () => {
    fixture("a", [G.invoice, G.gate]);
    const r = await run(recorded({ [TEXT]: [item(Q.invoice), item(Q.gate, { owner: "other" })] }));
    expect(r.scores.date).toBe(0); // one dated item (invoice), wrong; gate null/null not in the denominator
    expect(r.perFixture[0]!.items[0]!.diffs).toContainEqual({ field: "due_date", error: "missing" });
  });

  it("due_certainty and type are scored with enum-only diffs", async () => {
    fixture("a", [G.invoice, G.gate]);
    const r = await run(recorded({ [TEXT]: [item(Q.invoice, { date_text: "on Friday", date_iso: "2026-10-09" }), item(Q.gate, { owner: "other", type: "request" })] }));
    expect(r.scores.type).toBe(0.5);
    expect(r.scores.due_certainty).toBe(1);
    expect(r.perFixture[0]!.items[1]!.diffs).toContainEqual({ field: "type", expected: "commitment", got: "request" });
  });

  it("F19: a speculative golden scored High is counted and fails the run", async () => {
    // Golden says the gate line is speculative (Also noticed); the model calls it explicit → Likely.
    fixture("a", [G.invoice, { ...G.gate, certainty: "speculative", band: "low" }]);
    const r = await run(recorded({ [TEXT]: [item(Q.invoice, { date_text: "on Friday", date_iso: "2026-10-09" }), item(Q.gate, { owner: "other" })] }));
    expect(r.perFixture[0]!.items[1]!.band).toBe("high");
    expect(r.scores.speculative_scored_high).toBe(1);
    expect(failedGates(r.fixtures, r.scores)).toContain("speculative_scored_high");
    expect(r.pass).toBe(false);
  });

  it("F19: an explicit dated commitment scored Low is counted and fails the run", async () => {
    fixture("a", [G.invoice, G.gate]);
    const r = await run(recorded({ [TEXT]: [item(Q.invoice, { date_text: "on Friday", date_iso: "2026-10-09", certainty: "speculative" }), item(Q.gate, { owner: "other" })] }));
    expect(r.scores.explicit_dated_scored_low).toBe(1);
    expect(failedGates(r.fixtures, r.scores)).toContain("explicit_dated_scored_low");
  });

  it("F19: gated band accuracy covers ambiguous fixtures only; band_all covers every fixture", async () => {
    const PLAIN = `Synthetic plain ${MARK}. Ravi will fix the gate.`;
    fixture("a-amb", [G.invoice, G.lunch, G.gate]);
    fixture("b-plain", [G.gate], { text: PLAIN, ambiguous: false });
    // Ambiguous fixture: all bands right. Plain fixture: gate shown but scored Low (speculative), wrong band.
    const r = await run(recorded({ [TEXT]: perfect(), [PLAIN]: [item(Q.gate, { owner: "other", certainty: "speculative" })] }));
    expect(r.ambiguous_fixtures).toBe(1);
    expect(r.scores.band).toBe(1);
    expect(r.scores.band_all).toBe(0.75);
  });

  it("extras and shown 'ignore' goldens are reported by hash, not text", async () => {
    fixture("a", [G.invoice, G.gate, G.plants]);
    const r = await run(recorded({ [TEXT]: [...perfect(), item(Q.plants)] }));
    const items = r.perFixture[0]!.items;
    expect(items.find((i) => i.golden_index === 2)).toMatchObject({ status: "ignore_shown", diffs: [{ field: "band", expected: "ignore" }] });
    const extra = items.find((i) => i.status === "extra")!;
    expect(extra).toMatchObject({ golden_index: null, quote_sha256: quoteHash(Q.lunch) });
    expect(r.perFixture[0]!.counts).toEqual({ matched: 2, missed: 0, extra: 1, ignore_shown: 1 });
    noContent(r);
  });
});

describe("N1: safeErrorFields and classifyAiError never throw", () => {
  it("throwing name getter", () => {
    const e = new Error("x");
    Object.defineProperty(e, "name", {
      get() {
        throw new Error(`getter ${MARK}`);
      },
    });
    const f = safeErrorFields(e);
    expect(f).toMatchObject({ error: "Error", kind: "unknown" });
    expect(JSON.stringify(f)).not.toContain(MARK);
    expect(classifyAiError(e).kind).toBe("unknown");
  });

  it("Proxy that throws on every trap", () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error(MARK);
        },
        getPrototypeOf: () => {
          throw new Error(MARK);
        },
        has: () => {
          throw new Error(MARK);
        },
      },
    );
    expect(() => safeErrorFields(hostile)).not.toThrow();
    expect(JSON.stringify(safeErrorFields(hostile))).not.toContain(MARK);
    expect(() => classifyAiError(hostile)).not.toThrow();
    expect(safeErrorName(hostile)).toBe("Error");
  });

  it("Error whose prototype getters throw (statusCode, finishReason) still classifies", () => {
    const e = new Error("x");
    Object.defineProperty(e, "message", {
      get() {
        throw new Error(MARK);
      },
    });
    expect(() => safeErrorFields(e)).not.toThrow();
  });
});

describe("N3: extract and askWhy log err.name through the same safe helper", () => {
  const DEC: RetrievedDecision[] = [{ id: "d", thread_id: "t", thread_title: "T", counterparty: null, choice: "c", reason_user: "r", decided_at: RUN_AT, context_facts: [] }];
  const hostileName = () => {
    const e = new Error("x");
    e.name = `name ${MARK} sentence`;
    return e;
  };

  it("askWhy", async () => {
    const logs: unknown[] = [];
    await askWhy("q", DEC, { model: throwing(hostileName), logger: (ev, f) => logs.push([ev, f]) }).catch(() => {});
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(MARK);
    expect(JSON.stringify(logs)).toContain('"error":"Error"');
  });

  it("extract (retry log and the thrown error's cause name)", async () => {
    const logs: unknown[] = [];
    const err = await extract(
      { sourceText: "Synthetic.", sourceKind: "paste", referenceDate: "2026-10-05", referenceDateSource: "user", timezone: "America/New_York", user: { displayName: "Sam", aliases: [] } },
      { model: throwing(hostileName), modelLabel: "fake:t", logger: (ev, f) => logs.push([ev, f]) },
    ).catch((e) => e);
    expect(JSON.stringify(logs)).not.toContain(MARK);
    expect(JSON.stringify(logs)).toContain('"error":"Error"');
    expect(err.causeMessage).toBe("Error");
  });

  it("safeErrorName", () => {
    expect(safeErrorName(new TypeError("x"))).toBe("TypeError");
    expect(safeErrorName(hostileName())).toBe("Error");
    expect(safeErrorName("str")).toBe("non_error_thrown");
  });
});

describe("N5: EVAL_RPM is strict decimal", () => {
  const g = (v: string) => () => evalRpm({ AI_PROVIDER: "google", EVAL_RPM: v });
  it("rejects hex, exponents, signs, units", () => {
    for (const bad of ["0x10", "0b1", "0o7", "1e1", "+5", "-1", ".5", "5.", "5 rpm", "Infinity", "9".repeat(400)]) {
      expect(g(bad), bad).toThrow(EvalRpmError);
      expect(g(bad), bad).toThrow(RangeError);
    }
  });
  it("decimal zero means off; plain decimals pass", () => {
    for (const z of ["0", "00", "0.0", " 000 "]) expect(g(z)()).toBeNull();
    expect(g("12")()).toBe(12);
    expect(g("2.5")()).toBe(2.5);
    expect(g("007")()).toBe(7);
  });
  it("N4: the error message names the variable, not the value", () => {
    expect(g("0x1234abcd")).toThrow(/^EVAL_RPM must be/);
    try {
      g(`5${MARK}`)();
    } catch (e) {
      expect((e as Error).message).not.toContain(MARK);
    }
  });
});

describe("pnpm eval exit code", () => {
  it("an all-failing run (fake provider, no recordings) exits non-zero and does not write SCORECARD.md", () => {
    const empty = mkdtempSync(join(tmpdir(), "le-norec-"));
    try {
      const res = spawnSync("pnpm", ["-s", "exec", "tsx", "evals/run.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, AI_PROVIDER: "fake", AI_MODEL: "golden", AI_RECORDINGS_DIR: empty, EVAL_RESULTS_DIR: empty, EVAL_RPM: "off", EVAL_WRITE_SCORECARD: "" },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Eval FAIL");
      expect(res.stdout).toContain("evals/SCORECARD.md not updated (fake provider)");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 60_000);
});
