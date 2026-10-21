import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordedModel, Recording } from "@/lib/ai/fake";
import type { LogEvent, LogProps } from "@/lib/log";
import { ProposalPayload } from "@/lib/extraction/payload";
import { charCountBucket, validateEvent } from "@/lib/analytics/events";
import { MAX_RETRIES_PER_SOURCE, readExtraction, retryExtraction, runExtraction, startExtraction, type CompletedExtraction, type RpcDb } from "@/lib/extraction/service";
import { asUser } from "./pglite";
import { migratedDb, rpcAs } from "./pglite";

/**
 * S2 (F2 → F5): the extraction service against the real migrations in PGlite, with recorded
 * (synthetic) model responses. No network, no live model.
 */

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

const recording = (name: string) =>
  Recording.parse(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "llm", `${name}.extract.json`), "utf8")));
const MIKE = recording("mike-email");
const MALFORMED = recording("always-malformed");

const SECRET_SOURCE = "Quokka ledger: I'll send the quokka ledger to Priya on Friday.";
const SECRET_RAW = '{"items": "quokka-raw-marker"}';
const LEAKY: Recording = { name: "leaky", task: "extract", input: SECRET_SOURCE, responses: [SECRET_RAW] };

const IGNORE_TEXT = "Maybe I could look at the budget next month.";
const IGNORE: Recording = {
  name: "ignore-band",
  task: "extract",
  input: IGNORE_TEXT,
  responses: [
    {
      source_summary: "Note",
      participants: [],
      items: [
        {
          type: "commitment", title: "Look at the budget", owner: "user", counterparty: null, action: null,
          date_text: null, date_iso: null, amount_text: null, certainty: "speculative", uncertainty_notes: [],
          matches_thread_id: null, evidence: [{ quote: "Maybe I could look at the budget", speaker: null }],
        },
      ],
      brief: null,
    },
  ],
};

const model = (...recs: Recording[]) => createRecordedModel({ recordings: recs });
const NOW = new Date("2026-10-05T15:00:00Z");

let pg: PGlite;
let dbA: RpcDb;
let dbB: RpcDb;

type Spy = ReturnType<typeof vi.fn<(event: LogEvent, props: LogProps) => void>>;
let logger: Spy;

beforeEach(async () => {
  pg = await migratedDb();
  await pg.exec(`insert into auth.users values ('${A}', 'sam@example.com', '{"full_name":"Sam"}'), ('${B}', 'b@example.com', '{}')`);
  dbA = rpcAs(pg, A);
  dbB = rpcAs(pg, B);
  logger = vi.fn<(event: LogEvent, props: LogProps) => void>();
});

async function submit(db: RpcDb, text: string, writtenOn: string | null = "2026-10-05", title: string | null = null) {
  const res = await startExtraction(db, { text, title, writtenOn }, { now: NOW, logger });
  if (!res.ok) throw new Error(`start failed: ${res.error.error.code}`);
  return res;
}

const q = async <T,>(sql: string) => (await pg.query<T>(sql)).rows;

