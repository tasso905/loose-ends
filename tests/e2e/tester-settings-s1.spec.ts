import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { deleteUsers, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester, S1 (D40): /settings and the analytics notice.
 *
 * Default (the committed S1 state, gate off): /settings needs auth and is a 404 when signed in; the
 * onboarding notice is hidden. With LE_S1_GATE_ON=1 the server under test must have been started with
 * SETTINGS_ANALYTICS_TOGGLE_SHIPPED flipped locally and ANALYTICS_ENABLED=true + POSTHOG_KEY set; then
 * the toggle's axe, 44 px, keyboard and rule-10 checks run instead. Synthetic users only.
 */
const GATE_ON = process.env.LE_S1_GATE_ON === "1";
const NOTICE = "Loose Ends counts which features you use. Analytics never include what you paste.";
const created: string[] = [];
test.afterAll(async () => deleteUsers(created));

/**
 * Signs a throwaway user in by writing the exact @supabase/ssr session cookies into the browser,
 * so this spec can run against a server on any port (the magic link's redirect allow-list only
 * contains :3000). Then opens /onboarding.
 */
async function signIn(page: Page): Promise<void> {
  const sb = localSupabase();
  const email = testEmail();
  const password = `pw-${randomUUID()}`;
  created.push(email);
  const admin = createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  let jar: { name: string; value: string }[] = [];
  const ssr = createServerClient(sb.url, sb.anonKey, {
    cookies: { getAll: () => jar, setAll: (c) => void (jar = c.map(({ name, value }) => ({ name, value }))) },
  });
  const s = await ssr.auth.signInWithPassword({ email, password });
  if (s.error) throw s.error;
  const base = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:3000");
  await page.context().addCookies(jar.map((c) => ({ ...c, domain: base.hostname, path: "/", sameSite: "Lax" as const })));
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/onboarding/);
}

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("signed out: /settings redirects to sign-in and keeps the destination", async ({ page }) => {
  await page.goto("/settings#profile");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings/);
});

test.describe("gate off (S1 as committed)", () => {
  test.skip(GATE_ON, "server was started with the gate flipped");

  test("signed in: /settings shows the not-found page and onboarding shows no analytics notice", async ({ page }) => {
    await signIn(page);
    await expect(page.getByText(NOTICE)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Turn off analytics" })).toHaveCount(0);
    await page.goto("/settings");
    await expect(page.getByText("This page could not be found")).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByText("Analytics", { exact: true })).toHaveCount(0);
  });

  // Regression guard (D1, fixed in 8092143): notFound() in the page ran after loading.tsx had streamed
  // a 200, a soft 404. The gate now lives in app/settings/layout.tsx.
  test("signed in: /settings returns HTTP 404 while gated", async ({ page }) => {
    await signIn(page);
    const res = await page.goto("/settings");
    expect(res?.status()).toBe(404);
  });
});

test.describe("gate flipped locally (LE_S1_GATE_ON=1)", () => {
  test.skip(!GATE_ON, "needs a server with SETTINGS_ANALYTICS_TOGGLE_SHIPPED flipped locally");

  test("notice: onboarding only, links to /settings#profile", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByText(NOTICE)).toHaveCount(0);
    await signIn(page);
    await expect(page.getByText(NOTICE)).toBeVisible();
    await expect(page.getByRole("link", { name: "Turn off analytics" })).toHaveAttribute("href", "/settings#profile");
  });

  test("settings: axe at desktop and 375 px, 44 px switch, keyboard toggle, rule 10", async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Turn off analytics" }).click();
    await expect(page).toHaveURL(/\/settings#profile$/);
    const sw = page.getByRole("switch", { name: "Analytics" });
    await expect(sw).toBeEnabled();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expectNoViolations(page);

    await page.setViewportSize({ width: 375, height: 800 });
    await expectNoViolations(page);
    const box = (await sw.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);

    // Rule 10: while the save is in flight the switch has not moved.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route("**/settings**", async (route) => {
      if (route.request().method() === "POST") await gate;
      await route.continue();
    });
    let posts = 0;
    page.on("request", (r) => void (r.method() === "POST" && new URL(r.url()).pathname === "/settings" && posts++));
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(sw).toHaveAttribute("aria-busy", "true");
    await expect(sw).toHaveAttribute("aria-disabled", "true");
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(sw).toBeFocused();
    // Presses while the save is pending are ignored (one request, no double toggle).
    await page.keyboard.press("Space");
    // force: Playwright treats aria-disabled as not actionable and would wait; a real pointer can still press it.
    await sw.click({ force: true });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    release();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect(sw).not.toHaveAttribute("aria-busy", "true");
    await expect(sw).toBeFocused();
    expect(posts).toBe(1);
    await page.unroute("**/settings**");

    // Persisted: reload shows the saved state.
    await page.reload();
    await expect(page.getByRole("switch", { name: "Analytics" })).toHaveAttribute("aria-checked", "false");

    // A failed save keeps the old state and shows the §2.13 copy.
    await page.route("**/settings**", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
    const sw2 = page.getByRole("switch", { name: "Analytics" });
    await expect(sw2).toBeEnabled();
    await sw2.click();
    await expect(page.getByText("That didn't save. Try again.")).toBeVisible();
    await expect(sw2).toHaveAttribute("aria-checked", "false");
    await expectNoViolations(page);
  });

  test("prefers-reduced-motion: the knob does not animate", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page);
    await page.goto("/settings#profile");
    const knob = page.getByRole("switch", { name: "Analytics" }).locator("span > span");
    const t = await knob.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { property: cs.transitionProperty, duration: cs.transitionDuration };
    });
    expect(t.property === "none" || t.duration.split(",").every((d) => parseFloat(d) === 0), JSON.stringify(t)).toBe(true);
  });

  // Regression guard (D2, fixed in 8092143): disabled={pending} dropped focus to <body> after each save.
  test("keyboard: focus stays on the switch after a save", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings#profile");
    const sw = page.getByRole("switch", { name: "Analytics" });
    await expect(sw).toBeEnabled();
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    const active = await page.evaluate(() => document.activeElement?.tagName);
    test.info().annotations.push({ type: "activeElement", description: String(active) });
    await expect(sw).toBeFocused({ timeout: 2_000 });
  });
});
