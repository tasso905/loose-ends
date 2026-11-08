import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";

/**
 * Lead-tester: the AppHeader on every signed-in page (CLAUDE.md: 44 px touch targets below 768 px).
 * At 375 px every header link and button is at least 44x44, axe passes, nothing scrolls sideways;
 * at 1280 px the wordmark link is only as tall as the wordmark (desktop unchanged by the fix); the
 * wordmark link keeps its focus ring from the keyboard. Every check waits for the page's own
 * header and title first, so a client navigation can't be measured half-rendered.
 */

const PAGES = [
  { path: "/today", title: "Today · Loose Ends" },
  { path: "/threads", title: "Threads · Loose Ends" },
  { path: "/decisions", title: "Decisions · Loose Ends" },
  { path: "/settings", title: "Settings · Loose Ends" },
  { path: "/add", title: /Add.*· Loose Ends/ },
] as const;

test.describe.configure({ mode: "serial" });
const email = testEmail();
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Ftoday");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today$/);
});
test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

const wordmark = () => page.getByRole("banner").getByRole("link", { name: "Loose Ends, go to Today" });

async function settle(path: string, title: string | RegExp) {
  await page.goto(path);
  await expect(wordmark()).toBeVisible();
  await expect(page).toHaveTitle(title);
}

async function headerTargets() {
  return page.$$eval("header a, header button", (els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.getAttribute("aria-label") ?? (el.textContent ?? "").trim(), w: Math.round(r.width), h: Math.round(r.height) };
      }),
  );
}

for (const p of PAGES) {
  test(`375 px ${p.path}: every header link and button is at least 44x44; axe passes; no sideways scroll`, async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await settle(p.path, p.title);
    const targets = await headerTargets();
    console.log(`EVIDENCE 375 ${p.path}: ${JSON.stringify(targets)}`);
    expect(targets.length).toBeGreaterThanOrEqual(6);
    expect(targets.filter((t) => t.w < 44 || t.h < 44)).toEqual([]);
    const r = await new AxeBuilder({ page }).include("header").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => v.id)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test("1280 px: the wordmark link is only as tall as the wordmark (desktop unchanged); nav links stay 36 px", async () => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await settle("/today", "Today · Loose Ends");
  const box = await wordmark().boundingBox();
  const inner = await wordmark().locator(":scope > *").first().boundingBox();
  console.log(`EVIDENCE 1280 wordmark ${JSON.stringify(box)} inner ${JSON.stringify(inner)}`);
  expect(Math.round(box!.height)).toBe(Math.round(inner!.height));
  expect(box!.height).toBeLessThan(44);
  const nav = await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Threads" }).boundingBox();
  expect(Math.round(nav!.height)).toBe(36);
});

for (const width of [375, 1280]) {
  test(`${width} px: the wordmark link shows its 2 px accent focus ring from the keyboard`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await settle("/today", "Today · Loose Ends");
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    for (let i = 0; i < 6 && !(await wordmark().evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(wordmark()).toBeFocused();
    const ring = await wordmark().evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, visible: el.matches(":focus-visible") };
    });
    expect(ring).toEqual({ style: "solid", width: "2px", offset: "2px", visible: true });
  });
}