describe("submit → extract → persist", () => {
  it("stores the source, a traced extraction and items for every band with versioned payloads", async () => {
    const { sourceId, extractionId } = await submit(dbA, MIKE.input!, "2026-10-05", "Mike thread");
    const [src] = await q<{ kind: string; title: string; text_content: string; reference_date: string; reference_date_source: string }>(
      `select kind, title, text_content, reference_date::text, reference_date_source from sources where id = '${sourceId}'`,
    );
    expect(src).toEqual({ kind: "paste", title: "Mike thread", text_content: MIKE.input, reference_date: "2026-10-05", reference_date_source: "user" });
    const [running] = await q<{ status: string; stage: string }>(`select status, stage from extractions where id = '${extractionId}'`);
    expect(running).toEqual({ status: "running", stage: "reading" });

    const outcome = await runExtraction(dbA, extractionId, { model: model(MIKE), modelLabel: "fake:recorded", logger });
    expect(outcome).toBe("succeeded");

    const [ex] = await q<Record<string, unknown>>(
      `select status, stage, model, prompt_version, schema_version, input_tokens, output_tokens, latency_ms, error,
              jsonb_array_length(raw_output -> 'items') as raw_items from extractions where id = '${extractionId}'`,
    );
    expect(ex).toMatchObject({ status: "succeeded", stage: null, model: "fake:recorded", prompt_version: "extract.v1", schema_version: "extraction.v1", error: null, raw_items: 3 });
    expect(ex!.input_tokens).toBeGreaterThan(0);
    expect(ex!.output_tokens).toBeGreaterThan(0);
    expect(ex!.latency_ms).not.toBeNull();

    const items = await q<{ band: string; confidence: string; item_index: number; payload: unknown; suppression_hash: string }>(
      `select band, confidence::text, item_index, payload, suppression_hash from extraction_items where extraction_id = '${extractionId}' order by item_index`,
    );
    expect(items.map((i) => [i.item_index, i.band, i.confidence])).toEqual([
      [0, "high", "0.95"],
      [1, "low", "0.35"],
    ]);
    for (const i of items) expect(i.suppression_hash).toMatch(/^[0-9a-f]{64}$/);

    const commitment = ProposalPayload.parse(items[0]!.payload);
    expect(commitment.v).toBe(1);
    expect(commitment.item.title).toBe("Send revised proposal to Mike");
    expect(commitment.evidence[0]).toMatchObject({ quote: "I'll send you the revised proposal Friday", match_kind: "exact", start_offset: 14 });
    expect(commitment.date).toMatchObject({ due_date: "2026-10-09", due_certainty: "explicit" });
    expect(commitment.label).toEqual({ word: "Likely", reason: "Clear commitment with a date." });
    expect("evidence" in commitment.item).toBe(false);
    expect(ProposalPayload.parse(items[1]!.payload).label?.word).toBe("Also noticed");

    const ev = await q<{ n: number }>(`select count(*)::int as n from evidence where source_id = '${sourceId}' and extraction_item_id is not null`);
    expect(ev[0]!.n).toBe(2);

    const view = await readExtraction(dbA, extractionId, { now: NOW });
    expect(view).toMatchObject({ status: "succeeded", stage: null, slow: false, error: null });
    expect(view!.proposals.map((p) => p.band)).toEqual(["high", "low"]);
  });

  it("stores Ignore-band items but never returns them", async () => {
    const { extractionId } = await submit(dbA, IGNORE_TEXT);
    expect(await runExtraction(dbA, extractionId, { model: model(IGNORE), logger })).toBe("succeeded");
    const rows = await q<{ band: string; confidence: string }>(`select band, confidence::text from extraction_items where extraction_id = '${extractionId}'`);
    expect(rows).toEqual([{ band: "ignore", confidence: "0.20" }]);
    const view = await readExtraction(dbA, extractionId, { now: NOW });
    expect(view!.proposals).toEqual([]);
  });

  it("defaults the written-on date to today in the user's timezone (defaulted)", async () => {
    await pg.exec(`update profiles set timezone = 'Pacific/Auckland' where id = '${A}'`);
    const { sourceId } = await submit(dbA, MIKE.input!, null);
    const [src] = await q<{ d: string; s: string }>(`select reference_date::text as d, reference_date_source as s from sources where id = '${sourceId}'`);
    // 15:00 UTC on Oct 5 is already Oct 6 in Auckland.
    expect(src).toEqual({ d: "2026-10-06", s: "defaulted" });
  });

  it("drops an unverified quote's item and logs quote_unverified (rule 1)", async () => {
    const { extractionId } = await submit(dbA, MIKE.input!);
    await runExtraction(dbA, extractionId, { model: model(MIKE), logger });
    expect(logger.mock.calls.some(([event]) => event === "quote_unverified")).toBe(true);
    const titles = await q<{ t: string }>(`select payload -> 'item' ->> 'title' as t from extraction_items where extraction_id = '${extractionId}'`);
    expect(titles.map((r) => r.t)).not.toContain("Call the insurer");
    const quotes = await q<{ quote: string }>(`select quote from evidence`);
    expect(quotes.map((r) => r.quote).join("\n")).not.toMatch(/insurer/);
  });
});

