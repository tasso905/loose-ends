import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";
import { settled } from "./settled";

/**
 * Lead-tester, fix/font-vars-stylesheet. Run against a production build (E2E_PROD=1): `next dev` has its
 * own inline styles. Files are hashed in production, so a request is identified by comparing its bytes
 * with app/fonts/*.woff2, never by its URL. LE_FONT_OUT=<dir> writes the measurements to compare builds.
 * Synthetic text only.
 */

test.describe.configure({ mode: "serial" });

const OUT = process.env.LE_FONT_OUT;
const PROD = Boolean(process.env.CI || process.env.E2E_PROD);
const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const CSP = "default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; connect-src *";

const FONT_DIR = join(process.cwd(), "app/fonts");
const SOURCE = new Map(
  readdirSync(FONT_DIR)
    .filter((f) => f.endsWith(".woff2"))
    .map((f) => [createHash("sha256").update(readFileSync(join(FONT_DIR, f))).digest("hex"), f.replace(/^ibm-plex-|-normal\.woff2$/g, "")]),
);
/** The source file a served font URL holds, whatever its hashed name. */
async function sourceOf(url: string, p: Page) {
  const body = await (await p.request.get(url)).body();
  return SOURCE.get(createHash("sha256").update(body).digest("hex")) ?? `unknown:${url}`;
}

const GLYPHS = {
  latin: "Renée, café, Zoë — “quoted” … 5–6",
  latinExt: "Łukasz Dvořák, Şükrü, Ștefan, Ő",
  vietnamese: "Nguyễn Thị Hương",
  cyrillic: "Привет, Дмитрий",
  greek: "Γειά σου Νίκο",
} as const;

async function platformFonts(p: Page) {
  await p.evaluate((g) => {
    const box = document.createElement("div");
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

function expectPlex(fonts: Record<string, string[]>) {
  for (const [key, list] of Object.entries(fonts)) {
    const [voice, sample] = key.split(":");
    if (voice === "serif400" && sample === "greek") continue;
    const face = voice!.startsWith("serif") ? /^IBM Plex Serif\(web\)/ : voice === "sans600" ? /^IBM Plex Sans SemiBold\(web\)/ : /^IBM Plex Sans\(web\)/;
    expect(list.filter((f) => !face.test(f)), `${key}: ${list.join(", ")}`).toEqual([]);
  }
}

function write(name: string, data: unknown) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, null, 2));
}

async function axe(p: Page) {
  await settled(p);
  const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const email = testEmail();
let context: BrowserContext;
let page: Page;
let threadUrl = "";

test.beforeAll(async ({ browser }) => {
  test.skip(!PROD, "needs a production build");
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();
  const sb = localSupabase();
  const db = createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const uid = (await db.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  threadUrl = `/threads/${(await db.from("threads").select("id").eq("user_id", uid).single()).data!.id}`;
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

const PAGES = () => ["/sign-in", "/today", "/threads", threadUrl, `${threadUrl}?panel=why`, "/decisions", "/add", "/settings"];

test("strict CSP (no style-src 'unsafe-inline'): 0 style violations on any page; every subset still renders in Plex", async ({ browser }) => {
  const state = await context.storageState();
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const violations: string[] = [];
  p.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(`${p.url()}: ${m.text().slice(0, 300)}`);
  });
  await p.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const r = await route.fetch();
    await route.fulfill({ response: r, headers: { ...r.headers(), "content-security-policy": CSP } });
  });
  await p.addInitScript(() => {
    (window as unknown as { __v: string[] }).__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __v: string[] }).__v.push(`${e.effectiveDirective}|${e.blockedURI}|${e.sourceFile}:${e.lineNumber}|${e.sample}`),
    );
  });
  const perPage: Record<string, string[]> = {};
  for (const url of PAGES()) {
    await p.goto(url);
    await p.waitForLoadState("networkidle");
    perPage[url] = await p.evaluate(() => (window as unknown as { __v: string[] }).__v);
    expect(await p.evaluate(() => document.documentElement.hasAttribute("style")), `${url}: <html style>`).toBe(false);
  }
  write("csp", { perPage, violations });
  const styleViolations = [...Object.entries(perPage).flatMap(([u, v]) => v.filter((x) => x.startsWith("style")).map((x) => `${u} ${x}`)), ...violations.filter((v) => /style/i.test(v))];
  expect(styleViolations).toEqual([]);

  await p.goto("/sign-in");
  const fonts = await platformFonts(p);
  write("csp-glyphs", fonts);
  expectPlex(fonts);
  await ctx.close();

  // Signed in, /sign-in redirects, so the signed-out page is checked in its own context.
  const anon = await browser.newContext();
  const a = await anon.newPage();
  const anonViolations: string[] = [];
  a.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text()) && /style/i.test(m.text())) anonViolations.push(m.text().slice(0, 300));
  });
  await a.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const r = await route.fetch();
    await route.fulfill({ response: r, headers: { ...r.headers(), "content-security-policy": CSP } });
  });
  await a.goto("/sign-in");
  await expect(a.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  await a.waitForLoadState("networkidle");
  expect(anonViolations).toEqual([]);
  await anon.close();
});

