import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";
import { settled } from "./settled";

/**
 * Lead-tester S14 (F4 quick add): what the developer's quick-add.spec does not cover. Focus after Undo
 * and after the toast closes, 375 px, banners (§2.13), rule 10, text typed while a request is pending,
 * and the tray after Undo. `test.fail` pins a reported defect; flip it to `test` when fixed. Synthetic recordings (AI_PROVIDER=fake); no live model.
 */
const PLUMBER = "Call the plumber about the leaking tap";
const MIXED = "Call the bank about the card, and maybe book a dentist visit";
const BANK = "Call the bank about the card";
const TWO = "Water the ferns and email the landlord about the boiler";

test.describe.configure({ mode: "default" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd%3Fmode%3Dquick");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add\?mode=quick$/);
  uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
});
test.beforeEach(async () => {
  await admin().from("threads").delete().eq("user_id", uid);
  await admin().from("usage_counters").delete().eq("user_id", uid);
  await page.setViewportSize({ width: 1280, height: 720 });
});
test.afterEach(async () => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.setOffline(false);
});
test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

const field = () => page.getByRole("textbox", { name: "Quick add" });
const addButton = () => page.getByRole("button", { name: "Add", exact: true });
const toast = (text: string) => page.getByRole("status").filter({ hasText: text });
const active = () => page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}#${a.id}|${a.textContent?.slice(0, 40)}` : "none"; });
const sources = async () => (await admin().from("sources").select("id").eq("user_id", uid)).data!.length;
const threads = async () => (await admin().from("threads").select("id, title, status").eq("user_id", uid)).data!;
async function add(text: string) {
  await page.goto("/add?mode=quick");
  await expect(field()).toBeFocused();
  await field().fill(text);
  await expect(addButton()).toBeEnabled();
  await field().press("Enter");
}
async function axe() {
  await settled(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
/** Holds the server action's response: `ms` after the server has finished. */
async function holdResponse(ms: number) {
  await page.route("**/add?mode=quick", async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    const res = await route.fetch();
    await new Promise((r) => setTimeout(r, ms));
    await route.fulfill({ response: res });
  });
}

test.fail("keyboard: Enter adds, focus stays in the field; Undo by keyboard does not drop focus to <body>", async () => {
  await add(PLUMBER);
  await expect(toast(`Added "${PLUMBER}"`)).toBeVisible();
  await expect(field()).toBeFocused();
  await page.getByRole("button", { name: `Undo add: ${PLUMBER}` }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await threads()).length).toBe(0);
  await expect(toast("Added")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await active()).not.toMatch(/^body/);
});

test.fail("adding with the Add button (keyboard) does not drop focus to <body>", async () => {
  await page.goto("/add?mode=quick");
  await field().fill(PLUMBER);
  await addButton().focus();
  await page.keyboard.press("Enter");
  await expect(toast(`Added "${PLUMBER}"`)).toBeVisible();
  await page.waitForTimeout(500);
  expect(await active()).not.toMatch(/^body/);
});

test("/add: a focused toast closes at the 11 s limit and focus goes to the field; the thread stays", async () => {
  await add(PLUMBER);
  const undo = page.getByRole("button", { name: `Undo add: ${PLUMBER}` });
  await undo.focus();
  await expect(undo).toBeHidden({ timeout: 13_000 });
  await expect(field()).toBeFocused();
  expect(await threads()).toHaveLength(1);
});

test.fail("review: Undo by keyboard does not drop focus to <body>", async () => {
  await add(MIXED);
  await expect(page).toHaveURL(/\/review\//);
  const undo = page.getByRole("button", { name: `Undo add: ${BANK}` });
  await undo.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await threads()).length).toBe(0);
  await page.waitForTimeout(500);
  expect(await active()).not.toMatch(/^body/);
});

test.fail("review: a focused toast closing at the 11 s limit does not drop focus to <body>", async () => {
  await add(MIXED);
  const undo = page.getByRole("button", { name: `Undo add: ${BANK}` });
  await undo.focus();
  await expect(undo).toBeHidden({ timeout: 13_000 });
  await page.waitForTimeout(300);
  expect(await active()).not.toMatch(/^body/);
});