describe("failure", () => {
  it("keeps the source, marks the attempt failed and writes no items", async () => {
    const { sourceId, extractionId } = await submit(dbA, MALFORMED.input!);
    expect(await runExtraction(dbA, extractionId, { model: model(MALFORMED), logger })).toBe("failed");

    const [src] = await q<{ text_content: string }>(`select text_content from sources where id = '${sourceId}'`);
    expect(src!.text_content).toBe(MALFORMED.input);
    const [ex] = await q<{ status: string; stage: string | null; error: string }>(`select status, stage, error from extractions where id = '${extractionId}'`);
    expect(ex).toEqual({ status: "failed", stage: null, error: "ai_malformed" });
    expect((await q<{ n: number }>(`select count(*)::int as n from extraction_items`))[0]!.n).toBe(0);
    expect((await q<{ n: number }>(`select count(*)::int as n from evidence`))[0]!.n).toBe(0);

    const view = await readExtraction(dbA, extractionId, { now: NOW });
    expect(view!.error).toEqual({ code: "extraction_failed", message: "Something went wrong reading this. Your text is saved.", retryable: true });
    expect(view!.proposals).toEqual([]);
  });

  it("a failed save part-way through rolls back every item (nothing partial)", async () => {
    const { extractionId } = await submit(dbA, MIKE.input!);
    const corrupting: RpcDb = {
      rpc: (fn, args) => {
        if (fn !== "complete_extraction") return dbA.rpc(fn, args);
        const items = (args.p_items as Array<Record<string, unknown>>).map((it, i) => (i === 1 ? { ...it, band: "bogus" } : it));
        return dbA.rpc(fn, { ...args, p_items: items });
      },
    };
    expect(await runExtraction(corrupting, extractionId, { model: model(MIKE), logger })).toBe("failed");
    expect((await q<{ n: number }>(`select count(*)::int as n from extraction_items`))[0]!.n).toBe(0);
    expect((await q<{ n: number }>(`select count(*)::int as n from evidence`))[0]!.n).toBe(0);
    const [ex] = await q<{ status: string; error: string }>(`select status, error from extractions where id = '${extractionId}'`);
    expect(ex).toEqual({ status: "failed", error: "persist_failed" });
  });

  it("the logger never sees the model's raw text or the source text (rule 9); the row keeps raw text for debugging", async () => {
    const { extractionId } = await submit(dbA, SECRET_SOURCE);
    expect(await runExtraction(dbA, extractionId, { model: model(LEAKY), logger })).toBe("failed");
    const logged = JSON.stringify(logger.mock.calls);
    expect(logger.mock.calls.map(([e]) => e)).toContain("extraction_failed");
    expect(logged).not.toMatch(/quokka/i);
    const [ex] = await q<{ raw: string }>(`select raw_output #>> '{}' as raw from extractions where id = '${extractionId}'`);
    expect(ex!.raw).toContain("quokka-raw-marker");
  });

  it("Try again starts a new attempt on the same source without counting again (A3)", async () => {
    const { sourceId, extractionId } = await submit(dbA, MALFORMED.input!);
    await runExtraction(dbA, extractionId, { model: model(MALFORMED), logger });
    const before = (await q<{ n: number }>(`select extractions as n from usage_counters where user_id = '${A}'`))[0]!.n;

    const retry = await retryExtraction(dbA, extractionId, { logger });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.extractionId).not.toBe(extractionId);
    // A double click returns the attempt already started.
    expect(retry.alreadyStarted).toBe(false);
    expect(await retryExtraction(dbA, extractionId, { logger })).toEqual({ ok: true, extractionId: retry.extractionId, alreadyStarted: true });
    const after = (await q<{ n: number }>(`select extractions as n from usage_counters where user_id = '${A}'`))[0]!.n;
    expect(after).toBe(before);
    const rows = await q<{ status: string; stage: string }>(`select status, stage from extractions where source_id = '${sourceId}' order by created_at, id`);
    expect(rows).toHaveLength(2);

    // A running attempt cannot be retried.
    expect((await retryExtraction(dbA, retry.extractionId, { logger })).ok).toBe(false);
  });
});

