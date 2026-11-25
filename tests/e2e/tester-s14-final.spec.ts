import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";
import { settled } from "./settled";

/**
 * Lead-tester S14, final (D87): the Undo schedule for a 30 s window, the `unsettled` refusal, another
 * user signing in during one page session, and Try again about the named line after a retryable
 * refusal (no budget needed, so it runs in CI). Recorded model only.
 */
const PLUMBER = "Call the plumber about the leaking tap";
const UNKNOWN = "I can't tell if this line was added. Try again: it won't be added twice.";
const DB = process.env.LE_S11_DB_CONTAINER ?? "";
const isolated = DB !== "" && DB !== "supabase_db_loose-ends";
const sql = (q: string) => execFileSync("docker", ["exec", DB, "psql", "-U", "postgres", "-d", "postgres", "-tAc", q]).toString();
const START = "public.start_quick_add(uuid, boolean, text, date, timestamptz, text, text, text)";

const email = testEmail();
const emailB = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";
const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};
async function signIn(p: Page, address: string) {
  await p.goto("/sign-in?next=%2Fadd%3Fmode%3Dquick");
  const since = await requestLink(p, address);
  await p.goto(await magicLinkFor(address, since));
  await p.getByRole("button", { name: "Skip" }).click();
  await expect(p).toHaveURL(/\/add\?mode=quick$/);
}
const idOf = async (address: string) => (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === address)!.id;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await signIn(page, email);
  uid = await idOf(email);
});
test.beforeEach(async () => {
  for (const t of ["threads", "sources", "usage_counters"]) await admin().from(t).delete().eq("user_id", uid);
  await page.setViewportSize({ width: 1280, height: 720 });
});
test.afterEach(async () => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email, emailB]);
});

const field = () => page.getByRole("textbox", { name: "Quick add" });
const undo = () => page.getByRole("button", { name: `Undo add: ${PLUMBER}` });
const added = () => page.getByRole("status").filter({ hasText: `Added "${PLUMBER}"` });
const banner = () => page.getByRole("alert").filter({ hasText: UNKNOWN });
const retry = () => page.getByRole("button", { name: "Try again" });
const threads = async (u = uid) => (await admin().from("threads").select("id").eq("user_id", u)).data!.length;
async function add(text = PLUMBER) {
  await page.goto("/add?mode=quick");
  await field().fill(text);
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
  await field().press("Enter");
}
async function loseOnce(reachServer: boolean) {
  let lose = true;
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST" || !lose) return route.continue();
    lose = false;
    if (reachServer) await route.fetch();
    await route.abort("connectionreset");
  });
}

/** [delay before, delay after the server's work, focused (only the limit closes it), expected ms offered]. */
const CASES: [number, number, boolean, number, number][] = [
  [0, 0, true, 10_500, 11_600],
  [0, 15_000, false, 7_500, 8_800],
  [0, 19_000, false, 7_500, 8_800],
  [0, 22_000, true, 5_000, 6_300],
  [0, 25_000, true, 2_000, 3_300],
  [0, 27_000, false, 0, 0],
  [15_000, 0, false, 7_500, 8_800],
  [25_000, 0, true, 2_000, 3_300], // the delay is before creation: withdrawn early, never late
];
for (const [up, down, focused, lo, hi] of CASES) {
  test(`Undo offered, ${up} ms before / ${down} ms after the server's work${focused ? ", focused" : ""}: ${lo}-${hi} ms`, async () => {
    if (up || down) {
      await page.route("**/add?mode=quick", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        await new Promise((r) => setTimeout(r, up));
        const response = await route.fetch();
        await new Promise((r) => setTimeout(r, down));
        await route.fulfill({ response });
      });
    }
    await add();
    await expect(added()).toBeVisible({ timeout: 45_000 });
    const t0 = performance.now();
    let ms = 0;
    if (await undo().isVisible()) {
      if (focused) await undo().focus();
      await expect(undo()).toBeHidden({ timeout: 14_000 });
      ms = Math.round(performance.now() - t0);
    }
    console.log(`UNDO30 up=${up} down=${down} focused=${focused} offered=${ms}`);
    expect(ms).toBeGreaterThanOrEqual(lo);
    expect(ms).toBeLessThanOrEqual(hi);
    expect(await threads()).toBe(1);
  });
}

