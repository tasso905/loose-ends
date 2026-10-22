/**
 * Synthetic PDFs built in code (CLAUDE.md: fixtures are synthetic only). No library: a PDF is a
 * handful of numbered objects plus a byte-offset table, which is enough for pdf.js (unpdf).
 *
 *   textPdf([["line", ...], ...])  one page per array, each line drawn as real text (a text layer)
 *   imagePdf(n)                    n pages that each draw only an image: no text layer, like a scan
 */

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** PDF string literal: backslash, parentheses escaped; characters outside Latin-1 refused. */
function pdfString(s: string): string {
  if (/[^\x20-\xff]/.test(s)) throw new Error(`textPdf: only printable Latin-1 text is supported: ${JSON.stringify(s)}`);
  return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

function build(objects: Array<string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (p: string | Uint8Array) => {
    const b = typeof p === "string" ? latin1(p) : p;
    parts.push(b);
    length += b.length;
  };
  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(length);
    push(`${i + 1} 0 obj\n`);
    push(obj);
    push("\nendobj\n");
  });
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const o of offsets) push(`${String(o).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function stream(content: string | Uint8Array, dict = ""): Uint8Array {
  const body = typeof content === "string" ? latin1(content) : content;
  const head = latin1(`<< ${dict} /Length ${body.length} >>\nstream\n`);
  const tail = latin1("\nendstream");
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}

/**
 * Object layout: 1 catalog, 2 pages, 3 font or image, then per page: page object, content stream.
 */
function document(pageContents: Array<string>, resources: string, shared: Array<string | Uint8Array>): Uint8Array {
  const first = 2 + shared.length + 1; // object number of the first page
  const kids = pageContents.map((_, i) => `${first + i * 2} 0 R`).join(" ");
  const objects: Array<string | Uint8Array> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageContents.length} >>`,
    ...shared,
  ];
  pageContents.forEach((content, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${first + i * 2 + 1} 0 R >>`);
    objects.push(stream(content));
  });
  return build(objects);
}

export function textPdf(pages: string[][]): Uint8Array {
  const contents = pages.map(
    (lines) => `BT /F1 12 Tf 16 TL 72 720 Td ${lines.map((l) => `${pdfString(l)} Tj T*`).join(" ")} ET`,
  );
  return document(contents, "<< /Font << /F1 3 0 R >> >>", ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]);
}

export function imagePdf(pageCount = 1): Uint8Array {
  // An 8 x 8 grey image with a little texture, drawn large: what a scanner produces, minus the pixels.
  const pixels = Uint8Array.from({ length: 64 }, (_, i) => ((i * 37) % 200) + 30);
  const image = stream(pixels, "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8");
  const contents = Array.from({ length: pageCount }, () => "q 468 0 0 648 72 72 cm /Im1 Do Q");
  return document(contents, "<< /XObject << /Im1 3 0 R >> >>", [image]);
}