describe("rate limit, suppression, staleness, isolation", () => {
  it("the 31st submission in a UTC day is rate_limited and stores nothing", async () => {
    for (let i = 0; i < 30; i++) await submit(dbA, `Note ${i}`);
    const res = await startExtraction(dbA, { text: "Note 31", title: null, writtenOn: null }, { now: NOW, logger });
    expect(res).toEqual({
      ok: false,
      error: { error: { code: "rate_limited", message: "You've reached today's limit of 30 sources. It resets at midnight (UTC).", retryable: false } },
    });
    expect((await q<{ n: number }>(`select count(*)::int as n from sources`))[0]!.n).toBe(30);
  });

  it("does not re-propose an item whose hash is suppressed, and blanks the model's copy", async () => {
    const first = await submit(dbA, MIKE.input!);
    await runExtraction(dbA, first.extractionId, { model: model(MIKE), logger });
    const [hit] = await q<{ h: string }>(`select suppression_hash as h from extraction_items where band = 'high'`);
    await pg.exec(`insert into suppressions (user_id, suppression_hash, reason) values ('${A}', '${hit!.h}', 'forgotten')`);

    const again = await submit(dbA, MIKE.input!);
    expect(await runExtraction(dbA, again.extractionId, { model: model(MIKE), logger })).toBe("succeeded");
    const titles = await q<{ t: string; h: string }>(
      `select payload -> 'item' ->> 'title' as t, suppression_hash as h from extraction_items where extraction_id = '${again.extractionId}'`,
    );
    expect(titles.map((r) => r.t)).toEqual(["Lunch with Mike"]);
    const [raw] = await q<{ first: unknown }>(`select raw_output -> 'items' -> 0 as first from extractions where id = '${again.extractionId}'`);
    expect(raw!.first).toBeNull();
  });

  it("a poll marks a running attempt older than 90 s failed (A2); a late result is then not written", async () => {
    const { extractionId } = await submit(dbA, MIKE.input!);
    const created = new Date((await q<{ c: string }>(`select created_at::text as c from extractions where id = '${extractionId}'`))[0]!.c);

    const at = (ms: number) => new Date(created.getTime() + ms);
    expect(await readExtraction(dbA, extractionId, { now: at(44_000) })).toMatchObject({ status: "running", slow: false, stage: "reading" });
    expect(await readExtraction(dbA, extractionId, { now: at(46_000) })).toMatchObject({ status: "running", slow: true });
    expect(await readExtraction(dbA, extractionId, { now: at(45_000) })).toMatchObject({ status: "running", slow: true });
    expect(await readExtraction(dbA, extractionId, { now: at(89_000) })).toMatchObject({ status: "running" });
    // Exactly 90 s is still running (strict "older than 90 s"). Exact boundaries live here: the
    // live tests can no longer fake the clock (migration 20261021131140).
    expect(await readExtraction(dbA, extractionId, { now: at(90_000) })).toMatchObject({ status: "running" });
    const stale = await readExtraction(dbA, extractionId, { now: at(91_000) });
    expect(stale).toMatchObject({ status: "failed", stage: null, error: { code: "extraction_failed" } });
    expect((await q<{ e: string }>(`select error as e from extractions where id = '${extractionId}'`))[0]!.e).toBe("timeout");

    expect(await runExtraction(dbA, extractionId, { model: model(MIKE), logger })).toBe("skipped");
    expect((await q<{ n: number }>(`select count(*)::int as n from extraction_items`))[0]!.n).toBe(0);
  });

  it("another user's extraction is not found and cannot be retried, run or completed", async () => {
    const { extractionId } = await submit(dbA, MALFORMED.input!);
    expect(await readExtraction(dbB, extractionId, { now: NOW })).toBeNull();
    expect(await retryExtraction(dbB, extractionId, { logger })).toMatchObject({ ok: false, notFound: true });
    expect(await runExtraction(dbB, extractionId, { model: model(MALFORMED), logger })).toBe("skipped");
    const done = await dbB.rpc("complete_extraction", {
      p_extraction_id: extractionId, p_model: "x", p_input_tokens: null, p_output_tokens: null,
      p_latency_ms: null, p_raw_output: null, p_brief: null, p_items: [],
    });
    expect(done.data).toEqual({ ok: false, reason: "not_found" });
    const [ex] = await q<{ status: string }>(`select status from extractions where id = '${extractionId}'`);
    expect(ex!.status).toBe("running");
  });
});