test("the last Undo offered after a 24 s response (focused) is accepted", async () => {
  let createdAt = 0;
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST" || createdAt) return route.continue();
    const response = await route.fetch();
    createdAt = performance.now();
    await new Promise((r) => setTimeout(r, 24_000));
    await route.fulfill({ response });
  });
  await add();
  await expect(undo()).toBeVisible({ timeout: 35_000 });
  await undo().focus();
  await page.waitForTimeout(27_400 - (performance.now() - createdAt));
  await undo().press("Enter");
  await expect.poll(() => threads()).toBe(0);
});

test("unsettled: a retry the database refuses leaves the line unknown, announced again; later it is added once", async () => {
  test.skip(!isolated, "needs LE_S11_DB_CONTAINER of an isolated stack");
  await loseOnce(true);
  await add();
  await expect(banner()).toContainText(PLUMBER);
  await field().fill("typed since");
  sql(`revoke execute on function ${START} from authenticated`);
  try {
    await retry().click();
    await page.waitForTimeout(1_500);
    await expect(banner()).toHaveCount(1);
    await expect(page.getByText("That didn't save. Try again.")).toHaveCount(0);
    await expect(page.getByText("Nothing was saved")).toHaveCount(0);
    await expect(field()).toHaveValue("typed since");
    await expect(field()).toBeFocused();
    await settled(page);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(r.violations.map((v) => v.id)).toEqual([]);
  } finally {
    sql(`grant execute on function ${START} to authenticated`);
  }
  await retry().click();
  await expect(added()).toBeVisible();
  await expect(banner()).toHaveCount(0);
  expect(await threads()).toBe(1);
  expect((await admin().from("sources").select("id").eq("user_id", uid)).data).toHaveLength(1);
});

test("a first try the database refuses (no earlier try): That didn't save, text kept, nothing unknown", async () => {
  test.skip(!isolated, "needs LE_S11_DB_CONTAINER of an isolated stack");
  sql(`revoke execute on function ${START} from authenticated`);
  try {
    await add();
    await expect(page.getByText("That didn't save. Try again.")).toBeVisible();
    await expect(banner()).toHaveCount(0);
    await expect(field()).toHaveValue(PLUMBER);
  } finally {
    sql(`grant execute on function ${START} to authenticated`);
  }
  expect(await threads()).toBe(0);
});

test("a retryable refusal of an unknown line's retry (no budget needed): Try again resends that line, not newer text", async () => {
  let phase = 0;
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    phase += 1;
    if (phase === 1) return route.abort("connectionreset"); // never reached the server
    if (phase > 2) return route.continue();
    const response = await route.fetch(); // the daily limit's refusal, made retryable like a closed budget's
    const body = await response.text();
    expect(body).toContain('"retryable":false');
    await route.fulfill({ response, body: body.replace('"retryable":false', '"retryable":true') });
  });
  await add();
  await expect(banner()).toBeVisible();
  await field().fill("typed since");
  await admin().from("usage_counters").upsert({ user_id: uid, day: new Date().toISOString().slice(0, 10), extractions: 30, asks: 0 });
  await retry().click();
  await expect(page.getByText("You've reached today's limit of 30 sources.")).toBeVisible();
  await expect(banner()).toHaveCount(0);
  await admin().from("usage_counters").delete().eq("user_id", uid);
  await retry().click();
  await expect(added()).toBeVisible();
  await expect(field()).toHaveValue("typed since");
  expect(await threads()).toBe(1);
});

