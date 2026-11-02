import { describe, expect, it } from "vitest";
import { cleanText, joinPages, readDocument, sniffType } from "@/lib/capture/document";
import { formatFileSize, parseUploadForm, UPLOAD_COPY, uploadFailure } from "@/lib/capture/uploadInput";
import { pageForOffset } from "@/lib/pipeline/normalize";
import { GOVERNMENT_PAGES, governmentPdf, pdfText, RENEWAL_PAGES, renewalPdf, scannedPdf, UTILITY_PAGES, utilityPdf } from "../fixtures/documents";
import { imagePdf, textPdf } from "../fixtures/pdf";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("sniffType: from the bytes, never the name (SITE_CONTRACT §2.2)", () => {
  it("PDF, text, ZIP and binary", () => {
    expect(sniffType(renewalPdf())).toBe("pdf");
    expect(sniffType(bytes("Hello\nworld"))).toBe("text");
    expect(sniffType(Uint8Array.from([0x50, 0x4b, 3, 4, 1, 2]))).toBe("zip");
    expect(sniffType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe("unknown"); // JPEG
    expect(sniffType(Uint8Array.from([0xc3, 0x28]))).toBe("unknown"); // invalid UTF-8
  });

  it("a PDF named .txt is read as a PDF; text named .pdf is read as text", async () => {
    const a = await readDocument(renewalPdf(), "notes.txt");
    expect(a.ok && a.mimeType).toBe("application/pdf");
    const b = await readDocument(bytes("Pay the plumber $120 by Friday."), "invoice.pdf");
    expect(b.ok && b.mimeType).toBe("text/plain");
  });
});

describe("readDocument: text-layer PDFs (F3 acceptance: insurance, utility, government)", () => {
  it.each([
    ["insurance", renewalPdf, RENEWAL_PAGES],
    ["utility", utilityPdf, UTILITY_PAGES],
    ["government", governmentPdf, GOVERNMENT_PAGES],
  ])("%s notice extracts readable text with a page map", async (_name, make, pages) => {
    const r = await readDocument(make(), "notice.pdf");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(pdfText(pages));
    expect(r.pageCount).toBe(pages.length);
    expect(r.pageOffsets?.[0]).toBe(0);
    expect(r.pageOffsets).toHaveLength(pages.length);
  });

  it("page offsets put a quote from page 2 on page 2", async () => {
    const r = await readDocument(renewalPdf(), "renewal.pdf");
    if (!r.ok) throw new Error("not read");
    const at = r.text.indexOf("call us before October 31, 2026");
    expect(at).toBeGreaterThan(0);
    expect(pageForOffset(r.pageOffsets, at)).toBe(2);
    expect(pageForOffset(r.pageOffsets, r.text.indexOf("Your home policy"))).toBe(1);
  });
});

describe("readDocument: refusals", () => {
  it("an image-only PDF is a scan: unsupported_scan, nothing guessed", async () => {
    const r = await readDocument(scannedPdf(), "scan.pdf");
    expect(r).toEqual({ ok: false, reason: "scan" });
    expect(uploadFailure({ reason: "scan" })).toEqual({
      code: "unsupported_scan",
      message: "This looks like a scan. I can't read scans yet.",
      retryable: false,
    });
  });

  it("a PDF whose pages carry only a page number is still a scan", async () => {
    const r = await readDocument(textPdf([["Page 1 of 2"], ["Page 2 of 2"]]), "scan.pdf");
    expect(r).toEqual({ ok: false, reason: "scan" });
  });

  it("more than 30 pages: too_many_pages with the count", async () => {
    const pages = Array.from({ length: 31 }, (_, i) => [`Page ${i + 1} of a long synthetic report with enough words.`]);
    const r = await readDocument(textPdf(pages), "long.pdf");
    expect(r).toEqual({ ok: false, reason: "too_many_pages", n: 31 });
    expect(uploadFailure({ reason: "too_many_pages", n: 31 }).message).toBe("This document has 31 pages. The limit is 30.");
  });

  it("exactly 30 pages is accepted", async () => {
    const pages = Array.from({ length: 30 }, (_, i) => [`Page ${i + 1} of a synthetic report with enough words.`]);
    const r = await readDocument(textPdf(pages), "thirty.pdf");
    expect(r.ok && r.pageCount).toBe(30);
  });

  it("over 10 MB: file_too_large with the size", async () => {
    const r = await readDocument(new Uint8Array(10 * 1024 * 1024 + 1), "big.pdf");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("file_too_large");
    expect(uploadFailure({ reason: "file_too_large", sizeMb: 12.34 }).message).toBe("This file is 12.3 MB. The limit is 10 MB.");
  });

  it("a damaged PDF is refused, not guessed", async () => {
    const r = await readDocument(bytes("%PDF-1.4\nthis is not really a pdf"), "broken.pdf");
    expect(r).toEqual({ ok: false, reason: "unreadable_pdf" });
  });

  it("DOCX (deferred, D17) and other ZIPs are refused with their own copy", async () => {
    const docx = Uint8Array.from([0x50, 0x4b, 3, 4, ...bytes("....word/document.xml....")]);
    expect(await readDocument(docx, "letter.docx")).toEqual({ ok: false, reason: "docx" });
    expect(await readDocument(Uint8Array.from([0x50, 0x4b, 3, 4, 9, 9]), "a.zip")).toEqual({ ok: false, reason: "unsupported_type" });
    expect(uploadFailure({ reason: "docx" }).message).toBe(UPLOAD_COPY.docx);
    expect(uploadFailure({ reason: "unsupported_type" })).toEqual({
      code: "unsupported_type",
      message: "Loose Ends can read PDF, TXT and MD files.",
      retryable: false,
    });
  });

  it("an image or other binary is unsupported_type", async () => {
    expect(await readDocument(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), "photo.png")).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("an empty text file and over-long text are refused", async () => {
    expect(await readDocument(bytes("  \n\n "), "empty.txt")).toEqual({ ok: false, reason: "empty" });
    expect(await readDocument(bytes("a".repeat(30_001)), "long.txt")).toEqual({ ok: false, reason: "too_long", n: 30_001 });
    expect(uploadFailure({ reason: "too_long", n: 30_001 })).toEqual({
      code: "input_too_long",
      message: "This document has 30,001 characters of text. The limit is 30,000.",
      retryable: false,
    });
  });
});

describe("readDocument: TXT and MD", () => {
  it("UTF-8 text is kept verbatim apart from line breaks, a BOM and trailing spaces", async () => {
    const r = await readDocument(bytes("﻿Dear Sam,  \r\nI’ll send it Friday.\r\n\r\n"), "note.txt");
    expect(r).toEqual({ ok: true, text: "Dear Sam,\nI’ll send it Friday.", mimeType: "text/plain", pageOffsets: null, pageCount: null });
  });

  it(".md names give text/markdown", async () => {
    const r = await readDocument(bytes("# Notes\n- call Ana"), "notes.MD");
    expect(r.ok && r.mimeType).toBe("text/markdown");
  });

  it("exactly 30,000 characters is accepted", async () => {
    const r = await readDocument(bytes("b".repeat(30_000)), "max.txt");
    expect(r.ok).toBe(true);
  });

  it("a Windows-1252 / Latin-1 file that is not valid UTF-8 is decoded as Windows-1252", async () => {
    // "Café at 9 – Ana’s note" in Windows-1252: é = E9, en dash = 96, right quote = 92.
    const cp1252 = Uint8Array.from([...bytes("Caf"), 0xe9, ...bytes(" at 9 "), 0x96, ...bytes(" Ana"), 0x92, ...bytes("s note\r\n")]);
    expect(sniffType(cp1252)).toBe("text1252");
    expect(await readDocument(cp1252, "note.txt")).toEqual({ ok: true, text: "Café at 9 – Ana’s note", mimeType: "text/plain", pageOffsets: null, pageCount: null });
  });

  it("UTF-8 with one stray byte stays UTF-8: valid letters kept, the stray byte becomes U+FFFD", async () => {
    const b = Uint8Array.from([...bytes("Café – it’s due "), 0xe9, ...bytes(" Friday")]);
    expect(sniffType(b)).toBe("text");
    expect(await readDocument(b, "note.txt")).toMatchObject({ ok: true, text: "Café – it’s due � Friday" });
  });

  it("an accidental valid UTF-8 pair in a Windows-1252 file does not switch it to UTF-8", async () => {
    // "RÉSUMÉ : rendez-vous à 9h" in Windows-1252: the second É (C9) + NBSP (A0) is a valid UTF-8 pair.
    const b = Uint8Array.from([0x52, 0xc9, 0x53, 0x55, 0x4d, 0xc9, 0xa0, 0x3a, ...bytes(" rendez-vous "), 0xe0, ...bytes(" 9h")]);
    expect(sniffType(b)).toBe("text1252");
    expect(await readDocument(b, "x.txt")).toMatchObject({ ok: true, text: "R\u00c9SUM\u00c9\u00a0: rendez-vous \u00e0 9h" });
  });

  it("random buffers without control bytes are not read as UTF-8 text", () => {
    let accepted = 0;
    for (let n = 0; n < 20_000; n++) {
      // Control bytes are lifted out of range, so only the encoding checks decide.
      const b = crypto.getRandomValues(new Uint8Array(64)).map((x) => (x < 0x20 ? x + 0x20 : x));
      if (sniffType(b) === "text") accepted++;
    }
    expect(accepted).toBe(0);
  });

  it("bytes that are not UTF-8 and do not look like Windows-1252 text stay unsupported", async () => {
    const control = Uint8Array.from([...bytes("Caf"), 0xe9, 0x01, ...bytes(" note")]); // a control byte
    const undefinedByte = Uint8Array.from([...bytes("Caf"), 0xe9, 0x81, ...bytes(" note")]); // 0x81 is undefined in 1252
    const mostlyHigh = Uint8Array.from([0xe9, 0xe8, 0xf1, 0x41]); // mostly high bytes: not prose
    for (const b of [control, undefinedByte, mostlyHigh]) {
      expect(sniffType(b)).toBe("unknown");
      expect(await readDocument(b, "x.txt")).toEqual({ ok: false, reason: "unsupported_type" });
    }
  });
});

describe("helpers", () => {
  it("joinPages records where each page starts, empty pages included", () => {
    expect(joinPages(["ab", "", "cd"])).toEqual({ text: "ab\n\n\n\ncd", pageOffsets: [0, 4, 6] });
  });

  it("cleanText", () => {
    expect(cleanText("\n\n a \t\nb\u0000c  \n\n")).toBe(" a\nbc");
  });

  it("an image PDF really has no text layer", async () => {
    const r = await readDocument(imagePdf(1), "one.pdf");
    expect(r).toEqual({ ok: false, reason: "scan" });
  });

  it("formatFileSize", () => {
    expect(formatFileSize(2_621_440)).toBe("2.5 MB");
    expect(formatFileSize(2_048)).toBe("2 KB");
  });
});

describe("parseUploadForm", () => {
  const id = "4f9a2c3e-8b1d-4c6e-9f0a-1b2c3d4e5f60";
  it("title defaults to the file name without its extension", () => {
    const r = parseUploadForm({ sourceId: id, fileName: "Renewal notice.pdf", title: "", writtenOn: "", writtenOnSet: "0" });
    expect(r).toEqual({ ok: true, data: { sourceId: id, fileName: "Renewal notice.pdf", title: "Renewal notice", writtenOn: null } });
  });

  it("a typed title wins; a set date is kept", () => {
    const r = parseUploadForm({ sourceId: id, fileName: "x.pdf", title: " My title ", writtenOn: "2026-10-05", writtenOnSet: "1" });
    expect(r.ok && r.data).toMatchObject({ title: "My title", writtenOn: "2026-10-05" });
  });

  it("a long file name is cut to 120 characters for the default title", () => {
    const r = parseUploadForm({ sourceId: id, fileName: `${"n".repeat(200)}.pdf`, title: "", writtenOn: "", writtenOnSet: "0" });
    expect(r.ok && r.data.title?.length).toBe(120);
  });

  it("refuses a bad id, a long title and an impossible date", () => {
    expect(parseUploadForm({ sourceId: "x", fileName: "a.pdf", title: "", writtenOn: "", writtenOnSet: "0" })).toEqual({ ok: false, reason: "bad_upload" });
    expect(parseUploadForm({ sourceId: id, fileName: "a.pdf", title: "t".repeat(121), writtenOn: "", writtenOnSet: "0" })).toEqual({
      ok: false,
      reason: "title_too_long",
    });
    expect(parseUploadForm({ sourceId: id, fileName: "a.pdf", title: "", writtenOn: "2026-02-30", writtenOnSet: "1" })).toEqual({
      ok: false,
      reason: "invalid_date",
    });
  });
});
