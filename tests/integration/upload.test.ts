import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordedModel, Recording } from "@/lib/ai/fake";
import { readDocument, type ReadDocument } from "@/lib/capture/document";
import { readExtraction, retryExtraction, runExtraction, startUploadExtraction, type RpcDb, type UploadStartInput } from "@/lib/extraction/service";
import type { LogEvent, LogProps } from "@/lib/log";
import { renewalPdf } from "../fixtures/documents";
import { asUser, migratedDb, rpcAs } from "./pglite";

/**
 * S6 / S7 (F3 → F5 → F7) against the real migrations in PGlite, with the recorded (synthetic)
 * renewal-notice response. No network, no live model. The storage object is inserted directly as
 * the owner, standing in for the browser upload under storage RLS.
 */

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const SRC = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NOW = new Date("2026-10-05T15:00:00Z");

const RENEWAL = Recording.parse(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "llm", "renewal-pdf.extract.json"), "utf8")));
const model = () => createRecordedModel({ recordings: [RENEWAL] });

let pg: PGlite;
let dbA: RpcDb;
let dbB: RpcDb;
let doc: ReadDocument;
const logger = vi.fn<(event: LogEvent, props: LogProps) => void>();
const q = async <T,>(sql: string) => (await pg.query<T>(sql)).rows;
const putObject = (path: string) => pg.exec(`insert into storage.objects (bucket_id, name) values ('sources', '${path}')`);

beforeEach(async () => {
  pg = await migratedDb();
  await pg.exec(`insert into auth.users values ('${A}', 'sam@example.com', '{"full_name":"Sam"}'), ('${B}', 'b@example.com', '{}')`);
  dbA = rpcAs(pg, A);
  dbB = rpcAs(pg, B);
  const r = await readDocument(renewalPdf(), "Renewal notice.pdf");
  if (!r.ok) throw new Error("fixture not read");
  doc = r;
  logger.mockReset();
});

const input = (over: Partial<UploadStartInput> = {}): UploadStartInput => ({
  sourceId: SRC,
  text: doc.text,
  title: "Renewal notice",
  writtenOn: "2026-10-05",
  mimeType: doc.mimeType,
  pageOffsets: doc.pageOffsets,
  ...over,
});

