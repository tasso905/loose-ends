import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Cookie, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";

/**
 * Lead-tester: the public /privacy page (D77, D82; SITE_CONTRACT §1.2, §2.0, §2.12, §2.14, §2.15),
 * checked against docs/PRIVACY.md itself (not the copy module): every heading and sentence in
 * order, the mailto link, links in, axe at 375/1280 px, no italics, no banned rule-9 phrase, no
 * redirect signed in or out, the proxy's early return not reachable for other paths, and every
 * cookie the browser holds at each step (P32).
 */

const DOC = readFileSync(new URL("../../docs/PRIVACY.md", import.meta.url), "utf8");
const BANNED = ["fully private", "zero retention", "end-to-end encrypted"];
// Supabase Auth cookies: the session (chunked .0, .1) and the PKCE code verifiers set while signing in.
const SUPABASE_COOKIE = /^sb-[a-z0-9]+-auth-token(\.\d+|-code-verifier|-flows?-[a-z0-9-]*code-verifier)?$/;
const ALLOWED_COOKIE = new RegExp(`${SUPABASE_COOKIE.source}|^le_account_deleted$`);

/** Sections and rows of the doc, in order, with markdown removed to the visible text. */
function docSections() {
  const visible = (t: string) => t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1");
  const out: { heading: string; rows: { id: string; text: string }[] }[] = [];
  for (const line of DOC.split("\n")) {
    const h = /^## (\d+\. .+)$/.exec(line);
    if (h) out.push({ heading: h[1]!.trim(), rows: [] });
    const r = /^\| (P\d+) \| (.+?) \| /.exec(line);
    if (r && out.length) out.at(-1)!.rows.push({ id: r[1]!, text: visible(r[2]!) });
  }
  return out;
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const names = (cookies: Cookie[]) => cookies.map((c) => c.name).sort();

async function signIn(context: BrowserContext, email: string) {
  const page = await context.newPage();
  await page.goto("/sign-in?next=%2Ftoday");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today/);
  return page;
}

test.describe.configure({ mode: "serial" });
const created: string[] = [];
test.afterAll(async () => deleteUsers(created));

test("signed out: 200 with no redirect, with and without ?next=, and the text is docs/PRIVACY.md word for word, in order", async ({ page }) => {
  for (const path of ["/privacy", "/privacy?next=%2Ftoday", "/privacy?next=https%3A%2F%2Fevil.example"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    expect(res?.request().redirectedFrom(), path).toBeNull();
    expect(new URL(page.url()).pathname).toBe("/privacy");
  }
  await expect(page).toHaveTitle("Privacy · Loose Ends");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy");

  const doc = docSections();
  expect(doc).toHaveLength(10);
  expect(doc.flatMap((s) => s.rows).length).toBe(33);
  const headings = await page.locator("main h2").allInnerTexts();
  expect(headings).toEqual(doc.map((s) => s.heading));
  const shown = await page.locator("main [data-privacy-id]").evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-privacy-id"), text: (e as HTMLElement).innerText })));
  const lastUpdated = shown.find((s) => s.id === "P2")?.text ?? "";
  expect(lastUpdated).toMatch(/^Last updated: [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/);
  const date = lastUpdated.slice("Last updated: ".length, -1);
  expect(shown).toEqual(doc.flatMap((s) => s.rows.map((r) => ({ id: r.id, text: r.text.replace("{date}", date) }))));
  // Each sentence sits under its own section heading.
  for (const [i, s] of doc.entries()) {
    const section = page.locator("main section").nth(i);
    await expect(section.locator("h2")).toHaveText(s.heading);
    expect(await section.locator("[data-privacy-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-privacy-id")))).toEqual(s.rows.map((r) => r.id));
  }
});

