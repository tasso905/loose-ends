import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester, independent of the developer's specs: the Undo toast's hard limit (D49, Oct 21).
 * The toast closes 12 s after the Done click even while hover or focus pauses it; the pause and the
 * 8 s countdown still apply inside that limit; an Undo already in flight is left to finish; focus
 * never falls to <body>; a late Undo is never reported as a success (rule 10).
 *
 * Each test makes its own open thread (synthetic title) for a throwaway user, so the tests are
 * independent of each other and of the core-loop spec.
 */

const INVALID = "That change isn't possible any more. Refresh to see the latest.";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let n = 0;

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function uid() {
  return (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
}
/** A fresh open commitment thread; returns its id and title. */
async function freshThread() {
  const title = `Synthetic toast probe ${++n}`;
  const { data, error } = await admin().from("threads").insert({ user_id: await uid(), title, kind: "commitment" }).select("id").single();
  if (error) throw error;
  return { id: data!.id as string, title };
}
async function status(id: string) {
  const { data } = await admin().from("threads").select("status, resolution").eq("id", id).single();
  return data;
}
async function eventTypes(id: string) {
  const { data } = await admin().from("thread_events").select("type").eq("thread_id", id).order("id");
  return (data ?? []).map((e) => e.type as string);
}

/** Clicks Done and returns the page's performance.now() at the click (same clock as the toast). */
async function clickDone(): Promise<number> {
  const done = page.getByRole("button", { name: "Done", exact: true });
  await done.evaluate((el) => el.addEventListener("click", () => ((window as unknown as { __doneAt: number }).__doneAt = performance.now()), { capture: true, once: true }));
  await done.click();
  return page.evaluate(() => (window as unknown as { __doneAt: number }).__doneAt);
}
/** Page-clock ms since the click when `label` (the Undo button) left the DOM, observed with a MutationObserver. */
async function watchRemoval(label: string) {
  await page.evaluate((name) => {
    const w = window as unknown as { __goneAt?: number };
    delete w.__goneAt;
    const obs = new MutationObserver(() => {
      if (!document.querySelector(`button[aria-label="${name}"]`)) {
        w.__goneAt = performance.now();
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }, label);
}
const goneAt = () => page.evaluate(() => (window as unknown as { __goneAt?: number }).__goneAt ?? null);
const pageNow = () => page.evaluate(() => performance.now());
async function waitUntil(clickAt: number, ms: number) {
  const left = clickAt + ms - (await pageNow());
  if (left > 0) await page.waitForTimeout(left);
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add$/);
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("unpaused: the toast closes at 8 s (countdown still applies inside the hard limit)", async () => {
  test.setTimeout(60_000);
  const t = await freshThread();
  await page.goto(`/threads/${t.id}`);
  const label = `Undo done: ${t.title}`;
  const at = await clickDone();
  await expect(page.getByRole("button", { name: label })).toBeVisible();
  await watchRemoval(label);
  await page.mouse.move(0, 0);
  await expect.poll(goneAt, { timeout: 14_000 }).not.toBeNull();
  const elapsed = (await goneAt())! - at;
  expect(elapsed, `closed ${Math.round(elapsed)} ms after Done`).toBeGreaterThan(7_900);
  expect(elapsed, `closed ${Math.round(elapsed)} ms after Done`).toBeLessThan(9_500);
});

test("hover-paused: the toast closes 12 s after the Done click (not later), focus is not on <body>", async () => {
  test.setTimeout(60_000);
  const t = await freshThread();
  await page.goto(`/threads/${t.id}`);
  const label = `Undo done: ${t.title}`;
  const at = await clickDone();
  const undo = page.getByRole("button", { name: label });
  await expect(undo).toBeVisible();
  await watchRemoval(label);
  await undo.hover();
  await waitUntil(at, 10_000);
  await expect(undo).toBeVisible(); // paused past 8 s
  await expect.poll(goneAt, { timeout: 5_000 }).not.toBeNull();
  const elapsed = (await goneAt())! - at;
  expect(elapsed, `closed ${Math.round(elapsed)} ms after Done`).toBeGreaterThan(11_900);
  expect(elapsed, `closed ${Math.round(elapsed)} ms after Done`).toBeLessThan(12_600);
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  expect(await status(t.id)).toMatchObject({ status: "resolved", resolution: "done" });
});

test("focus-paused: closes at 12 s; focus moves to the status line; no error banner; thread stays Done", async () => {
  test.setTimeout(60_000);
  const t = await freshThread();
  await page.goto(`/threads/${t.id}`);
  const label = `Undo done: ${t.title}`;
  const at = await clickDone();
  const undo = page.getByRole("button", { name: label });
  await expect(undo).toBeVisible();
  await watchRemoval(label);
  await undo.focus();
  await expect.poll(goneAt, { timeout: 14_000 }).not.toBeNull();
  const elapsed = (await goneAt())! - at;
  expect(elapsed, `closed ${Math.round(elapsed)} ms after Done`).toBeGreaterThan(11_900);
  expect(elapsed, `closed ${Math.round(elapsed)} ms after Done`).toBeLessThan(12_600);
  await expect(page.locator("#thread-status")).toBeFocused();
  await expect(page.getByRole("alert").filter({ hasText: INVALID })).toHaveCount(0);
  expect(await status(t.id)).toMatchObject({ status: "resolved", resolution: "done" });
  expect((await eventTypes(t.id)).filter((x) => x === "undone")).toHaveLength(0);
});

test("boundary: an Undo pressed at ~11.3 s after Done (normal network) is accepted by the server", async () => {
  test.setTimeout(60_000);
  const t = await freshThread();
  await page.goto(`/threads/${t.id}`);
  const at = await clickDone();
  const undo = page.getByRole("button", { name: `Undo done: ${t.title}` });
  await expect(undo).toBeVisible();
  await undo.focus();
  await waitUntil(at, 11_300);
  await page.keyboard.press("Enter");
  await expect(page.locator("#thread-status")).toHaveText("Open");
  await expect(page.getByRole("alert").filter({ hasText: INVALID })).toHaveCount(0);
  expect(await status(t.id)).toMatchObject({ status: "open" });
});


/**
 * The developer's open risk: an Undo clicked just before the hard limit on a slow network reaches
 * the server after its 12 s window. Simulated by holding the Undo request 2.5 s in the browser and
 * pressing Undo at ~11 s (arrives ~13.5 s after Done). Returns the thread and the Undo locator after
 * the refusal has rendered.
 */
async function slowLateUndo() {
  const t = await freshThread();
  await page.goto(`/threads/${t.id}`);
  const at = await clickDone();
  const undo = page.getByRole("button", { name: `Undo done: ${t.title}` });
  await expect(undo).toBeVisible();
  await page.route("**/threads/**", async (route) => {
    if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 2_500));
    await route.continue().catch(() => {});
  });
  try {
    await undo.focus();
    await waitUntil(at, 11_000);
    await page.keyboard.press("Enter");
    await waitUntil(at, 12_400);
    // Past the hard limit with the request still held: the toast stays (busy), not yanked away.
    await expect(undo).toBeVisible();
    await expect(undo).toBeDisabled();
    await expect(page.getByRole("alert").filter({ hasText: INVALID })).toBeVisible({ timeout: 10_000 });
  } finally {
    await page.unroute("**/threads/**");
  }
  return { t, undo };
}

// Required: the in-flight Undo is left to finish, and the refusal is honest with §2.13 copy and
// Refresh; never a success (rule 10). REGRESSION GUARD.
test("slow network: an Undo sent at ~11 s arriving after 12 s finishes in place and is refused honestly (rule 10)", async () => {
  test.setTimeout(60_000);
  const { t, undo } = await slowLateUndo();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  await expect(undo).toHaveCount(0);
  await expect(page.locator("#thread-status")).not.toHaveText("Open");
  expect(await status(t.id)).toMatchObject({ status: "resolved", resolution: "done" });
  expect((await eventTypes(t.id)).filter((x) => x === "undone")).toHaveLength(0);
});

// REGRESSION GUARD (was OPEN DEFECT T-U1, pre-existing path): when an Undo settled with an error
// the toast unmounted with focus on its Undo button and focus fell to <body>. Fixed: focus moves to
// the error banner (or the status line without one).
test("after a refused Undo, focus is not left on <body>", async () => {
  test.setTimeout(60_000);
  await slowLateUndo();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
});
