import { imagePdf, textPdf } from "./pdf";

/**
 * Lead-tester adversarial upload fixtures (S6/S7). Synthetic only: invented clinic, patient and
 * amounts. Built in code on top of tests/fixtures/pdf.ts.
 */

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const fromLatin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

/**
 * Three pages: text, then a page with no text layer at all, then text. The blank middle page
 * means page numbering must skip it ("p. 3", not "p. 2").
 */
export const CLINIC_PAGES: string[][] = [
  [
    "Lakeside Dental Clinic (synthetic example)",
    "Appointment reminder for patient TEST-0042",
    "Your cleaning is booked for November 12, 2026 at 3:30 PM.",
  ],
  [],
  ["Please confirm by phone within 7 days.", "A missed appointment fee of $45 applies without 24 hours notice."],
];
export const clinicPdf = () => textPdf(CLINIC_PAGES);

/** The text readDocument() produces for clinicPdf (empty page 2 still contributes its separator). */
export const CLINIC_TEXT = CLINIC_PAGES.map((lines) => lines.join("\n")).join("\n\n");

/**
 * A text-layer PDF with a Standard security handler whose /O and /U do not match the empty user
 * password: pdf.js asks for a password, i.e. a password-protected PDF.
 */
export function encryptedPdf(): Uint8Array {
  const plain = fromLatin1(textPdf([["This statement is locked with a password for testing purposes only."]]));
  const o = "<" + "6f".repeat(32) + ">";
  const u = "<" + "75".repeat(32) + ">";
  const id = "<" + "0123456789abcdef".repeat(2) + ">";
  const out = plain.replace(/trailer\n<< \/Size (\d+) \/Root 1 0 R >>/, (_m, n: string) =>
    `trailer\n<< /Size ${n} /Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O ${o} /U ${u} /P -4 >> /ID [${id} ${id}] >>`,
  );
  if (out === plain) throw new Error("encryptedPdf: trailer not found");
  return latin1(out);
}

/** n pages of text-layer PDF, each with one numbered line. */
export const pagesPdf = (n: number) => textPdf(Array.from({ length: n }, (_, i) => [`Page ${i + 1} of the synthetic terms and conditions.`]));

/** A one-page PDF whose only text has exactly `letters` letters/digits (the scan threshold is 25). */
export const shortTextPdf = (letters: number) => textPdf([["x".repeat(letters)], ["- - -"]]);

/** Mixed: page 1 is an image (no text layer), page 2 is text. */
export { imagePdf };

/** A minimal ZIP local-file header naming an Excel part (not DOCX). */
export const xlsxLike = () => latin1("PK\x03\x04\x14\x00\x00\x00\x00\x00xl/workbook.xml........");

/** A minimal ZIP local-file header naming the DOCX main part. */
export const docxLike = () => latin1("PK\x03\x04\x14\x00\x00\x00\x00\x00word/document.xml........");

/** "%PDF-" header followed by garbage: a damaged PDF. */
export const damagedPdf = () => latin1("%PDF-1.7\n" + "garbage ".repeat(200));