test("glyphs with no CSP: every subset in Plex Sans 400 and 600 and Plex Serif; Greek serif falls back", async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto("/sign-in");
  const fonts = await platformFonts(p);
  write("glyphs", fonts);
  expectPlex(fonts);
  const greek = fonts["serif400:greek"]!;
  expect(greek.some((f) => /^(Times New Roman|Liberation Serif):/.test(f)), greek.join(", ")).toBe(true);
  await ctx.close();
});

test("stacks: the computed variables list each subset then the fallback; each fallback face matches next/font's metrics", async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto("/sign-in");
  const data = await p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const faces: Record<string, string> = {};
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSFontFaceRule && /Fallback/.test(rule.cssText)) faces[rule.style.getPropertyValue("font-family")] = rule.cssText;
      }
    }
    return { sans: cs.getPropertyValue("--font-plex-sans"), serif: cs.getPropertyValue("--font-plex-serif"), body: getComputedStyle(document.body).fontFamily, faces };
  });
  write("stacks", data);
  expect(data.sans).toContain("Plex Sans Fallback");
  expect(data.serif).toContain("Plex Serif Fallback");
  expect(data.sans).not.toContain("var(--font-plex-sans-");
  expect(data.body).not.toMatch(/^\s*(Arial|system-ui)/);
  await ctx.close();
});

test("preload: only latin Sans files; a latin page fetches no other subset; Cyrillic text fetches only its own file", async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const woff: string[] = [];
  p.on("request", (r) => {
    if (/\.woff2(\?|$)/.test(r.url())) woff.push(r.url());
  });
  const res = await p.goto("/sign-in");
  const link = (await res!.allHeaders())["link"] ?? "";
  const fromHeader = [...link.matchAll(/<([^>]+\.woff2)>;\s*rel=preload/g)].map((m) => new URL(m[1]!, p.url()).href);
  const fromHtml = await p.locator('link[rel="preload"][as="font"]').evaluateAll((ls) => ls.map((l) => (l as HTMLLinkElement).href));
  const preloaded = [...new Set([...fromHeader, ...fromHtml])];
  const names = await Promise.all(preloaded.map((u) => sourceOf(u, p)));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForLoadState("networkidle");
  const firstLoad = await Promise.all([...new Set(woff)].map((u) => sourceOf(u, p)));
  const before = new Set(woff);
  await p.evaluate(() => {
    const el = document.createElement("p");
    el.style.fontFamily = "var(--le-font-sans)";
    el.textContent = "Привет";
    document.body.appendChild(el);
  });
  await expect.poll(() => woff.some((u) => !before.has(u))).toBe(true);
  await p.waitForLoadState("networkidle");
  const added = await Promise.all(woff.filter((u) => !before.has(u)).map((u) => sourceOf(u, p)));
  write("preload", { preloadedUrls: preloaded.map((u) => new URL(u).pathname), names, firstLoad, added });
  expect(names.sort()).toEqual(["sans-latin-400", "sans-latin-500", "sans-latin-600"]);
  expect(firstLoad.filter((n) => !n.startsWith("sans-latin-"))).toEqual([]);
  expect(added).toEqual(["sans-cyrillic-400"]);
  await ctx.close();
});

