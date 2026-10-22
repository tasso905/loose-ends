import { describe, expect, it } from "vitest";
import { readDocument, sniffType } from "@/lib/capture/document";
import { uploadFailure } from "@/lib/capture/uploadInput";
import { apiError } from "@/lib/errors";
import { unsupportedClaims } from "@/lib/pipeline/briefClaims";
import { pageForOffset } from "@/lib/pipeline/normalize";
import { renewalPdf, scannedPdf } from "../fixtures/documents";
import { textPdf } from "../fixtures/pdf";
import { CLINIC_TEXT, clinicPdf, damagedPdf, docxLike, encryptedPdf, pagesPdf, shortTextPdf, xlsxLike } from "../fixtures/tester-documents";

/**
 * Lead-tester S6 (F3) attacks on readDocument and the refusal copy, plus S7 rule-3 brief-claim
 * edges. Synthetic bytes only. `it.fails` pins a non-blocking gap: it asserts the safe behaviour
 * and currently fails; when fixed it turns red and must be flipped to `it`.
 */

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("tester: content sniffing, never the name", () => {
  it("a PDF renamed .txt or .md is read as a PDF with a page map", async () => {
    for (const name of ["notes.txt", "notes.md", "no-extension"]) {
      const r = await readDocument(renewalPdf(), name);
      expect(r.ok && r.mimeType, name).toBe("application/pdf");
      expect(r.ok && r.pageOffsets?.length, name).toBe(2);
    }
  });

  it("binary content renamed .pdf / .txt is refused as unsupported_type", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const exe = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
    for (const [bytes, name] of [[png, "photo.pdf"], [exe, "readme.txt"], [xlsxLike(), "sheet.pdf"]] as const) {
      expect(await readDocument(bytes, name), name).toEqual({ ok: false, reason: "unsupported_type" });
    }
  });

  it("a DOCX (ZIP with word/document.xml) is refused with the DOCX copy, whatever its name", async () => {
    const r = await readDocument(docxLike(), "letter.pdf");
    expect(r).toEqual({ ok: false, reason: "docx" });
    expect(uploadFailure({ reason: "docx" })).toEqual({
      code: "unsupported_type",
      message: "I can't read Word files yet. Save it as a PDF, or paste the text instead.",
      retryable: false,
    });
  });

  it("the %PDF- header is found within the first 1024 bytes and not beyond", () => {
    const pdf = textPdf([["Header offset check with enough letters to read."]]);
    const pad = (n: number) => new Uint8Array([...new Uint8Array(n).fill(0x20), ...pdf]);
    expect(sniffType(pad(600))).toBe("pdf");
    expect(sniffType(pad(1100))).not.toBe("pdf");
  });
});

describe("tester: PDFs that cannot be read", () => {
  it("a password-protected PDF is refused as unreadable, with the unsupported_type code and no retry", async () => {
    const r = await readDocument(encryptedPdf(), "statement.pdf");
    expect(r).toEqual({ ok: false, reason: "unreadable_pdf" });
    expect(uploadFailure({ reason: "unreadable_pdf" })).toEqual({
      code: "unsupported_type",
      message: "I couldn't open this PDF. It may be damaged or locked with a password.",
      retryable: false,
    });
  });

  it("a damaged PDF (header then garbage) is refused as unreadable, never as a scan", async () => {
    expect(await readDocument(damagedPdf(), "broken.pdf")).toEqual({ ok: false, reason: "unreadable_pdf" });
  });

  it("an image-only PDF is a scan (unsupported_scan copy is SITE_CONTRACT §2.13 verbatim)", async () => {
    expect(await readDocument(scannedPdf(), "scan.pdf")).toEqual({ ok: false, reason: "scan" });
    expect(uploadFailure({ reason: "scan" }).message).toBe("This looks like a scan. I can't read scans yet.");
  });
});

describe("tester: scan threshold and partial text layers", () => {
  it("24 letters on the best page is a scan; 25 is read (SCAN_MIN_CHARS_PER_PAGE)", async () => {
    expect(await readDocument(shortTextPdf(24), "a.pdf")).toEqual({ ok: false, reason: "scan" });
    expect((await readDocument(shortTextPdf(25), "a.pdf")).ok).toBe(true);
  });

  it("text on pages 1 and 3 only: read, the blank page keeps its slot so a page-3 quote says p. 3", async () => {
    const r = await readDocument(clinicPdf(), "clinic.pdf");
    if (!r.ok) throw new Error("not read");
    expect(r.text).toBe(CLINIC_TEXT);
    expect(r.pageCount).toBe(3);
    expect(pageForOffset(r.pageOffsets, r.text.indexOf("Please confirm by phone"))).toBe(3);
    expect(pageForOffset(r.pageOffsets, r.text.indexOf("Appointment reminder"))).toBe(1);
  });
});