describe("start_upload_extraction", () => {
  it("stores an upload source with its file path, type and page map, and a running extraction", async () => {
    await putObject(`${A}/${SRC}`);
    const res = await startUploadExtraction(dbA, input(), { now: NOW, logger });
    expect(res.ok).toBe(true);
    const [src] = await q<Record<string, unknown>>(
      `select kind, title, storage_path, mime_type, page_offsets, reference_date::text as ref, pipeline_attempts from sources where id = '${SRC}'`,
    );
    expect(src).toEqual({
      kind: "upload",
      title: "Renewal notice",
      storage_path: `${A}/${SRC}`,
      mime_type: "application/pdf",
      page_offsets: doc.pageOffsets,
      ref: "2026-10-05",
      pipeline_attempts: 1,
    });
    const [usage] = await q<{ extractions: number }>(`select extractions from usage_counters where user_id = '${A}'`);
    expect(usage?.extractions).toBe(1);
  });

  it("refuses when the file is not in the caller's folder, and counts nothing", async () => {
    await putObject(`${B}/${SRC}`); // someone else's folder
    const res = await startUploadExtraction(dbA, input(), { now: NOW, logger });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.error.code).toBe("save_failed");
    expect(await q(`select 1 from sources`)).toHaveLength(0);
    expect(await q(`select 1 from usage_counters`)).toHaveLength(0);
  });

  it("refuses a bad page map, page offsets on text, an unknown type and over-long text", async () => {
    await putObject(`${A}/${SRC}`);
    for (const bad of [
      input({ pageOffsets: [5, 10] }),
      input({ pageOffsets: [0, 9_999_999] }),
      input({ pageOffsets: [0, 40, 20] }),
      input({ pageOffsets: null }),
      input({ pageOffsets: Array.from({ length: 31 }, (_, i) => i) }),
      input({ mimeType: "text/plain" }),
      input({ mimeType: "text/html" as UploadStartInput["mimeType"], pageOffsets: null }),
      input({ text: "x".repeat(30_001), pageOffsets: [0] }),
    ]) {
      const res = await startUploadExtraction(dbA, bad, { now: NOW, logger });
      expect(res.ok).toBe(false);
    }
    expect(await q(`select 1 from sources`)).toHaveLength(0);
  });

  it("a text upload has no page map", async () => {
    await putObject(`${A}/${SRC}`);
    const res = await startUploadExtraction(dbA, input({ mimeType: "text/markdown", pageOffsets: null, text: "# Notes\nCall Ana Friday." }), { now: NOW, logger });
    expect(res.ok).toBe(true);
    const [src] = await q<{ mime_type: string; page_offsets: unknown }>(`select mime_type, page_offsets from sources`);
    expect(src).toEqual({ mime_type: "text/markdown", page_offsets: null });
  });

  it("the same source id cannot be used twice", async () => {
    await putObject(`${A}/${SRC}`);
    expect((await startUploadExtraction(dbA, input(), { now: NOW, logger })).ok).toBe(true);
    expect((await startUploadExtraction(dbA, input(), { now: NOW, logger })).ok).toBe(false);
  });

  it("direct inserts into sources stay revoked: an upload row only comes from the function", async () => {
    await expect(
      asUser(pg, A, () =>
        pg.query(
          `insert into public.sources (user_id, kind, text_content, storage_path, reference_date, reference_date_source)
           values ('${A}', 'upload', 'x', '${A}/${SRC}', '2026-10-05', 'user')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("upload → extract → Explain card brief", () => {
  it("runs the pipeline: quotes verified with pages, the brief stored verified with pages", async () => {
    await putObject(`${A}/${SRC}`);
    const started = await startUploadExtraction(dbA, input(), { now: NOW, logger });
    if (!started.ok) throw new Error("start failed");
    expect(await runExtraction(dbA, started.extractionId, { model: model(), modelLabel: "fake:recorded", logger })).toBe("succeeded");

    const [ev] = await q<{ quote: string; page: number }>(`select quote, page from evidence`);
    expect(ev).toEqual({ quote: "To cancel or change your cover, call us before October 31, 2026.", page: 2 });

    const view = await readExtraction(dbA, started.extractionId, { now: NOW });
    expect(view?.proposals).toHaveLength(1);
    expect(view?.proposals[0]?.band).toBe("high");
    expect(view?.proposals[0]?.payload.date.due_date).toBe("2026-10-31");
    const brief = view?.brief as Record<string, Array<{ basis: string; quote: string | null; page?: number | null }>>;
    expect(brief.what_this_is?.[0]).toMatchObject({ basis: "source", quote: "Policy renewal notice for policy HM-000-TEST", page: 1 });
    expect(brief.by_when?.[0]).toMatchObject({ basis: "source", page: 1 });
    expect(brief.if_you_dont?.[0]).toMatchObject({ basis: "source", page: 2 });
    expect(brief.what_to_do?.map((l) => l.basis)).toEqual(["source", "interpretation"]);
  });

  it("another user cannot read the upload's extraction", async () => {
    await putObject(`${A}/${SRC}`);
    const started = await startUploadExtraction(dbA, input(), { now: NOW, logger });
    if (!started.ok) throw new Error("start failed");
    expect(await readExtraction(dbB, started.extractionId, { now: NOW })).toBeNull();
    expect(await rpcAs(pg, B).rpc("extraction_context", { p_extraction_id: started.extractionId })).toMatchObject({ data: null });
  });

  it("Try again works for an upload source", async () => {
    await putObject(`${A}/${SRC}`);
    const started = await startUploadExtraction(dbA, input(), { now: NOW, logger });
    if (!started.ok) throw new Error("start failed");
    await dbA.rpc("fail_extraction", { p_extraction_id: started.extractionId, p_error: "ai_test", p_model: null, p_latency_ms: null, p_raw_output: null });
    const retry = await retryExtraction(dbA, started.extractionId);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(await runExtraction(dbA, retry.extractionId, { model: model(), modelLabel: "fake:recorded", logger })).toBe("succeeded");
  });
});
