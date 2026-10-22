import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordedModel, Recording } from "@/lib/ai/fake";
import { readDocument } from "@/lib/capture/document";
import { readExtraction, runExtraction, startUploadExtraction, type RpcDb, type UploadStartInput } from "@/lib/extraction/service";
import type { LogEvent, LogProps } from "@/lib/log";
import { CLINIC_TEXT, clinicPdf } from "../fixtures/tester-documents";
import { migratedDb, rpcAs } from "./pglite";

/**
 * Lead-tester S6/S7 checks over the real migrations in PGlite, with an adversarial recorded
 * response (tests/fixtures/llm/tester-clinic-pdf.extract.json) for a 3-page synthetic PDF whose
 * middle page has no text layer. The recording deliberately contains: an item whose quote is not
 * in the source, brief source lines with a fabricated and a fuzzy quote, and interpretation /
 * "Not sure about" / "Worth considering" lines with invented dates and amounts.
 * No network, no live model.
 */

const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b2";
const SRC = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NOW = new Date("2026-10-05T15:00:00Z");

const CLINIC = Recording.parse(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "llm", "tester-clinic-pdf.extract.json"), "utf8")));

let pg: PGlite;
let dbA: RpcDb;
const logger = vi.fn<(event: LogEvent, props: LogProps) => void>();
const q = async <T,>(sql: string) => (await pg.query<T>(sql)).rows;
const putObject = (path: string) => pg.exec(`insert into storage.objects (bucket_id, name) values ('sources', '${path}')`);

beforeEach(async () => {
  pg = await migratedDb();
  await pg.exec(`insert into auth.users values ('${A}', 'a@example.com', '{}'), ('${B}', 'b@example.com', '{}')`);
  dbA = rpcAs(pg, A);
  logger.mockReset();
});

async function clinicInput(over: Partial<UploadStartInput> = {}): Promise<UploadStartInput> {
  const r = await readDocument(clinicPdf(), "Clinic reminder.pdf");
  if (!r.ok) throw new Error("clinic fixture not read");
  return { sourceId: SRC, text: r.text, title: "Clinic reminder", writtenOn: "2026-10-05", mimeType: r.mimeType, pageOffsets: r.pageOffsets, ...over };
}

describe("tester: start_upload_extraction refusals leave nothing behind", () => {
  it("someone else's file at the same source id: refused, no rows, nothing counted", async () => {
    await putObject(`${B}/${SRC}`);
    const res = await startUploadExtraction(dbA, await clinicInput(), { now: NOW, logger });
    expect(res.ok).toBe(false);
    expect(await q(`select 1 from sources`)).toHaveLength(0);
    expect(await q(`select 1 from extractions`)).toHaveLength(0);
    expect(await q(`select 1 from usage_counters`)).toHaveLength(0);
  });

  it("a file nested under the caller's folder does not satisfy the exact-path check", async () => {
    await putObject(`${A}/${SRC}/extra`);
    await putObject(`${A}/sub/${SRC}`);
    const res = await startUploadExtraction(dbA, await clinicInput(), { now: NOW, logger });
    expect(res.ok).toBe(false);
    expect(await q(`select 1 from sources`)).toHaveLength(0);
  });

  it("a file in another bucket at the right name does not count", async () => {
    await pg.exec(`insert into storage.buckets (id, name, public) values ('other', 'other', false) on conflict do nothing`);
    await pg.exec(`insert into storage.objects (bucket_id, name) values ('other', '${A}/${SRC}')`);
    const res = await startUploadExtraction(dbA, await clinicInput(), { now: NOW, logger });
    expect(res.ok).toBe(false);
    expect(await q(`select 1 from usage_counters`)).toHaveLength(0);
  });

  it("at the daily limit (30): rate_limited, no source or extraction row, counter stays 30", async () => {
    await putObject(`${A}/${SRC}`);
    await pg.exec(`insert into usage_counters (user_id, day, extractions) values ('${A}', (now() at time zone 'UTC')::date, 30)`);
    const res = await startUploadExtraction(dbA, await clinicInput(), { now: NOW, logger });
    expect(!res.ok && res.error.error.code).toBe("rate_limited");
    expect(await q(`select 1 from sources`)).toHaveLength(0);
    expect(await q(`select 1 from extractions`)).toHaveLength(0);
    expect((await q<{ extractions: number }>(`select extractions from usage_counters`))[0]?.extractions).toBe(30);
  });

  it("a refused page map counts nothing (the check runs before consume_usage)", async () => {
    await putObject(`${A}/${SRC}`);
    const res = await startUploadExtraction(dbA, await clinicInput({ pageOffsets: [0, 10, 5] }), { now: NOW, logger });
    expect(res.ok).toBe(false);
    expect(await q(`select 1 from usage_counters`)).toHaveLength(0);
  });

  it("a success counts exactly one extraction", async () => {
    await putObject(`${A}/${SRC}`);
    expect((await startUploadExtraction(dbA, await clinicInput(), { now: NOW, logger })).ok).toBe(true);
    expect((await q<{ extractions: number }>(`select extractions from usage_counters`))[0]?.extractions).toBe(1);
  });
});

