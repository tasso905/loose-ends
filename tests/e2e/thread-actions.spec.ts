import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";
import { settled } from "./settled";

/**
 * S12 (F9): Mark waiting, Snooze (menu and Pick a date), Edit, Dismiss, Reopen on Thread detail and
 * Snooze from a Today row, against local Supabase and the recorded LLM fixtures. Each reversible
 * action runs at once with an Undo toast (D8) and a thread_events row; Dismiss writes a suppression
 * that Reopen removes; axe runs with the forms and menus open.
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const TITLE = "Send revised proposal to Mike";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let threadUrl = "";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function expectNoViolations() {
  await settled(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function thread() {
  const uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  const { data } = await admin().from("threads").select("id, title, status, waiting_on, expected_by, snoozed_until").eq("user_id", uid);
  expect(data).toHaveLength(1);
  return data![0]!;
}

async function lastEvent(threadId: string) {
  const { data } = await admin().from("thread_events").select("type, before, after").eq("thread_id", threadId).order("id", { ascending: false }).limit(1);
  return data![0]!;
}

async function suppressionCount(threadId: string) {
  const { count } = await admin().from("suppressions").select("*", { count: "exact", head: true }).eq("thread_id", threadId);
  return count ?? 0;
}

const status = () => page.locator("#thread-status");
const more = () => page.getByRole("button", { name: "More actions" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on("dialog", () => {
    throw new Error("No reversible action may ask for a browser confirmation (D8)");
  });
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add$/);
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByText("When was this written?").click();
  await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill("2026-10-05");
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();
  const t = await thread();
  threadUrl = `/threads/${t.id}`;
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("open thread: Done, Resolve… and Mark waiting are buttons; the rest are under More actions", async () => {
  await page.goto(threadUrl);
  await expect(status()).toHaveText("Open");
  for (const name of ["Done", "Resolve…", "Mark waiting"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  await more().click();
  const menu = page.getByRole("menu", { name: "More actions" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Snooze", "Edit", "Dismiss", "Forget permanently…"]);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Edit" })).toBeFocused();
  await expectNoViolations();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more()).toBeFocused();
});

test("Mark waiting: form prefilled with the counterparty; saves, toasts, logs; Undo restores Open", async () => {
  await page.getByRole("button", { name: "Mark waiting", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Mark waiting" });
  await expect(dialog).toBeVisible();
  const who = dialog.getByLabel("Waiting on");
  await expect(who).not.toHaveValue("");
  await expect(who).toBeFocused();
  await expectNoViolations();

  // Required field: a blank name is refused next to the field, nothing saved.
  await who.fill("   ");
  await dialog.getByRole("button", { name: "Mark waiting" }).click();
  await expect(dialog.getByText("Write who you're waiting on.")).toBeVisible();
  expect((await thread()).status).toBe("open");

  await who.fill("Mike");
  await dialog.getByLabel("Expected by (optional)").fill("2030-01-15");
  await dialog.getByRole("button", { name: "Mark waiting" }).click();
  await expect(dialog).toBeHidden();
  await expect(status()).toHaveText("Waiting");
  await expect(page.getByRole("status").filter({ hasText: `Marked waiting: "${TITLE}"` })).toBeVisible();
  const t = await thread();
  expect(t).toMatchObject({ status: "waiting", waiting_on: "Mike" });
  expect(await lastEvent(t.id)).toMatchObject({ type: "status_changed", before: { status: "open" }, after: { status: "waiting", waiting_on: "Mike" } });
  // Waiting: Back to me replaces Mark waiting; Snooze is not offered (PRD lifecycle table).
  await expect(page.getByRole("button", { name: "Back to me" })).toBeVisible();

  await page.getByRole("button", { name: `Undo mark waiting: ${TITLE}` }).click();
  await expect(status()).toHaveText("Open");
  expect(await thread()).toMatchObject({ status: "open", waiting_on: null, expected_by: null });
  expect((await lastEvent(t.id)).type).toBe("undone");
});

test("Snooze from More actions: the menu lists the presets with dates; Tomorrow snoozes; Undo restores", async () => {
  await expect(page.getByRole("button", { name: /Undo / })).toHaveCount(0, { timeout: 12_000 });
  await more().click();
  await page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: "Snooze" }).click();
  const menu = page.getByRole("menu", { name: "Snooze" });
  await expect(menu.getByRole("menuitem")).toHaveCount(3);
  await expect(menu.getByRole("menuitem", { name: /^Tomorrow, 9:00/ })).toBeFocused();
  await expect(menu.getByRole("menuitem", { name: /^Next Monday, 9:00 \w{3} \w{3} \d+$/ })).toBeVisible();
  await expectNoViolations();
  await menu.getByRole("menuitem", { name: /^Tomorrow, 9:00/ }).click();
  await expect(status()).toHaveText("Snoozed");
  await expect(page.getByRole("status").filter({ hasText: `Snoozed: "${TITLE}"` })).toBeVisible();
  const t = await thread();
  expect(t.status).toBe("snoozed");
  expect(new Date(t.snoozed_until!).getTime()).toBeGreaterThan(Date.now());
  expect((await lastEvent(t.id)).type).toBe("snoozed");
  await expect(page.getByRole("button", { name: "Wake now" })).toBeVisible();

  await page.getByRole("button", { name: `Undo snooze: ${TITLE}` }).click();
  await expect(status()).toHaveText("Open");
  expect(await thread()).toMatchObject({ status: "open", snoozed_until: null });
});

test("Edit: change the title; history says You edited this.; Undo restores the title", async () => {
  await expect(page.getByRole("button", { name: /Undo / })).toHaveCount(0, { timeout: 12_000 });
  await more().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit thread" });
  await expect(dialog.getByLabel("Title")).toHaveValue(TITLE);
  await expectNoViolations();
  await dialog.getByLabel("Title").fill("");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByText("Give this thread a title.")).toBeVisible();

  await dialog.getByLabel("Title").fill("Send the final proposal to Mike");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Send the final proposal to Mike" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: 'Saved changes to "Send the final proposal to Mike"' })).toBeVisible();
  await expect(page.getByRole("region", { name: "History" })).toContainText("You edited this.");
  const t = await thread();
  expect(await lastEvent(t.id)).toMatchObject({ type: "edited", before: { title: TITLE }, after: { title: "Send the final proposal to Mike" } });

  await page.getByRole("button", { name: "Undo edit: Send the final proposal to Mike" }).click();
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  expect((await thread()).title).toBe(TITLE);
});

test("Dismiss writes a suppression and toasts; Reopen brings it back and removes the suppression", async () => {
  await expect(page.getByRole("button", { name: /Undo / })).toHaveCount(0, { timeout: 12_000 });
  await more().click();
  await page.getByRole("menuitem", { name: "Dismiss" }).click();
  await expect(status()).toHaveText("Dismissed");
  await expect(page.getByRole("status").filter({ hasText: `Dismissed: "${TITLE}"` })).toBeVisible();
  const t = await thread();
  expect(t.status).toBe("dismissed");
  expect(await suppressionCount(t.id)).toBe(1);
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expectNoViolations();

  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(status()).toHaveText("Open");
  expect((await thread()).status).toBe("open");
  expect(await suppressionCount(t.id)).toBe(0);
  expect((await lastEvent(t.id)).type).toBe("reopened");
  await expect(page.getByRole("region", { name: "History" })).toContainText("You reopened this.");
});

test("Today row: Snooze → Pick a date… snoozes to that day; the row leaves and the toast offers Undo", async () => {
  await page.goto("/today");
  const row = page.getByTestId("attention-row").filter({ hasText: TITLE });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: `Snooze: ${TITLE}` }).click();
  const menu = page.getByRole("menu", { name: "Snooze" });
  await menu.getByRole("menuitem", { name: "Pick a date…" }).click();
  const picker = page.getByRole("group", { name: "Pick a date…" });
  const field = picker.getByLabel("Snooze until");
  await expect(field).toBeFocused();
  await field.fill("2030-03-04");
  await expectNoViolations();
  await picker.getByRole("button", { name: "Snooze" }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: `Snoozed: "${TITLE}"` })).toBeVisible();
  const t = await thread();
  expect(t.status).toBe("snoozed");
  expect(t.snoozed_until!.slice(0, 10)).toBe("2030-03-04");
  await expectNoViolations();
});
