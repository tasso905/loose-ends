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

// ---- Glyph coverage, preload and CSP (tester regression on the latin-only first cut) -------------

const GLYPHS = {
  latin1: "Renée, café, Zoë — “quoted” … 5–6",
  latinExt: "Łukasz Dvořák, Şükrü, Ștefan, Ő",
  vietnamese: "Nguyễn Thị Hương",
  cyrillic: "Привет, Дмитрий",
  greek: "Γειά σου Νίκο",
} as const;

/** Platform fonts Chromium used for each sample, per CSS stack and weight (CDP CSS.getPlatformFontsForNode). */
async function renderedFonts(p: Page) {
  await p.evaluate((g) => {
    const box = document.createElement("div");
    box.id = "tester-glyphs";
    for (const [voice, stack, weight] of [
      ["sans400", "var(--le-font-sans)", "400"],
      ["sans600", "var(--le-font-sans)", "600"],
      ["serif400", "var(--le-font-serif)", "400"],
    ]) {
      for (const [k, s] of Object.entries(g)) {
        const el = document.createElement("p");
        el.id = `g-${voice}-${k}`;
        el.style.fontFamily = stack!;
        el.style.fontWeight = weight!;
        el.textContent = s;
        box.appendChild(el);
      }
    }
    document.body.appendChild(box);
  }, GLYPHS);
  await p.evaluate(async () => {
    await document.fonts.ready;
    // Subset files load on first use; wait for every face the samples triggered.
    await Promise.all([...document.fonts].filter((f) => f.status === "loading").map((f) => f.loaded.catch(() => null)));
  });
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const out: Record<string, string[]> = {};
  for (const voice of ["sans400", "sans600", "serif400"]) {
    for (const k of Object.keys(GLYPHS)) {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#g-${voice}-${k}` });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      out[`${voice}:${k}`] = fonts.map((f) => `${f.familyName}${f.isCustomFont ? "(web)" : ""}:${f.glyphCount}`);
    }
  }
  await cdp.detach();
  return out;
}

test("glyph coverage: latin-ext, Vietnamese, Cyrillic and Greek render in Plex Sans (400 and 600) and Plex Serif (no Greek in Serif)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto("/sign-in");
  const fonts = await renderedFonts(p);
  if (OUT) writeFileSync(join(OUT, "glyphs.json"), JSON.stringify(fonts, null, 2));
  for (const [key, list] of Object.entries(fonts)) {
    const [voice, sample] = key.split(":");
    // Static files report their weight in the platform name ("IBM Plex Sans SemiBold").
    const face = voice!.startsWith("serif") ? /^IBM Plex Serif( (Medium|SemiBold))?\(web\)/ : /^IBM Plex Sans( (Medium|SemiBold))?\(web\)/;
    if (voice === "serif400" && sample === "greek") {
      // IBM Plex Serif has no Greek (as with next/font/google): Greek letters fall back; spaces stay Plex.
      expect(list.some((f) => !face.test(f)), key).toBe(true);
      continue;
    }
    expect(list.filter((f) => !face.test(f)), `${key}: ${list.join(", ")}`).toEqual([]);
  }
  await ctx.close();
});

test("preload: only latin Plex Sans files are preloaded; non-latin subsets download only when a page uses them", async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const woff: string[] = [];
  p.on("request", (r) => {
    if (r.url().endsWith(".woff2")) woff.push(r.url());
  });
  const res = await p.goto("/sign-in");
  const link = (await res!.allHeaders())["link"] ?? "";
  const preloads = [...link.matchAll(/<([^>]+\.woff2)>;\s*rel=preload/g)].map((m) => m[1]!);
  const htmlPreloads = await p.locator('link[rel="preload"][as="font"]').evaluateAll((ls) => ls.map((l) => (l as HTMLLinkElement).href));
  const all = [...new Set([...preloads, ...htmlPreloads].map((u) => new URL(u, p.url()).pathname))];
  if (OUT) writeFileSync(join(OUT, "preloads.json"), JSON.stringify({ all, woff }, null, 2));
  expect(all.length).toBeGreaterThan(0);
  expect(all.filter((u) => /latin-ext|cyrillic|greek|vietnamese|serif/i.test(u))).toEqual([]);
  await p.evaluate(() => document.fonts.ready);
  // A latin-only page fetches no non-latin subset.
  expect(woff.filter((u) => /latin-ext|cyrillic|greek|vietnamese/i.test(u))).toEqual([]);
  // Typing Cyrillic on the page pulls in the Cyrillic file on demand.
  await p.evaluate(() => {
    const el = document.createElement("p");
    el.style.fontFamily = "var(--le-font-sans)";
    el.textContent = "Привет";
    document.body.appendChild(el);
  });
  await expect.poll(() => woff.some((u) => /cyrillic/i.test(u) && !/cyrillic-ext/i.test(u))).toBe(true);
  await ctx.close();
});

test("CSP: under a strict style-src (no inline styles) latin text still renders in Plex Sans; the page works", async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const violations: string[] = [];
  p.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await p.route("**/sign-in", async (route) => {
    const r = await route.fetch();
    await route.fulfill({ response: r, headers: { ...r.headers(), "content-security-policy": "style-src 'self'" } });
  });
  await p.goto("/sign-in");
  await expect(p.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  const fonts = await renderedFonts(p);
  if (OUT) writeFileSync(join(OUT, "csp.json"), JSON.stringify({ violations, fonts }, null, 2));
  expect(fonts["sans400:latin1"]!.every((f) => /^IBM Plex Sans\(web\)/.test(f))).toBe(true);
  expect(fonts["serif400:latin1"]!.every((f) => /^IBM Plex Serif\(web\)/.test(f))).toBe(true);
  await ctx.close();
});