describe("tester: limits and their copy (SITE_CONTRACT §2.13)", () => {
  it("30 pages is read; 31 is refused with 'This document has 31 pages. The limit is 30.'", async () => {
    expect((await readDocument(pagesPdf(30), "terms.pdf")).ok).toBe(true);
    const r = await readDocument(pagesPdf(31), "terms.pdf");
    expect(r).toEqual({ ok: false, reason: "too_many_pages", n: 31 });
    expect(uploadFailure({ reason: "too_many_pages", n: 31 })).toEqual({
      code: "too_many_pages",
      message: "This document has 31 pages. The limit is 30.",
      retryable: false,
    });
  });

  it("over 10 MB on the server is refused before sniffing, with the §2.13 copy", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const r = await readDocument(big, "big.pdf");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("file_too_large");
    expect(uploadFailure({ reason: "file_too_large", sizeMb: 12.34 }).message).toBe("This file is 12.3 MB. The limit is 10 MB.");
  });

  // REGRESSION GUARD (fixed in fix/upload-hardening): a file just over the limit used to round to
  // "10 MB", so the user read "This file is 10 MB. The limit is 10 MB." The stated size is now never
  // equal to the limit for any refused size.
  it("a file barely over 10 MB never reads 'This file is 10 MB. The limit is 10 MB.'", () => {
    const sizeMb = (10 * 1024 * 1024 + 1) / (1024 * 1024);
    expect(apiError("file_too_large", { sizeMb }).error.message).toBe("This file is 10.1 MB. The limit is 10 MB.");
    for (let bytes = 10 * 1024 * 1024 + 1; bytes < 10.2 * 1024 * 1024; bytes += 997) {
      expect(apiError("file_too_large", { sizeMb: bytes / (1024 * 1024) }).error.message, String(bytes)).not.toMatch(/^This file is 10 MB\./);
    }
  });

  it("text: exactly 30,000 characters is read, 30,001 refused as input_too_long; empty and whitespace-only refused", async () => {
    expect((await readDocument(utf8("a".repeat(30_000)), "a.txt")).ok).toBe(true);
    expect(await readDocument(utf8("a".repeat(30_001)), "a.txt")).toEqual({ ok: false, reason: "too_long", n: 30_001 });
    expect(await readDocument(new Uint8Array(), "a.txt")).toEqual({ ok: false, reason: "empty" });
    expect(await readDocument(utf8(" \n\t \n"), "a.md")).toEqual({ ok: false, reason: "empty" });
  });

  it("a UTF-8 BOM is stripped; .md maps to text/markdown, anything else to text/plain", async () => {
    const r = await readDocument(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("# Notes")]), "Notes.MD");
    expect(r).toMatchObject({ ok: true, text: "# Notes", mimeType: "text/markdown", pageOffsets: null });
    expect(await readDocument(utf8("Plain"), "notes.markdown.txt")).toMatchObject({ ok: true, mimeType: "text/plain" });
  });

  // REGRESSION GUARD (fixed in fix/upload-hardening): a Windows-1252 / Latin-1 .txt used to be
  // refused as "not a PDF, TXT or MD file". It is now decoded as Windows-1252.
  it("a Latin-1 .txt with an accented letter is read, not refused as an unsupported type", async () => {
    const r = await readDocument(Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x61, 0x74, 0x20, 0x39]), "cafe.txt");
    expect(r).toMatchObject({ ok: true, text: "Café at 9" });
  });

  // Guards for the Windows-1252 fallback: UTF-16 text and binary never pass as text.
  const be16 = (s: string) => Uint8Array.from([...s].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255]));
  const le16 = (s: string) => Uint8Array.from([...s].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]));
  it.each(["Call Ana tonight", "Café – due Friday", "我们明天下午三点开会", "Привет, встреча завтра", "안녕하세요 내일 회의"])(
    "UTF-16 '%s' (LE/BE, with and without BOM) stays unsupported_type",
    async (s) => {
      for (const b of [le16(s), be16(s), Uint8Array.from([0xff, 0xfe, ...le16(s)]), Uint8Array.from([0xfe, 0xff, ...be16(s)])]) {
        expect(sniffType(b)).toBe("unknown");
        expect(await readDocument(b, "notes.txt")).toEqual({ ok: false, reason: "unsupported_type" });
      }
    },
  );
  it("binary headers (JPEG, gzip, WASM, ICO, Mach-O, SQLite) stay unsupported_type", async () => {
    for (const b of [
      [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46],
      [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00],
      [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00],
      [0x00, 0x00, 0x01, 0x00, 0x01, 0x00],
      [0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00],
      [...utf8("SQLite format 3"), 0x00, 0x10, 0x00],
    ]) {
      expect(await readDocument(Uint8Array.from(b), "x.txt")).toEqual({ ok: false, reason: "unsupported_type" });
    }
  });

  // NON-BLOCKING (new in fix/upload-hardening): a UTF-8 file with ONE stray non-UTF-8 byte (a mixed-
  // encoding export, or a file cut mid-character) now fails strict UTF-8 and is decoded wholesale as
  // Windows-1252, so every correct accented letter, dash and curly quote becomes mojibake
  // ("CafÃ©", "itâ€™s"). Extraction then runs and quotes verify against the garbled text, which the
  // user sees in the Explain card and Why panel. Before the fix the file was refused. Safe: valid
  // UTF-8 multi-byte sequences are decoded as UTF-8 (e.g. prefer UTF-8 when the bytes contain any
  // valid multi-byte sequence, or decode with replacement), never re-read as Windows-1252.
  it("a UTF-8 file with one stray Latin-1 byte keeps its UTF-8 letters (no mojibake)", async () => {
    const b = Uint8Array.from([...utf8("Café – it’s due Friday. "), 0xe9, ...utf8(" end")]);
    const r = await readDocument(b, "note.txt");
    expect(r.ok && r.text.startsWith("Café – it’s due Friday.")).toBe(true);
  });
});

