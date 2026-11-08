import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";

/**
 * Public /privacy page (D77, D82; SITE_CONTRACT §1.2, §2.0, §2.12, §2.15). The copy itself is
 * checked against docs/PRIVACY.md in tests/unit/privacy-copy.test.ts; this spec checks routing,
 * the two links, axe and rule 9 in the rendered page.
 */

const BANNED = ["fully private", "zero retention", "end-to-end encrypted"];
const created: string[] = [];
test.afterAll(async () => deleteUsers(created));

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function expectPrivacyPage(page: Page) {
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page).toHaveTitle("Privacy · Loose Ends");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(10);
  await expect(page.getByRole("heading", { level: 2, name: "10. Contact" })).toBeVisible();
}

test("signed out: 200 with no redirect, the same page, no banned phrase", async ({ page }) => {
  const res = await page.goto("/privacy");
  expect(res?.status()).toBe(200);
  expect(res?.request().redirectedFrom()).toBeNull();
  await expectPrivacyPage(page);

  const text = (await page.locator("body").innerText()).toLowerCase();
  for (const phrase of BANNED) expect(text).not.toContain(phrase);

  const terms = page.getByRole("link", { name: "Gemini API Additional Terms of Service" });
  await expect(terms).toHaveAttribute("href", "https://ai.google.dev/gemini-api/terms");
  const mail = page.getByRole("link", { name: /@/ });
  await expect(mail).toHaveAttribute("href", /^mailto:/);
  expect(await mail.getAttribute("href")).toBe(`mailto:${await mail.innerText()}`);

  // A query string never turns it into a redirect.
  const withNext = await page.goto("/privacy?next=%2Fthreads");
  expect(withNext?.status()).toBe(200);
  expect(withNext?.request().redirectedFrom()).toBeNull();
});

test("the proxy sets no cookie on /privacy", async ({ request }) => {
  const res = await request.get("/privacy", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()["set-cookie"]).toBeUndefined();
});

test("sign-in footer links to /privacy, and the wordmark leads back", async ({ page }) => {
  await page.goto("/sign-in");
  // The footer sits inside <main> (AuthPage), so it has no contentinfo role.
  await page.locator("main footer").getByRole("link", { name: "Privacy" }).click();
  await expectPrivacyPage(page);
  await page.getByRole("link", { name: "Loose Ends" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

for (const width of [375, 1280]) {
  test(`axe passes at ${width}px and nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/privacy");
    await expectNoViolations(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("signed in: /privacy loads without a redirect, and Settings → Data links to it", async ({ page }) => {
  const email = testEmail();
  created.push(email);
  await page.goto("/sign-in");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today$/);

  const res = await page.goto("/privacy");
  expect(res?.status()).toBe(200);
  expect(res?.request().redirectedFrom()).toBeNull();
  await expectPrivacyPage(page);

  await page.goto("/settings");
  await page.locator("section#data").getByRole("link", { name: "Privacy" }).click();
  await expectPrivacyPage(page);

  // Still signed in: the page didn't touch the session.
  const settings = await page.goto("/settings");
  expect(settings?.request().redirectedFrom()).toBeNull();
  await expect(page).toHaveURL(/\/settings$/);
});
