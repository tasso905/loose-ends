import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordedModel, Recording } from "@/lib/ai/fake";
import type { LogEvent, LogProps } from "@/lib/log";
import { ProposalPayload } from "@/lib/extraction/payload";
import { readExtraction, retryExtraction, runExtraction, startExtraction, type RpcDb } from "@/lib/extraction/service";
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
    expect(await retryExtraction(dbA, extractionId, { logger })).toEqual({ ok: true, extractionId: retry.extractionId });
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
    expect(await readExtraction(dbA, extractionId, { now: at(89_000) })).toMatchObject({ status: "running" });
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
