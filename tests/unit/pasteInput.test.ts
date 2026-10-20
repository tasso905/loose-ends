import { describe, expect, it } from "vitest";
import { MAX_INPUT_CHARS } from "@/lib/ai/extract";
import { formatWrittenOn, parsePasteForm, pasteCounter, PASTE_MAX_CHARS } from "@/lib/capture/pasteInput";
import { apiError } from "@/lib/errors";

/** F2 input validation (SITE_CONTRACT §2.2) and the input_too_long copy (§2.13). */

const form = (over: Partial<Record<"text" | "title" | "writtenOn" | "writtenOnSet", unknown>> = {}) =>
  parsePasteForm({ text: "Thanks Mike", title: "", writtenOn: "2026-10-05", writtenOnSet: "0", ...over });

describe("parsePasteForm", () => {
  it("uses the same limit as extract()", () => {
    expect(PASTE_MAX_CHARS).toBe(MAX_INPUT_CHARS);
    expect(PASTE_MAX_CHARS).toBe(30_000);
  });

  it("accepts exactly 30,000 characters and rejects 30,001 with the length", () => {
    expect(form({ text: "a".repeat(30_000) }).ok).toBe(true);
    expect(form({ text: "a".repeat(30_001) })).toEqual({ ok: false, reason: "too_long", length: 30_001 });
  });

  it("counts a submitted CRLF line break as one character, like the textarea", () => {
    const text = "a".repeat(29_999) + "\r\n";
    const res = form({ text });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.text).toBe("a".repeat(29_999) + "\n");
  });

  it("keeps the text as pasted (no trimming) and rejects blank text", () => {
    const res = form({ text: "  Thanks Mike  \n" });
    expect(res.ok && res.data.text).toBe("  Thanks Mike  \n");
    expect(form({ text: " \n\t " })).toMatchObject({ ok: false, reason: "empty" });
    expect(form({ text: null })).toMatchObject({ ok: false, reason: "empty" });
  });

  it("title: optional, trimmed, up to 120 characters", () => {
    expect(form({ title: "" })).toMatchObject({ ok: true, data: { title: null } });
    expect(form({ title: null })).toMatchObject({ ok: true, data: { title: null } });
    expect(form({ title: "  Mike thread " })).toMatchObject({ ok: true, data: { title: "Mike thread" } });
    expect(form({ title: "t".repeat(120) }).ok).toBe(true);
    expect(form({ title: "t".repeat(121) })).toMatchObject({ ok: false, reason: "title_too_long" });
  });

  it("written-on date is used only when the user set it; otherwise null (server defaults to today)", () => {
    expect(form({ writtenOnSet: "0" })).toMatchObject({ ok: true, data: { writtenOn: null } });
    expect(form({ writtenOnSet: "1" })).toMatchObject({ ok: true, data: { writtenOn: "2026-10-05" } });
    expect(form({ writtenOnSet: "1", writtenOn: "2026-02-30" })).toMatchObject({ ok: false, reason: "invalid_date" });
    expect(form({ writtenOnSet: "1", writtenOn: "Oct 5" })).toMatchObject({ ok: false, reason: "invalid_date" });
    expect(form({ writtenOnSet: "1", writtenOn: "" })).toMatchObject({ ok: true, data: { writtenOn: null } });
  });
});

describe("counter and over-limit copy", () => {
  it("is hidden below 27,000 and visible from 27,000", () => {
    expect(pasteCounter(26_999).visible).toBe(false);
    expect(pasteCounter(27_000)).toEqual({ visible: true, over: false, text: "27,000 / 30,000" });
    expect(pasteCounter(30_000).over).toBe(false);
    expect(pasteCounter(30_001)).toEqual({ visible: true, over: true, text: "30,001 / 30,000" });
  });

  it("input_too_long names the current length and the limit (§2.13)", () => {
    expect(apiError("input_too_long", { n: 31_250 })).toEqual({
      error: {
        code: "input_too_long",
        message: "That's 31,250 characters. The limit is 30,000 — trim it or split it into two pastes.",
        retryable: false,
      },
    });
  });
});

describe("formatWrittenOn", () => {
  it("formats like the date standard, adding the year only when it differs", () => {
    expect(formatWrittenOn("2026-10-05", "2026-10-20")).toBe("Mon Oct 5");
    expect(formatWrittenOn("2027-01-08", "2026-10-20")).toBe("Fri Jan 8, 2027");
  });
});