test("review after Undo and a reload: the undone item is Rejected with Undo, the Maybe one still waits (approved Nov 24)", async () => {
  await add(MIXED);
  await page.getByRole("button", { name: `Undo add: ${BANK}` }).click();
  await expect.poll(async () => (await threads()).length).toBe(0);
  await page.reload();
  await expect(page.getByRole("button", { name: `Undo reject: ${BANK}` })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Book a dentist visit" })).toBeVisible();
});

for (const width of [1280, 375]) {
  test(`axe, targets and no sideways scroll at ${width} px: /add with the toast, a field error, /review with the toast`, async () => {
    await page.setViewportSize({ width, height: 720 });
    await add(PLUMBER);
    const undo = page.getByRole("button", { name: `Undo add: ${PLUMBER}` });
    await expect(undo).toBeVisible();
    await axe();
    const big = async () => {
      if (width >= 768) return;
      for (const l of [undo, field(), addButton(), page.getByRole("link", { name: "Quick add" })])
        expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    };
    await big();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await field().fill("x".repeat(2_001));
    await expect(field()).toHaveAttribute("aria-invalid", "true");
    await axe();
    await add(MIXED);
    const undo2 = page.getByRole("button", { name: `Undo add: ${BANK}` });
    await expect(undo2).toBeVisible();
    await axe();
    if (width < 768) expect((await undo2.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto("/add?mode=quick");
    // Placeholder uses text-tertiary: it must not sit on surface-sunken.
    const bg = await field().evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue("--le-surface-sunken")]);
    test.info().annotations.push({ type: "field bg / sunken", description: bg.join(" / ") });
  });
}

test("two High items: one count toast, Undo removes both", async () => {
  await add(TWO);
  await expect(toast("Added 2 threads")).toBeVisible();
  expect(await threads()).toHaveLength(2);
  await page.getByRole("button", { name: "Undo add: 2 threads" }).click();
  await expect.poll(async () => (await threads()).length).toBe(0);
});

test("Undo after Done in another tab: §2.13 banner with Refresh, focused; the thread stays Done", async () => {
  await add(PLUMBER);
  const undo = page.getByRole("button", { name: `Undo add: ${PLUMBER}` });
  await undo.hover();
  const [t] = await threads();
  const other = await context.newPage();
  await other.goto(`/threads/${t!.id}`);
  await other.getByRole("button", { name: "Done", exact: true }).click();
  await expect(other.locator("#thread-status")).toHaveText("Resolved");
  await other.close();
  await undo.click();
  await expect(page.getByText("That change isn't possible any more. Refresh to see the latest.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  expect(await active()).not.toMatch(/^body/);
  expect((await threads())[0]).toMatchObject({ status: "resolved" });
});

test("rate limit: §2.13 copy, text kept, nothing saved", async () => {
  const before = await sources();
  await admin().from("usage_counters").upsert({ user_id: uid, day: new Date().toISOString().slice(0, 10), extractions: 30, asks: 0 });
  await add(PLUMBER);
  await expect(page.getByText("You've reached today's limit of 30 sources. It resets at midnight (UTC).")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(field()).toHaveValue(PLUMBER);
  expect(await sources()).toBe(before);
  await axe();
});

test("offline: §2.13 copy, text kept, nothing saved; Try again works once online", async () => {
  const before = await sources();
  await page.goto("/add?mode=quick");
  await field().fill(PLUMBER);
  await expect(addButton()).toBeEnabled();
  await context.setOffline(true);
  await field().press("Enter");
  await expect(page.getByText("You're offline. Nothing was saved.")).toBeVisible();
  await expect(field()).toHaveValue(PLUMBER);
  expect(await sources()).toBe(before);
  await axe();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(toast(`Added "${PLUMBER}"`)).toBeVisible();
});

test("rule 10: nothing says Added until the result arrives; a double Enter adds once", async () => {
  await holdResponse(2_500);
  await add(PLUMBER);
  await field().press("Enter");
  await expect(addButton()).toBeDisabled();
  await page.waitForTimeout(1_500);
  await expect(toast("Added")).toHaveCount(0);
  await expect(toast(`Added "${PLUMBER}"`)).toBeVisible();
  expect(await threads()).toHaveLength(1);
});

test.fail("text typed for the next line while the first is being added is not thrown away", async () => {
  await holdResponse(2_500);
  await add(PLUMBER);
  await expect(addButton()).toBeDisabled();
  await field().fill("Buy stamps");
  await expect(toast(`Added "${PLUMBER}"`)).toBeVisible();
  await expect(field()).toHaveValue("Buy stamps");
});

test.fail("the response is lost after the server saved: the page does not say nothing was saved", async () => {
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });
  await add(PLUMBER);
  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toBeVisible();
  const copy = await alert.innerText();
  const saved = (await threads()).length;
  test.info().annotations.push({ type: "lost response", description: `banner: ${copy}; threads saved: ${saved}` });
  expect(saved === 1 && /didn't save|Nothing was saved/.test(copy)).toBe(false);
});

test.fail("slow response: an Undo the toast still offers (7 s in) is accepted by the server", async () => {
  await holdResponse(6_000);
  await add(PLUMBER);
  const undo = page.getByRole("button", { name: `Undo add: ${PLUMBER}` });
  await expect(undo).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(7_000);
  await undo.click();
  await expect.poll(async () => (await threads()).length, { timeout: 4_000 }).toBe(0);
});

test("written-on is known: no Assumed wording on the source's thread or tray; the Maybe item keeps its quote", async () => {
  await add(MIXED);
  await expect(page.getByRole("heading", { level: 1, name: "I found 1 thing in this" })).toBeVisible();
  await expect(page.locator("main").getByText(/assumed/i)).toHaveCount(0);
  await expect(page.locator("main").getByText("maybe book a dentist visit").first()).toBeVisible();
  const [t] = await threads();
  await page.goto(`/threads/${t!.id}`);
  await expect(page.getByText("Added from quick add.")).toBeVisible();
  await expect(page.locator("main").getByText(/assumed/i)).toHaveCount(0);
});