describe("tester: rule 3 brief-claim filter edges (S7)", () => {
  const SRC = "Your home policy renews on October 31, 2026. The premium changes from $1,200 to $1,470.";

  it("drops invented dates and amounts in every common form", () => {
    for (const line of ["Call before November 3.", "Due 10/30.", "Renews next Friday.", "Renews in two weeks.", "Pay $270 more.", "That is 1,500 dollars."]) {
      expect(unsupportedClaims(line, SRC).length, line).toBeGreaterThan(0);
    }
  });

  it("keeps lines whose dates and amounts are in the source as written", () => {
    for (const line of ["Call before October 31, 2026.", "The new premium is $1,470.", "If the new price is fine, do nothing.", "Do it now."]) {
      expect(unsupportedClaims(line, SRC), line).toEqual([]);
    }
  });

  // REGRESSION GUARDS (fixed in fix/upload-hardening): invented numeric percentages and amounts in
  // words used to pass the filter; a source date quoted without its year used to be dropped.
  it("an invented percentage is caught", () => {
    expect(unsupportedClaims("That is a 22.5% increase.", SRC)).not.toEqual([]);
  });
  it("an invented amount in words is caught", () => {
    expect(unsupportedClaims("That is fifteen hundred dollars.", SRC)).not.toEqual([]);
  });

  it("a date the source states, quoted without its year, is kept", () => {
    expect(unsupportedClaims("Whether October 31 is a hard deadline.", SRC)).toEqual([]);
  });

  it("year-less matching does not let a different day, month, year or time through", () => {
    for (const line of ["Whether October 3 is a hard deadline.", "Whether October 31, 2027 is a hard deadline.", "Whether Oct 31 at 5pm is a hard deadline.", "Whether 31 October 2025 matters."]) {
      expect(unsupportedClaims(line, SRC), line).toContain("date");
    }
    expect(unsupportedClaims("Due June 1.", "Due June 10, 2026.")).toContain("date");
    expect(unsupportedClaims("Due June 1.", "Due June 1-3, 2026.")).toContain("date");
    expect(unsupportedClaims("Call at 5 on June 1.", "Call at 5:30 on June 1, 2026.")).toContain("date");
  });

  it("percentages and word amounts that ARE in the source are kept; numbers in other forms are dropped (safe)", () => {
    const src = "Rent rises 4.5 percent. The deposit is two hundred dollars. Late fee: 15%.";
    expect(unsupportedClaims("A 4.5 percent rise.", src)).toEqual([]);
    expect(unsupportedClaims("A 15% late fee.", src)).toEqual([]);
    expect(unsupportedClaims("A deposit of two hundred dollars.", src)).toEqual([]);
    expect(unsupportedClaims("A 4.5% rise.", src)).toEqual(["amount"]);
    expect(unsupportedClaims("A 5% late fee.", src)).toEqual(["amount"]);
    expect(unsupportedClaims("Three hundred dollars is due.", src)).toEqual(["amount"]);
  });

  // NON-BLOCKING (rule 3 gaps remaining after fix/upload-hardening; lines show under an Interpretation
  // label). A word amount that is the TAIL of a longer source amount passes, because the phrase
  // check treats "-" and spaces as word boundaries: "five dollars" is found inside "twenty-five
  // dollars", "fifty euros" inside "two hundred and fifty euros". A digit-and-scale amount
  // ("1.5 million dollars") is reduced to "million dollars" by the words pattern, so any figure in
  // front of a source's "million dollars" passes. A percentage in words is not checked at all.
  const WORDS_SRC = "The fee is twenty-five dollars. A refund of two hundred and fifty euros. Budget 2.5 million dollars.";
  it("a smaller word amount that is the tail of the source's amount is caught ('five dollars' vs 'twenty-five dollars')", () => {
    expect(unsupportedClaims("The fee is about five dollars.", WORDS_SRC)).toEqual(["amount"]);
  });
  it("'fifty euros' is caught when the source says 'two hundred and fifty euros'", () => {
    expect(unsupportedClaims("A refund of fifty euros.", WORDS_SRC)).toEqual(["amount"]);
  });
  it("'1.5 million dollars' is caught when the source says '2.5 million dollars'", () => {
    expect(unsupportedClaims("A budget of 1.5 million dollars.", WORDS_SRC)).toEqual(["amount"]);
  });
  it("an invented percentage in words ('twenty percent') is caught", () => {
    expect(unsupportedClaims("A twenty percent rise.", WORDS_SRC)).toEqual(["amount"]);
  });
});
