import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fontStack } from "@/lib/fontStack";

/**
 * Glyph coverage (tester regression on fix/self-host-fonts): self-hosted IBM Plex ships the same
 * subsets next/font/google did, and the CSS variables list every subset family before the fallback,
 * so "Łukasz Dvořák", "Şükrü", "Ștefan", Cyrillic, Greek and Vietnamese never fall back to Arial.
 */

const f = (fontFamily: string) => ({ style: { fontFamily } });

describe("fontStack()", () => {
  it("puts the subset families between the latin family and its size-adjusted fallback", () => {
    expect(fontStack(f("'plexSans', 'plexSans Fallback'"), [f("'plexSansLatinExt'"), f("'plexSansGreek'")])).toBe(
      "'plexSans', 'plexSansLatinExt', 'plexSansGreek', 'plexSans Fallback'",
    );
  });

  it("works with hashed names and no fallback", () => {
    expect(fontStack(f("'__plexSerif_a1b2c3'"), [f("'__plexSerifLatinExt_d4e5'")])).toBe("'__plexSerif_a1b2c3', '__plexSerifLatinExt_d4e5'");
  });
});

describe("app/fonts and app/layout.tsx", () => {
  const root = process.cwd();
  const files = readdirSync(join(root, "app", "fonts"));
  const layout = readFileSync(join(root, "app", "layout.tsx"), "utf8");
  const SANS = ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek", "vietnamese"];
  const SERIF = ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "vietnamese"]; // IBM Plex Serif has no Greek

  it.each(SANS.flatMap((s) => ["400", "500", "600"].map((w) => `ibm-plex-sans-${s}-${w}-normal.woff2`)))("ships and loads %s", (name) => {
    expect(files).toContain(name);
    expect(layout).toContain(`./fonts/${name}`);
  });

  it.each(SERIF.map((s) => `ibm-plex-serif-${s}-400-normal.woff2`))("ships and loads %s", (name) => {
    expect(files).toContain(name);
    expect(layout).toContain(`./fonts/${name}`);
  });

  it("keeps the OFL licences", () => {
    expect(files).toEqual(expect.arrayContaining(["OFL-IBM-Plex-Sans.txt", "OFL-IBM-Plex-Serif.txt"]));
  });

  it("preloads only latin Sans: every other call sets preload: false", () => {
    const calls = layout.split("localFont({").slice(1);
    expect(calls).toHaveLength(SANS.length + SERIF.length);
    const preloaded = calls.filter((c) => !c.includes("preload: false"));
    expect(preloaded).toHaveLength(1);
    expect(preloaded[0]).toContain("ibm-plex-sans-latin-400-normal.woff2");
    expect(preloaded[0]).not.toContain("latin-ext");
  });

  it("every call declares its unicode-range", () => {
    for (const c of layout.split("localFont({").slice(1)) expect(c).toMatch(/prop: "unicode-range", value: "U\+[0-9A-F]/);
  });
});
