import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";

/**
 * Lead-tester (fix/self-host-fonts): IBM Plex is self-hosted with next/font/local. On sign-in, the
 * Review Tray, Today and Thread detail this checks the faces the page actually loads (Plex Sans
 * 400/500/600, Plex Serif 400 only), that Plex Serif renders only verbatim source quotes
 * (<blockquote>), and that nothing is italic (DESIGN_STANDARD: no italics).
 *
 * LE_FONT_OUT=<dir> also writes per-page computed styles, rendered text boxes and full-page
 * screenshots, so two builds (e.g. origin/main's next/font/google and this branch) can be diffed.
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const TITLE = "Send revised proposal to Mike";
const OUT = process.env.LE_FONT_OUT;

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

interface Sample {
  key: string;
  tag: string;
  text: string;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  fontSize: string;
  lineHeight: string;
  letterSpacing: string;
  width: number;
  height: number;
}

interface PageFonts {
  faces: { family: string; weight: string; style: string; status: string }[];
  rendered: string[];
  samples: Sample[];
  serifTags: string[];
  italic: string[];
  sansVar: string;
  serifVar: string;
}

/** Computed font data for every element that directly holds text, after fonts are ready. */
async function measure(p: Page): Promise<PageFonts> {
  await p.evaluate(async () => {
    await document.fonts.ready;
  });
  return p.evaluate(() => {
    const out = {
      faces: [] as { family: string; weight: string; style: string; status: string }[],
      rendered: [] as string[],
      samples: [] as Sample[],
      serifTags: [] as string[],
      italic: [] as string[],
      sansVar: getComputedStyle(document.body).getPropertyValue("--font-plex-sans").trim(),
      serifVar: getComputedStyle(document.body).getPropertyValue("--font-plex-serif").trim(),
    };
    document.fonts.forEach((f) => {
      out.faces.push({ family: f.family.replaceAll('"', ""), weight: String(f.weight), style: f.style, status: f.status });
    });
    const seen = new Map<string, number>();
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) continue;
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      if (own.length === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const text = own.map((n) => n.textContent!.trim()).join(" ").slice(0, 60);
      const range = document.createRange();
      range.setStartBefore(own[0]!);
      range.setEndAfter(own[own.length - 1]!);
      const r = range.getBoundingClientRect();
      const base = `${el.tagName}:${text}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const first = cs.fontFamily.split(",")[0]!.trim().replaceAll('"', "");
      if (/serif/i.test(cs.fontFamily) && !/sans/i.test(first)) out.serifTags.push(`${el.tagName}:${text}`);
      if (cs.fontStyle !== "normal") out.italic.push(`${el.tagName}:${text}:${cs.fontStyle}`);
      out.rendered.push(`${first}|${cs.fontWeight}|${cs.fontStyle}`);
      out.samples.push({
        key: `${base}#${n}`,
        tag: el.tagName,
        text,
        fontFamily: cs.fontFamily,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        width: Math.round(r.width * 100) / 100,
        height: Math.round(r.height * 100) / 100,
      });
    }
    out.rendered = Array.from(new Set(out.rendered)).sort();
    return out;
  });
}

async function check(name: string): Promise<PageFonts> {
  const m = await measure(page);
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify(m, null, 2));
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true, animations: "disabled", caret: "hide" });
  }
  // The CSS variables the design tokens read are still defined.
  expect(m.sansVar, "--font-plex-sans").not.toBe("");
  expect(m.serifVar, "--font-plex-serif").not.toBe("");
  // No italics anywhere (DESIGN_STANDARD).
  expect(m.italic).toEqual([]);
  // Plex Serif only on verbatim source quotes.
  expect(m.serifTags.filter((t) => !t.startsWith("BLOCKQUOTE:"))).toEqual([]);
  // Only the four shipped faces exist, and nothing renders in a weight outside 400/500/600.
  const plex = m.faces.filter((f) => /plex/i.test(f.family) && !/fallback/i.test(f.family));
  for (const f of plex) expect(f.style).toBe("normal");
  const weights = new Set(m.samples.map((s) => s.fontWeight));
  for (const w of weights) expect(["400", "500", "600"]).toContain(w);
  return m;
}

test("sign-in renders in Plex Sans; no serif, no italics", async () => {
  await page.goto("/sign-in?next=%2Fadd");
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  const m = await check("sign-in");
  expect(m.serifTags).toEqual([]);
  const loaded = m.faces.filter((f) => f.status === "loaded").map((f) => `${f.weight}`);
  expect(loaded.length).toBeGreaterThan(0);
});

test("review tray: quotes in Plex Serif 400, everything else Plex Sans", async () => {
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add$/);
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByText("When was this written?").click();
  await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill("2026-10-05");
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  const m = await check("review-tray");
  expect(m.serifTags.length).toBeGreaterThan(0);
  const quote = m.samples.find((s) => s.tag === "BLOCKQUOTE")!;
  expect(quote.fontWeight).toBe("400");
  expect(m.faces.some((f) => /serif/i.test(f.family) && f.status === "loaded")).toBe(true);
});

test("Today renders in Plex Sans", async () => {
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();
  await page.getByRole("link", { name: "View in Today" }).click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("link", { name: new RegExp(TITLE) }).first()).toBeVisible();
  await page.mouse.move(0, 0);
  await check("today");
});

test("Thread detail: evidence quote in Plex Serif, rest in Plex Sans", async () => {
  await page.getByRole("link", { name: new RegExp(TITLE) }).first().click();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  const m = await check("thread");
  expect(m.serifTags).toEqual(["BLOCKQUOTE:I'll send you the revised proposal Friday"]);
});
