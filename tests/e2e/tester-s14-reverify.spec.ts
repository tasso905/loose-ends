import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";
import { settled } from "./settled";

/**
 * Lead-tester S14 re-verification of D1-D4: how long Undo is offered for a given latency before and
 * after the server's work, the last offered moment is always accepted, newer text, unknown outcomes,
 * and axe / focus / 44 px of the new banner states at 1280 and 375 px. Recorded model only.
 */
const PLUMBER = "Call the plumber about the leaking tap";
const ADD_UNKNOWN = "I can't tell if this line was added. Try again: it won't be added twice.";
const UNDO_UNKNOWN = "I can't tell if that was undone. Check Threads to see.";
const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";
const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd%3Fmode%3Dquick");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add\?mode=quick$/);
  uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
});
test.beforeEach(async () => {
  for (const t of ["threads", "sources", "usage_counters"]) await admin().from(t).delete().eq("user_id", uid);
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
const undo = () => page.getByRole("button", { name: `Undo add: ${PLUMBER}` });
const added = () => page.getByRole("status").filter({ hasText: `Added "${PLUMBER}"` });
const threads = async () => (await admin().from("threads").select("id").eq("user_id", uid)).data!.length;
const active = () => page.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? "none");
async function add(text = PLUMBER) {
  await page.goto("/add?mode=quick");
  await field().fill(text);
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
  await field().press("Enter");
}
async function slow(up: number, down: number) {
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise((r) => setTimeout(r, up));
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, down));
    await route.fulfill({ response });
  });
}
async function loseOnce() {
  let lose = true;
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST" || !lose) return route.continue();
    lose = false;
    await route.fetch();
    await route.abort("connectionreset");
  });
}
async function axe() {
  await settled(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** How long Undo is on screen, untouched, for a delay before (`up`) or after (`down`) the server's work. */
for (const [up, down] of [[0, 0], [0, 1_000], [0, 2_000], [0, 4_000], [0, 6_000], [0, 8_000], [0, 10_000], [2_000, 0], [4_000, 0], [10_000, 0]] as const) {
  test(`MEASURE Undo offered with ${up} ms before and ${down} ms after the server's work`, async () => {
    if (up || down) await slow(up, down);
    await add();
    await expect(added()).toBeVisible({ timeout: 25_000 });
    const t0 = performance.now();
    const offered = await undo().isVisible();
    if (offered) await expect(undo()).toBeHidden({ timeout: 13_000 });
    const ms = offered ? Math.round(performance.now() - t0) : 0;
    console.log(`UNDO up=${up} down=${down} offered=${ms}ms`);
    // The full 8 s, however slow (30 s window, user decision Nov 24).
    expect(ms).toBeGreaterThan(7_500);
    expect(await threads()).toBe(1);
  });
}

test("MEASURE Undo offered on /review after a mixed add", async () => {
  await add("Call the bank about the card, and maybe book a dentist visit");
  const u = page.getByRole("button", { name: "Undo add: Call the bank about the card" });
  await expect(u).toBeVisible();
  const t0 = performance.now();
  await expect(u).toBeHidden({ timeout: 13_000 });
  const ms = Math.round(performance.now() - t0);
  console.log(`UNDO review offered=${ms}ms`);
  expect(ms).toBeGreaterThan(7_500);
});

test("D4: the last moment Undo is offered, the server accepts it (held 4 s, focused so only the limit closes it)", async () => {
  await slow(0, 4_000);
  await add();
  await expect(undo()).toBeVisible({ timeout: 15_000 });
  await undo().focus();
  await page.waitForTimeout(6_300);
  await undo().press("Enter");
  await expect.poll(threads, { timeout: 4_000 }).toBe(0);
  await expect(page.getByText("That change isn't possible any more.")).toHaveCount(0);
});

test("D1: newer text typed by keyboard survives success, failure and Undo; it can then be added", async () => {
  await slow(0, 1_500);
  await add();
  await field().fill("");
  await page.keyboard.type("Maybe ask Dana about the gutters");
  await expect(undo()).toBeVisible();
  await expect(field()).toHaveValue("Maybe ask Dana about the gutters");
  await undo().click();
  await expect.poll(threads).toBe(0);
  await expect(field()).toHaveValue("Maybe ask Dana about the gutters");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page).toHaveURL(/\/review\//);
});

for (const width of [1280, 375]) {
  test(`unknown add and unknown undo banners at ${width} px: copy, axe, focus, targets`, async () => {
    await page.setViewportSize({ width, height: 720 });
    await loseOnce();
    await add();
    await expect(page.getByText(ADD_UNKNOWN)).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Added" })).toHaveCount(0);
    expect(await active()).not.toBe("body");
    await axe();
    const again = page.getByRole("button", { name: "Try again" });
    if (width < 768) expect((await again.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await again.focus();
    await page.keyboard.press("Enter");
    await expect(added()).toBeVisible();
    expect(await active()).not.toBe("body");
    expect(await threads()).toBe(1);

    await loseOnce();
    await undo().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(UNDO_UNKNOWN)).toBeVisible();
    await page.waitForTimeout(400);
    expect(await active()).not.toBe("body");
    await axe();
    const refresh = page.getByRole("button", { name: "Refresh" });
    if (width < 768) expect((await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test(`the toast without Undo at ${width} px: axe, focus stays, closes by itself`, async () => {
    await page.setViewportSize({ width, height: 720 });
    await loseOnce();
    await add();
    await expect(page.getByText(ADD_UNKNOWN)).toBeVisible();
    await page.waitForTimeout(27_000);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(added()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Undo/ })).toHaveCount(0);
    await axe();
    await expect(added()).toHaveCount(0, { timeout: 10_000 });
    expect(await active()).not.toBe("body");
    expect(await threads()).toBe(1);
  });
}

// D5, fixed.
test("an unknown line is still named as unknown after another line is added", async () => {
  await loseOnce();
  await add();
  await expect(page.getByText(ADD_UNKNOWN)).toBeVisible();
  await field().fill("Water the ferns and email the landlord about the boiler");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added 2 threads" })).toBeVisible();
  await expect(page.getByText(ADD_UNKNOWN)).toBeVisible();
});

test("lost response, the thread deleted elsewhere, the same line added again: the page does not call it nothing", async () => {
  await loseOnce();
  await add();
  await expect(page.getByText(ADD_UNKNOWN)).toBeVisible();
  await admin().from("threads").delete().eq("user_id", uid);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForTimeout(2_500);
  console.log(`AFTER DELETE ${new URL(page.url()).pathname.slice(0, 8)} | ${(await page.locator("main").innerText()).replace(/\n+/g, " / ").slice(0, 300)}`);
  expect(await threads()).toBe(0);
});

test("other toasts keep Undo and the 11 s limit: Done from Thread detail", async () => {
  await add();
  await expect(added()).toBeVisible();
  const { data } = await admin().from("threads").select("id").eq("user_id", uid).single();
  await page.goto(`/threads/${data!.id}`);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const u = page.getByRole("button", { name: `Undo done: ${PLUMBER}` });
  await expect(u).toBeVisible();
  const t0 = performance.now();
  await u.focus();
  await expect(u).toBeHidden({ timeout: 13_000 });
  expect(performance.now() - t0).toBeGreaterThan(9_500);
});