test("a 2,000-unit emoji line and a second long line at 375 px: both whole, no sideways scroll, axe", async () => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.route("**/add?mode=quick", (route) => (route.request().method() === "POST" ? route.abort("connectionreset") : route.continue()));
  const emoji = "🧾".repeat(1_000);
  await add(emoji);
  await expect(banner()).toHaveCount(1);
  const words = "Remember the boiler certificate ".repeat(62).trim();
  await field().fill(words);
  await field().press("Enter");
  await expect(banner()).toHaveCount(2);
  const spans = page.getByRole("alert").locator("span");
  expect(await spans.evaluateAll((e) => e.map((x) => (x as HTMLElement).innerText))).toEqual([emoji, words]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const b of await retry().all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await settled(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => v.id)).toEqual([]);
});

// Last: it leaves the context signed in as B.
test("another user signs in during this page session: A's unknown line is not shown to B after in-app navigation", async () => {
  await loseOnce(true);
  await add();
  await expect(banner()).toContainText(PLUMBER);
  await page.evaluate(() => ((window as unknown as { sameDocument: boolean }).sameDocument = true));
  const other = await context.newPage();
  await context.clearCookies(); // A signs out elsewhere
  await signIn(other, emailB);
  const b = await idOf(emailB);
  await other.close();
  // Without any navigation the old page still shows A's banner; what does its Try again do?
  await retry().click();
  // D7, fixed: refused, nothing stored for B, and a fresh document (B's own /add).
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await expect(banner()).toHaveCount(0);
  await expect(page).toHaveURL(/\/add\?mode=quick$/);
  expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument ?? false)).toBe(false);
  expect(await threads(b)).toBe(0);
  for (const t of ["sources", "extractions", "usage_counters"]) expect((await admin().from(t).select("*").eq("user_id", b)).data, t).toEqual([]);
  console.log(`SWITCH stale-tab Try again: A threads ${await threads()}, B threads ${await threads(b)}, url ${new URL(page.url()).pathname}`);
  await page.getByRole("link", { name: "Today", exact: true }).first().click();
  await expect(page).toHaveURL(/\/today/);
  await page.getByRole("link", { name: "Add", exact: true }).first().click();
  await expect(page).toHaveURL(/\/add/);
  await page.getByRole("link", { name: "Quick add" }).click();
  await expect(field()).toBeVisible();
  await expect(banner()).toHaveCount(0);
  await expect(page.locator("main").getByText(PLUMBER)).toHaveCount(0);
});

test("another user signs in, A's unanswered line untouched: B never sees it", async () => {
  const c2 = await page.context().browser()!.newContext();
  const p2 = await c2.newPage();
  const eA = testEmail();
  const eB = testEmail();
  try {
    await signIn(p2, eA);
    let lose = true;
    await p2.route("**/add?mode=quick", async (route) => {
      if (route.request().method() !== "POST" || !lose) return route.continue();
      lose = false;
      await route.abort("connectionreset");
    });
    const f = p2.getByRole("textbox", { name: "Quick add" });
    await f.fill(PLUMBER);
    await expect(p2.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
    await f.press("Enter");
    await expect(p2.getByRole("alert").filter({ hasText: UNKNOWN })).toContainText(PLUMBER);
    await p2.evaluate(() => ((window as unknown as { sameDocument: boolean }).sameDocument = true));
    await c2.clearCookies();
    const other = await c2.newPage();
    await signIn(other, eB);
    await other.close();
    await p2.getByRole("link", { name: "Today", exact: true }).first().click();
    await expect(p2).toHaveURL(/\/today/);
    await p2.getByRole("link", { name: "Add", exact: true }).first().click();
    await p2.getByRole("link", { name: "Quick add" }).click();
    await expect(p2.getByRole("textbox", { name: "Quick add" })).toBeVisible();
    expect(await p2.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument ?? false)).toBe(true);
    await expect(p2.getByRole("alert").filter({ hasText: UNKNOWN })).toHaveCount(0);
    await expect(p2.locator("main").getByText(PLUMBER)).toHaveCount(0);
  } finally {
    await c2.close();
    await deleteUsers([eA, eB]);
  }
});
