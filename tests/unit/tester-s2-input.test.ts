/**
 * Lead-tester S2 checks: paste input boundaries (SITE_CONTRACT §2.2, PRD F2) — 30,000 characters
 * after \r\n normalisation, counter thresholds, title 120, written-on date validation, and no
 * silent truncation. Synthetic text only.
 */
import { describe, expect, it } from "vitest";
import { parsePasteForm, pasteCounter, PASTE_MAX_CHARS } from "@/lib/capture/pasteInput";

const form = (text: unknown, extra: { title?: unknown; writtenOn?: unknown; writtenOnSet?: unknown } = {}) =>
  parsePasteForm({ text, title: extra.title, writtenOn: extra.writtenOn, writtenOnSet: extra.writtenOnSet ?? "0" });

describe("text length boundary (30,000, inclusive)", () => {
  it("accepts exactly 30,000 and keeps every character", () => {
    const r = form("a".repeat(30_000));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.text.length).toBe(30_000);
  });

  it("rejects 30,001 with the real length (never truncates)", () => {
    expect(form("a".repeat(30_001))).toEqual({ ok: false, reason: "too_long", length: 30_001 });
  });

  it("counts \\r\\n as one character, as the textarea counter does", () => {
    // 29,999 + CRLF = 30,001 raw code units, 30,000 after normalisation: accepted.
    const r = form("a".repeat(29_999) + "\r\n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.text).toBe("a".repeat(29_999) + "\n");
    // 1,000 CRLF lines totalling 30,000 normalised characters.
    const lines = Array.from({ length: 1_000 }, () => "b".repeat(29)).join("\r\n") + "\r\n";
    expect(lines.length).toBe(31_000);
    const r2 = form(lines);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.data.text.length).toBe(30_000);
    // One past: 30,001 normalised.
    expect(form("c" + lines)).toMatchObject({ ok: false, reason: "too_long", length: 30_001 });
  });

  it("lone \\r is normalised too", () => {
    const r = form("x\ry");
    expect(r.ok && r.data.text).toBe("x\ny");
  });

  it("astral characters count as two UTF-16 units on both counter and server (SQL limit is looser, never tighter)", () => {
    expect(form("😀".repeat(15_000)).ok).toBe(true);
    expect(form("😀".repeat(15_001))).toMatchObject({ ok: false, reason: "too_long", length: 30_002 });
  });

  it("whitespace-only and non-string input are empty, not saved", () => {
    expect(form(" \n\t\r\n ")).toMatchObject({ ok: false, reason: "empty" });
    expect(form(undefined)).toMatchObject({ ok: false, reason: "empty" });
    expect(form(new Blob(["x"]))).toMatchObject({ ok: false, reason: "empty" });
  });
});

describe("counter", () => {
  it("is hidden below 27,000 and shown from 27,000", () => {
    expect(pasteCounter(26_999).visible).toBe(false);
    expect(pasteCounter(27_000)).toEqual({ visible: true, over: false, text: "27,000 / 30,000" });
  });
  it("blocks only above 30,000", () => {
    expect(pasteCounter(PASTE_MAX_CHARS).over).toBe(false);
    expect(pasteCounter(30_001)).toEqual({ visible: true, over: true, text: "30,001 / 30,000" });
  });
});

describe("title", () => {
  it("accepts 120 characters, trims, and stores blank as null", () => {
    expect(form("ok", { title: "t".repeat(120) })).toMatchObject({ ok: true, data: { title: "t".repeat(120) } });
    expect(form("ok", { title: `  ${"t".repeat(120)}  ` })).toMatchObject({ ok: true, data: { title: "t".repeat(120) } });
    expect(form("ok", { title: "   " })).toMatchObject({ ok: true, data: { title: null } });
    expect(form("ok", {})).toMatchObject({ ok: true, data: { title: null } });
  });
  it("rejects 121 characters instead of cutting it", () => {
    expect(form("ok", { title: "t".repeat(121) })).toMatchObject({ ok: false, reason: "title_too_long" });
  });
});

describe("written-on date", () => {
  it("is ignored unless the user set it (server defaults it: Assumed)", () => {
    expect(form("ok", { writtenOn: "2026-10-05", writtenOnSet: "0" })).toMatchObject({ ok: true, data: { writtenOn: null } });
    expect(form("ok", { writtenOn: "2026-10-05", writtenOnSet: "1" })).toMatchObject({ ok: true, data: { writtenOn: "2026-10-05" } });
  });
  it.each(["2026-02-30", "2026-13-01", "2027-02-29", "26-10-05", "2026-10-05T00:00", "1899-12-31", "2101-01-01", "garbage"])(
    "rejects %s",
    (d) => {
      expect(form("ok", { writtenOn: d, writtenOnSet: "1" })).toMatchObject({ ok: false, reason: "invalid_date" });
    },
  );
  it("accepts a real leap day and year rollover dates", () => {
    for (const d of ["2028-02-29", "2026-12-31", "2027-01-01"]) {
      expect(form("ok", { writtenOn: d, writtenOnSet: "1" })).toMatchObject({ ok: true, data: { writtenOn: d } });
    }
  });
});
