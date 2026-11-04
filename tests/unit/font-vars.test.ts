import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Plex stacks are composed in app/globals.css from the per-subset variables next/font sets on
 * <html> (app/layout.tsx), never from an inline style, so a strict `style-src 'self'` CSP keeps them.
 */

const root = join(__dirname, "..", "..");
const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
const css = readFileSync(join(root, "app/globals.css"), "utf8");

const declared = [...layout.matchAll(/variable:\s*"(--font-plex-[a-z-]+)"/g)].map((m) => m[1]!);
const stack = (name: string) => {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  return m ? m[1]!.split(",").map((s) => s.trim()) : [];
};

describe("font variables", () => {
  it("<html> has no inline style", () => {
    expect(layout).not.toMatch(/<html[^>]*\bstyle=/);
  });

  it.each([
    ["--font-plex-sans", "-sans-", '"Plex Sans Fallback"'],
    ["--font-plex-serif", "-serif-", '"Plex Serif Fallback"'],
  ])("%s lists every subset variable in layout order, latin first, then the fallback", (name, voice, fallback) => {
    const subsets = declared.filter((v) => v.includes(voice));
    expect(subsets[0]).toBe(`${name}-latin`);
    expect(stack(name)).toEqual([...subsets.map((v) => `var(${v})`), fallback]);
  });

  it("each fallback family is declared as a local face", () => {
    expect(css).toMatch(/font-family:\s*"Plex Sans Fallback";\s*src:\s*local\("Arial"\)/);
    expect(css).toMatch(/font-family:\s*"Plex Serif Fallback";\s*src:\s*local\("Times New Roman"\)/);
  });
});