describe("extraction_completed (S1 analytics)", () => {
  const asEvent = (r: CompletedExtraction) => ({
    extraction_id: r.extractionId,
    status: r.status,
    latency_ms: r.latencyMs,
    item_count: r.itemCount,
    band_counts: r.bandCounts,
  });

  it("reports stored items by band on success, and the payload passes the allow-list", async () => {
    const { extractionId } = await submit(dbA, MIKE.input!);
    const onComplete = vi.fn<(r: CompletedExtraction) => void>();
    await runExtraction(dbA, extractionId, { model: model(MIKE), logger, onComplete });
    expect(onComplete).toHaveBeenCalledTimes(1);
    const r = onComplete.mock.calls[0]![0];
    expect(r).toMatchObject({ extractionId, status: "succeeded", itemCount: 2, bandCounts: { high: 1, low: 1 } });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(validateEvent("extraction_completed", asEvent(r)).ok).toBe(true);
    expect(validateEvent("source_submitted", { kind: "paste", char_count_bucket: charCountBucket(MIKE.input!.length) }).ok).toBe(true);
  });

  it("reports failure with zero items; suppressed items are not counted; a timed-out attempt reports nothing", async () => {
    const failed = await submit(dbA, MALFORMED.input!);
    const onFail = vi.fn<(r: CompletedExtraction) => void>();
    await runExtraction(dbA, failed.extractionId, { model: model(MALFORMED), logger, onComplete: onFail });
    expect(onFail.mock.calls.map(([r]) => [r.status, r.itemCount, r.bandCounts])).toEqual([["failed", 0, {}]]);
    expect(validateEvent("extraction_completed", asEvent(onFail.mock.calls[0]![0])).ok).toBe(true);

    const first = await submit(dbA, MIKE.input!);
    await runExtraction(dbA, first.extractionId, { model: model(MIKE), logger });
    const [hit] = await q<{ h: string }>(`select suppression_hash as h from extraction_items where band = 'high'`);
    await pg.exec(`insert into suppressions (user_id, suppression_hash, reason) values ('${A}', '${hit!.h}', 'rejected')`);
    const again = await submit(dbA, MIKE.input!);
    const onAgain = vi.fn<(r: CompletedExtraction) => void>();
    await runExtraction(dbA, again.extractionId, { model: model(MIKE), logger, onComplete: onAgain });
    expect(onAgain.mock.calls[0]![0]).toMatchObject({ status: "succeeded", itemCount: 1, bandCounts: { low: 1 } });

    const stale = await submit(dbA, MIKE.input!);
    await readExtraction(dbA, stale.extractionId, { now: new Date(Date.now() + 91_000) });
    const onStale = vi.fn<(r: CompletedExtraction) => void>();
    expect(await runExtraction(dbA, stale.extractionId, { model: model(MIKE), logger, onComplete: onStale })).toBe("skipped");
    expect(onStale).not.toHaveBeenCalled();
  });

  it("a throwing analytics callback never changes the outcome", async () => {
    const { extractionId } = await submit(dbA, MIKE.input!);
    const outcome = await runExtraction(dbA, extractionId, {
      model: model(MIKE),
      logger,
      onComplete: () => {
        throw new Error("boom");
      },
    });
    expect(outcome).toBe("succeeded");
  });
});