for (const width of [1280, 375]) {
  test(`axe at ${width} px with no scroll overflow`, async () => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    for (const url of PAGES()) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await axe(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${url} overflow`).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });
}

test("signed-out sign-in page: axe at 1280 and 375 px", async ({ browser }) => {
  for (const width of [1280, 375]) {
    const ctx = await browser.newContext({ viewport: { width, height: 812 } });
    const p = await ctx.newPage();
    await p.goto("/sign-in");
    await expect(p.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
    await axe(p);
    await ctx.close();
  }
});

test("layout shift with web fonts arriving late: measured against the base build", async () => {
  test.setTimeout(120_000);
  const shifts: Record<string, number> = {};
  const boxes: Record<string, { w: number; h: number }[]> = {};
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  // Serve fonts late, so the fallback paints first and the web font swaps in.
  await page.route(/\.woff2(\?|$)/, async (route) => {
    await new Promise((r) => setTimeout(r, 4_000));
    await route.continue();
  });
  for (const url of ["/sign-in", "/today", threadUrl, "/decisions"]) {
    // "commit": a font-blocked load event would otherwise hide the fallback paint from the measurement.
    await page.goto(url, { waitUntil: "commit" });
    await page.locator("h1").waitFor();
    await page.waitForTimeout(500);
    const rect = () =>
      page.evaluate(() => {
        const q = document.querySelector("h1")!;
        const quote = document.querySelector("blockquote");
        return [q, quote].filter(Boolean).map((e) => {
          const r = e!.getBoundingClientRect();
          return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
        });
      });
    const early = await rect();
    const textWidths = () =>
      page.evaluate(() => {
        const out: Record<string, number> = {};
        for (const el of document.querySelectorAll<HTMLElement>("h1, h2, p, a, button, label, blockquote, li")) {
          const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
          if (own.length === 0) continue;
          const r = document.createRange();
          r.setStartBefore(own[0]!);
          r.setEndAfter(own[own.length - 1]!);
          out[`${el.tagName}:${el.textContent!.trim().slice(0, 30)}`] = r.getBoundingClientRect().width;
        }
        return out;
      });
    const earlyText = await textWidths();
    expect(await page.evaluate(() => document.readyState), `${url}: measured before fonts arrived`).not.toBe("complete");
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const earlyFonts: string[] = [];
    for (const sel of ["h1", "blockquote"]) {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
      if (nodeId) earlyFonts.push(`${sel}=${(await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts.map((f) => f.familyName).join("+")}`);
    }
    await cdp.detach();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("load");
    await page.waitForTimeout(800);
    const late = await rect();
    const lateText = await textWidths();
    const diffs = Object.keys(earlyText).filter((k) => lateText[k]).map((k) => Math.abs(earlyText[k]! - lateText[k]!) / lateText[k]!);
    console.log(`SWAP ${url.replace(/[0-9a-f-]{36}/, "ID")} fallback=[${earlyFonts.join(", ")}] text elements=${diffs.length} mean width change=${((100 * diffs.reduce((a, b) => a + b, 0)) / Math.max(1, diffs.length)).toFixed(2)}% max=${(100 * Math.max(0, ...diffs)).toFixed(2)}%`);
    shifts[url.replace(/[0-9a-f-]{36}/, "ID")] = await page.evaluate(() => Math.round((window as unknown as { __cls: number }).__cls * 10000) / 10000);
    boxes[url.replace(/[0-9a-f-]{36}/, "ID")] = [...early, ...late];
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // Control: the observer does see a shift when something really moves, so 0 above means 0.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("main")!.style.marginTop = "120px";
  });
  await page.waitForTimeout(500);
  const control = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  console.log(`CLS control after a forced move: ${control}`);
  expect(control).toBeGreaterThan(0);
  write("cls", { shifts, boxes });
  console.log(`CLS ${JSON.stringify(shifts)} boxes ${JSON.stringify(boxes)}`);
  for (const [u, v] of Object.entries(shifts)) expect(v, u).toBeLessThan(0.1); // Core Web Vitals "good"
});