describe("tester: adversarial PDF brief and items (rules 1, 3, 5)", () => {
  async function run() {
    await putObject(`${A}/${SRC}`);
    const started = await startUploadExtraction(dbA, await clinicInput(), { now: NOW, logger });
    if (!started.ok) throw new Error("start failed");
    const outcome = await runExtraction(dbA, started.extractionId, {
      model: createRecordedModel({ recordings: [CLINIC] }),
      modelLabel: "fake:recorded",
      logger,
    });
    expect(outcome).toBe("succeeded");
    return started.extractionId;
  }

  it("the stored source text is exactly what readDocument produced (the recording input)", async () => {
    await run();
    const [src] = await q<{ text_content: string; page_offsets: number[] }>(`select text_content, page_offsets from sources`);
    expect(src?.text_content).toBe(CLINIC_TEXT);
    expect(src?.page_offsets).toHaveLength(3);
  });

  it("rule 1: the item with an invented quote is dropped and logged; the kept quote is on p. 3 (blank p. 2 counted)", async () => {
    const id = await run();
    const ev = await q<{ quote: string; page: number }>(`select quote, page from evidence`);
    expect(ev).toEqual([{ quote: "Please confirm by phone within 7 days.", page: 3 }]);
    const view = await readExtraction(dbA, id, { now: NOW });
    expect(view?.proposals.map((p) => p.payload.item.title)).toEqual(["Confirm the dental appointment"]);
    expect(logger.mock.calls.filter(([e]) => e === "quote_unverified").length).toBeGreaterThanOrEqual(2); // item + brief line
  });

  it("rule 1: every stored quote (evidence and brief source lines) is a verbatim substring of the source", async () => {
    const id = await run();
    const ev = await q<{ quote: string }>(`select quote from evidence`);
    const view = await readExtraction(dbA, id, { now: NOW });
    const brief = view?.brief as Record<string, Array<{ basis: string; quote: string | null }>>;
    const briefQuotes = Object.entries(brief)
      .filter(([k]) => k !== "not_sure_about")
      .flatMap(([, lines]) => lines.filter((l) => l.basis === "source").map((l) => l.quote));
    for (const quote of [...ev.map((e) => e.quote), ...briefQuotes]) {
      expect(quote).not.toBeNull();
      expect(CLINIC_TEXT.includes(quote!), quote!).toBe(true);
    }
    // The fabricated "final notice" line is gone; the fuzzy one is stored as the source's own words.
    expect(briefQuotes).not.toContain("This is your final notice before cancellation.");
    expect(brief.if_you_dont?.find((l) => l.basis === "source")).toMatchObject({
      quote: "A missed appointment fee of $45 applies without 24 hours notice.",
      page: 3,
    });
  });

  it("rule 3: interpretation, Worth considering and Not sure about lines with invented dates or amounts are dropped and logged", async () => {
    const id = await run();
    const view = await readExtraction(dbA, id, { now: NOW });
    const brief = view?.brief as Record<string, Array<{ text: string; basis: string }>> & { not_sure_about: string[] };
    expect(brief.what_to_do?.map((l) => l.text)).toEqual(["Call the clinic to confirm."]);
    expect(brief.if_you_dont?.filter((l) => l.basis === "interpretation")).toEqual([]);
    expect(brief.worth_considering).toEqual([]);
    expect(brief.not_sure_about).toEqual(["Whether the clinic accepts email confirmations"]);
    const dropped = logger.mock.calls.filter(([e]) => e === "brief_line_unverified").map(([, p]) => `${p.brief_section}:${p.claim}`);
    expect(dropped.sort()).toEqual(["if_you_dont:amount", "not_sure_about:date", "what_to_do:date", "worth_considering:date"].sort());
    // The log carries ids, enums and counts only, never the line's text (rule 9).
    for (const [, p] of logger.mock.calls.filter(([e]) => e === "brief_line_unverified")) {
      expect(Object.values(p).some((v) => typeof v === "string" && /clinic|fee|November|December/i.test(v))).toBe(false);
    }
  });

  it("rule 5: every kept non-source line is stored as basis interpretation with no quote", async () => {
    const id = await run();
    const view = await readExtraction(dbA, id, { now: NOW });
    const brief = view?.brief as Record<string, Array<{ basis: string; quote: string | null }>>;
    for (const [k, lines] of Object.entries(brief)) {
      if (k === "not_sure_about") continue;
      for (const l of lines) if (l.basis === "interpretation") expect(l.quote).toBeNull();
    }
  });
});
