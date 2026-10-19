import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";

/** Automated axe checks (WCAG 2.1 AA) on sign-in and onboarding, plus 44px touch targets below 768px. */

const created: string[] = [];
test.afterAll(async () => deleteUsers(created));

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function expectTouchTargets(page: Page) {
  const small = await page.$$eval("main a, main button, main input:not([type=hidden]), main textarea", (els) =>
    els
      .map((el) => ({ el: el.outerHTML.slice(0, 80), r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.height < 44 || r.width < 44))
      .map(({ el, r }) => `${el} (${Math.round(r.width)}x${Math.round(r.height)})`),
  );
  expect(small).toEqual([]);
}

test("sign-in: default, error and sent states pass axe", async ({ page }) => {
  await page.goto("/sign-in");
  await expectNoViolations(page);

  await page.goto("/sign-in?error=link_expired");
  await expectNoViolations(page);

  await page.getByLabel("Email").fill("bad");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Enter an email address", { exact: false })).toBeVisible();
  await expectNoViolations(page);

  const email = testEmail();
  created.push(email);
  await page.goto("/sign-in");
  await requestLink(page, email);
  await expectNoViolations(page);
});

test("onboarding passes axe", async ({ page }) => {
  const email = testEmail();
  created.push(email);
  await page.goto("/sign-in");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await expectNoViolations(page);

  await page.setViewportSize({ width: 375, height: 800 });
  await expectTouchTargets(page);
});

test("mobile sign-in: touch targets are at least 44px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/sign-in");
  await expectTouchTargets(page);
  await expectNoViolations(page);
});