test("links: mailto for the support address; every link's target is a real, intended place", async ({ page }) => {
  await page.goto("/privacy");
  const mail = page.getByRole("link", { name: "info@piscesparadigm.ca", exact: true });
  await expect(mail).toHaveCount(1);
  await expect(mail).toHaveAttribute("href", "mailto:info@piscesparadigm.ca");
  const hrefs = await page.locator("main a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  for (const h of hrefs) expect(h, String(h)).toMatch(/^(\/sign-in|mailto:info@piscesparadigm\.ca|https:\/\/[a-z0-9.-]+\.(google\.com|google\.dev)\/[\w/.-]*)$/);
  for (const ext of await page.locator('main a[href^="https://"]').all()) await expect(ext).toHaveAttribute("rel", /noreferrer/);
  // P17: the current Gemini terms URL (coordinator checked the redirect Nov 8), the only external link.
  const p17 = page.locator('[data-privacy-id="P17"] a');
  await expect(p17).toHaveText("Gemini API Additional Terms of Service");
  await expect(p17).toHaveAttribute("href", "https://aistudio.google.com/docs/terms");
  await expect(page.locator('main a[href^="https://"]')).toHaveCount(1);
  expect(DOC).toContain("](https://aistudio.google.com/docs/terms)");
  expect(DOC).not.toContain("ai.google.dev/gemini-api/terms");
});

test("no banned rule-9 phrase, no italics anywhere, sans for every sentence", async ({ page }) => {
  await page.goto("/privacy");
  const body = (await page.locator("body").innerText()).toLowerCase();
  for (const p of BANNED) expect(body).not.toContain(p);
  const italic = await page.locator("body *").evaluateAll((els) => els.filter((e) => getComputedStyle(e).fontStyle !== "normal").map((e) => e.tagName));
  expect(italic).toEqual([]);
  const fonts = await page.locator("main p").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).fontFamily))]);
  for (const f of fonts) expect(f).toMatch(/IBM Plex Sans/i);
});