describe("S2 hardening (tester S2-1..S2-5, retry cap, timeout event)", () => {
  const asA = <T,>(sql: string) => asUser(pg, A, () => pg.query<T>(sql));
  const failOnce = async () => {
    const s = await submit(dbA, MALFORMED.input!);
    await runExtraction(dbA, s.extractionId, { model: model(MALFORMED), logger });
    return s;
  };

  it("S2-1a: the owner cannot insert sources or attempts directly; an attempt not made by the pipeline is never retryable or readable", async () => {
    await expect(
      asA(`insert into sources (user_id, kind, text_content, reference_date, reference_date_source) values ('${A}', 'paste', 'Uncounted.', '2026-10-05', 'user')`),
    ).rejects.toThrow(/permission denied/);
    const s = await failOnce();
    await expect(
      asA(`insert into extractions (user_id, source_id, status, model, prompt_version, schema_version) values ('${A}', '${s.sourceId}', 'failed', 'm', 'p', 's')`),
    ).rejects.toThrow(/permission denied/);
    // Second layer, if INSERT were ever granted again: the guard forces via_pipeline = false.
    await pg.exec(`grant insert on extractions to authenticated`);
    const [ex] = (await asA<{ id: string; via_pipeline: boolean }>(
      `insert into extractions (user_id, source_id, status, model, prompt_version, schema_version, via_pipeline) values ('${A}', '${s.sourceId}', 'failed', 'm', 'p', 's', true) returning id, via_pipeline`,
    )).rows;
    await pg.exec(`revoke insert on extractions from authenticated`);
    expect(ex!.via_pipeline).toBe(false);
    expect(await retryExtraction(dbA, ex!.id, { logger })).toMatchObject({ ok: false, notFound: true });
    expect(await readExtraction(dbA, ex!.id, { now: NOW })).toBeNull();
    expect((await q<{ n: number }>(`select extractions as n from usage_counters where user_id = '${A}'`))[0]!.n).toBe(1);
  });

  it("S2-1b/c: the owner cannot update attempts or sources directly", async () => {
    const s = await failOnce();
    await expect(asA(`update extractions set status = 'failed', error = null where id = '${s.extractionId}'`)).rejects.toThrow(/permission denied/);
    await expect(asA(`update sources set text_content = repeat('z', 200000) where id = '${s.sourceId}'`)).rejects.toThrow(/permission denied/);
    await expect(asA(`delete from extractions where id = '${s.extractionId}'`)).rejects.toThrow(/permission denied/);
  });

  it("S2-1b/c second layer: if UPDATE were granted again, the guards still lock pipeline columns", async () => {
    const s = await failOnce();
    await pg.exec(`grant update on extractions, sources to authenticated`);
    try {
      await expect(asA(`update extractions set status = 'failed', error = null where id = '${s.extractionId}'`)).rejects.toThrow(/pipeline only/);
      await expect(asA(`update extractions set stage = 'reading' where id = '${s.extractionId}'`)).rejects.toThrow(/pipeline only/);
      await expect(asA(`update sources set text_content = repeat('z', 200000) where id = '${s.sourceId}'`)).rejects.toThrow(/cannot be replaced/);
      await expect(asA(`update sources set pipeline_attempts = 0 where id = '${s.sourceId}'`)).rejects.toThrow(/pipeline only/);
      await asA(`update sources set text_content = null where id = '${s.sourceId}'`);
    } finally {
      await pg.exec(`revoke update on extractions, sources from authenticated`);
    }
    expect(await retryExtraction(dbA, s.extractionId, { logger })).toMatchObject({ ok: false });
  });

  it("S2-1c: extraction_context never hands over-limit text to extract()", async () => {
    const s = await failOnce();
    await pg.exec(`update sources set text_content = repeat('z', 30001) where id = '${s.sourceId}'`); // superuser: legacy row
    expect(await retryExtraction(dbA, s.extractionId, { logger })).toMatchObject({ ok: false, notFound: false });
    const ctx = await dbA.rpc("extraction_context", { p_extraction_id: s.extractionId });
    expect((ctx.data as { source_text: string | null }).source_text).toBeNull();
  });

  it("S2-2: two runs of one attempt make one model call; the second is skipped", async () => {
    const s = await submit(dbA, MIKE.input!);
    const m = createRecordedModel({ recordings: [{ ...MIKE, delay_ms: 200 }] });
    const outcomes = await Promise.all([0, 1].map(() => runExtraction(dbA, s.extractionId, { model: m, logger })));
    expect(outcomes.sort()).toEqual(["skipped", "succeeded"]);
    expect(m.doGenerateCalls.length).toBe(1);
  });

  it("S2-3: forged proposals and evidence with a quote absent from the source are refused, by any path", async () => {
    const s = await submit(dbA, "Synthetic: we talked about the weather.");
    const forged = {
      item_index: 0, confidence: 0.95, band: "high", suppression_hash: "f",
      payload: { v: 1, evidence: [{ quote: "I will wire $5,000 today" }] },
      evidence: [{ quote: "we talked about the weather", start_offset: 11, end_offset: 38, page: null, match_kind: "exact", quote_hash: "x" }],
    };
    const done = await dbA.rpc("complete_extraction", {
      p_extraction_id: s.extractionId, p_model: "x", p_input_tokens: 0, p_output_tokens: 0, p_latency_ms: 0, p_raw_output: null, p_brief: null, p_items: [forged],
    });
    expect(done.error).toMatchObject({ message: expect.stringMatching(/not in source/) });
    const item = `insert into extraction_items (user_id, extraction_id, payload, confidence, band, item_index) values ('${A}', '${s.extractionId}', '{"evidence":[{"quote":"I will wire money"}]}', 0.9, 'high', 0)`;
    const ev = `insert into evidence (user_id, source_id, quote, match_kind) values ('${A}', '${s.sourceId}', 'I will wire money', 'exact')`;
    // The owner has no direct write at all...
    await expect(asA(item)).rejects.toThrow(/permission denied/);
    await expect(asA(ev)).rejects.toThrow(/permission denied/);
    // ...and the quote triggers refuse any writer, even the table owner.
    await expect(pg.exec(item)).rejects.toThrow(/not in source/);
    await expect(pg.exec(ev)).rejects.toThrow(/not in source/);
    const brief = JSON.stringify({ what_to_do: [{ text: "Wire it", basis: "source", quote: "wire $5,000" }] });
    const bad = await dbA.rpc("complete_extraction", {
      p_extraction_id: s.extractionId, p_model: "x", p_input_tokens: 0, p_output_tokens: 0, p_latency_ms: 0, p_raw_output: null, p_brief: JSON.parse(brief), p_items: [],
    });
    expect(bad.error).not.toBeNull();
    expect((await q<{ n: number }>(`select count(*)::int as n from extraction_items`))[0]!.n).toBe(0);
    // The owner cannot rewrite a pipeline proposal's payload either.
    const real = await submit(dbA, MIKE.input!);
    await runExtraction(dbA, real.extractionId, { model: model(MIKE), logger });
    await expect(asA(`update extraction_items set band = 'high' where band = 'low'`)).rejects.toThrow(/permission denied/);
    await expect(asA(`update extraction_items set review_status = 'rejected' where band = 'low'`)).rejects.toThrow(/permission denied/); // reject_proposals only
  });

  it("S2-5: whitespace-only text with newlines or tabs is refused before counting", async () => {
    const res = await dbA.rpc("start_source_extraction", {
      p_kind: "paste", p_text: " \n\t\n\u00a0", p_title: null, p_reference_date: "2026-10-05", p_now: NOW.toISOString(), p_model: "m", p_prompt_version: "p", p_schema_version: "s",
    });
    expect(res.error).toMatchObject({ code: "22023" });
    expect((await q<{ n: number }>(`select count(*)::int as n from usage_counters`))[0]!.n).toBe(0);
  });

  it(`Try again is capped at ${MAX_RETRIES_PER_SOURCE} per source, and deleting old attempts does not reset it`, async () => {
    const s = await failOnce();
    let latest = s.extractionId;
    for (let i = 0; i < MAX_RETRIES_PER_SOURCE; i++) {
      expect((await readExtraction(dbA, latest, { now: NOW }))!.retryAvailable).toBe(true);
      const r = await retryExtraction(dbA, latest, { logger });
      if (!r.ok) throw new Error("retry refused early");
      latest = r.extractionId;
      await runExtraction(dbA, latest, { model: model(MALFORMED), logger });
    }
    expect((await readExtraction(dbA, latest, { now: NOW }))!.retryAvailable).toBe(false);
    const refused = await retryExtraction(dbA, latest, { logger });
    expect(refused).toMatchObject({ ok: false, error: { error: { code: "retry_limit", retryable: false } } });
    await pg.exec(`delete from extractions where source_id = '${s.sourceId}' and id <> '${latest}'`); // as the owner role: rows gone
    expect((await retryExtraction(dbA, latest, { logger })).ok).toBe(false);
  });

  it("the poll that applies the 90 s rule says so once (timeout event)", async () => {
    const s = await submit(dbA, MIKE.input!);
    const later = new Date(Date.now() + 91_000);
    const first = await readExtraction(dbA, s.extractionId, { now: later });
    const second = await readExtraction(dbA, s.extractionId, { now: later });
    expect(first).toMatchObject({ status: "failed", timedOut: true });
    expect(first!.elapsedMs).toBeGreaterThanOrEqual(90_000);
    expect(second).toMatchObject({ status: "failed", timedOut: false });
  });
});