for (const width of [375, 1280]) {
  test(`axe passes at ${width}px; nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/privacy");
    await axe(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test("the proxy's early return reaches nothing else: lookalike, dot-segment, encoded and trailing-slash paths", async ({ request }) => {
  const paths = [
    "/privacyx",
    "/privacy-x",
    "/privacy.json",
    "/privacy/",
    "/privacy/x",
    "/privacy/../today",
    "/privacy/..%2Ftoday",
    "/privacy%2F..%2Ftoday",
    "/privacy/%2E%2E/today",
    "/privacy/%2e%2e/settings",
    "/privacy//today",
    "/privacy/./../api/export",
    "/%70rivacy",
    "/PRIVACY",
    "/privacy;/today",
    "/privacy%00/today",
  ];
  const seen: string[] = [];
  for (const p of paths) {
    const res = await request.get(p, { maxRedirects: 0, failOnStatusCode: false });
    const loc = res.headers()["location"] ?? "";
    const html = res.status() === 200 ? await res.text() : "";
    seen.push(`${p} -> ${res.status()} ${loc}`);
    // Signed out, nothing but the privacy page itself may answer 200 with a page.
    if (res.status() === 200) {
      expect(html, p).toContain("data-privacy-id");
      expect(html, p).not.toMatch(/Worth your attention|Export data \(JSON\)|Decisions<\/h1>/);
    } else {
      expect([307, 308, 400, 401, 404], `${p} -> ${res.status()}`).toContain(res.status());
      if (res.status() === 307 || res.status() === 308) expect(loc, p).toMatch(/^(\/|http:\/\/127\.0\.0\.1:\d+\/)(sign-in|privacy)/);
    }
  }
  console.log(`EVIDENCE paths: ${seen.join(" | ")}`);
});

test("P32 cookies, signed out: /privacy and /sign-in set none; asking for a link sets le_sign_in_email", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const res = await page.goto("/privacy");
  expect(res?.headers()["set-cookie"] ?? null).toBeNull();
  expect(names(await context.cookies())).toEqual([]);
  await page.goto("/sign-in");
  expect(names(await context.cookies())).toEqual([]);
  const email = testEmail();
  created.push(email);
  await requestLink(page, email);
  const after = await context.cookies();
  console.log(`EVIDENCE cookies after link request: ${JSON.stringify(after.map((c) => ({ name: c.name, path: c.path, httpOnly: c.httpOnly, expiresInS: Math.round(c.expires - Date.now() / 1000) })))}`);
  // P32 (wording approved Nov 10): the email you asked a link for, kept 15 minutes, path /sign-in.
  expect(names(after).filter((n) => !SUPABASE_COOKIE.test(n))).toEqual(["le_sign_in_email"]);
  const mail = after.find((c) => c.name === "le_sign_in_email")!;
  const lifetimeS = mail.expires - Date.now() / 1000;
  expect(lifetimeS, "le_sign_in_email lasts 15 minutes").toBeGreaterThan(15 * 60 - 60);
  expect(lifetimeS, "le_sign_in_email lasts 15 minutes").toBeLessThanOrEqual(15 * 60 + 1);
  expect(decodeURIComponent(mail.value)).toBe(email);
  expect(mail.httpOnly).toBe(true);
  expect(mail.path).toBe("/sign-in");
  await context.close();
});

test("P32 cookies, signed in and after Delete account: only Supabase session cookies, then le_account_deleted", async ({ browser }) => {
  const context = await browser.newContext();
  const email = testEmail();
  created.push(email);
  const page = await signIn(context, email);
  const signedIn = await context.cookies();
  console.log(`EVIDENCE cookies signed in: ${JSON.stringify(names(signedIn))}`);
  for (const c of signedIn) expect(c.name).toMatch(ALLOWED_COOKIE);
  expect(signedIn.some((c) => c.name.startsWith("sb-"))).toBe(true);
  for (const path of ["/today", "/threads", "/decisions", "/settings", "/privacy", "/privacy?next=%2Fsettings"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    expect(new URL(page.url()).pathname, path).toBe(path.split("?")[0]);
    for (const c of await context.cookies()) expect(c.name, path).toMatch(ALLOWED_COOKIE);
  }
  // Settings → Data links to the page.
  await page.goto("/settings");
  await page.getByRole("link", { name: "Privacy", exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);

  await page.goto("/settings");
  await page.getByRole("button", { name: "Delete account…" }).click();
  const d = page.getByRole("dialog", { name: "Delete your account?" });
  await d.getByLabel("Type delete to confirm").fill("delete");
  // Every Set-Cookie the server sends from here on: le_account_deleted lives only until the sign-in
  // page has shown its notice (the proxy clears it), so the jar alone can't show it was set.
  const setCookies: string[] = [];
  page.on("response", async (r) => {
    for (const h of await r.headersArray().catch(() => [])) if (h.name.toLowerCase() === "set-cookie") setCookies.push(h.value.split(/;\s*/).filter((p) => !/^[^=]+=.{8,}$/.test(p) || /^Max-Age|^Path/i.test(p)).join("; "));
  });
  await d.getByRole("button", { name: "Delete account" }).click();
  await expect(page).toHaveURL(/\/sign-in$/, { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  console.log(`EVIDENCE set-cookie during delete (values over 7 chars hidden): ${JSON.stringify(setCookies)}`);
  const setNames = [...new Set(setCookies.map((c) => c.split("=")[0]!))];
  for (const n of setNames) expect(n).toMatch(ALLOWED_COOKIE);
  const deletedSet = setCookies.filter((c) => c.startsWith("le_account_deleted="));
  expect(deletedSet.some((c) => /Max-Age=120\b/i.test(c)), "le_account_deleted set for 120 s").toBe(true);
  const after = await context.cookies();
  console.log(`EVIDENCE cookies after delete: ${JSON.stringify(after.map((c) => ({ name: c.name, path: c.path, expiresInS: Math.round(c.expires - Date.now() / 1000) })))}`);
  for (const c of after) expect(c.name).toMatch(ALLOWED_COOKIE);
  expect(after.some((c) => c.name.startsWith("sb-"))).toBe(false);
  await context.close();
});

test("the sign-in footer link goes to /privacy and the wordmark leads back to sign-in", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("link", { name: "Privacy", exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await page.getByRole("link", { name: /Loose Ends/ }).first().click();
  await expect(page).toHaveURL(/\/sign-in/);
});
