import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";
import { settled } from "./settled";

/**
 * S14 (F4 quick add) against local Supabase and synthetic recorded fixtures (AI_PROVIDER=fake;
 * tests/fixtures/llm/quick-add-*.extract.json). High items become threads with an 8 s undo toast and
 * the user stays on /add; Medium items go to the review tray, for those items only (SITE_CONTRACT §3.1).
 */

const PLUMBER = "Call the plumber about the leaking tap";
const ACME = "Acme said they'd pay the invoice by the 15th";
const MAYBE = "Maybe ask Dana about the gutters";
const MIXED = "Call the bank about the card, and maybe book a dentist visit";

test.describe.configure({ mode: "serial" });

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

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

async function threads() {
  const { data } = await admin().from("threads").select("id, title, status, waiting_on").eq("user_id", uid).order("created_at");
  return data ?? [];
}

async function events(threadId: string) {
  const { data } = await admin().from("thread_events").select("actor, type, after").eq("thread_id", threadId);
  return data ?? [];
}

async function expectNoViolations() {
  await settled(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function quickAdd(text: string) {
  await page.goto("/add?mode=quick");
  const field = page.getByRole("textbox", { name: "Quick add" });
  await expect(field).toBeFocused();
  await field.fill(text);
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

test("the Quick add tab: one line, the placeholder, Add disabled while blank, focus in the field", async () => {
  await page.goto("/add?mode=quick");
  await expect(page.getByRole("link", { name: "Quick add" })).toHaveAttribute("aria-current", "page");
  const field = page.getByRole("textbox", { name: "Quick add" });
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("placeholder", "e.g. Send Mike the proposal Friday");
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await expectNoViolations();
});

test("over 2,000 characters is reported, not cut, and Add stays disabled", async () => {
  await page.goto("/add?mode=quick");
  const field = page.getByRole("textbox", { name: "Quick add" });
  await field.fill("x".repeat(2_001));
  await expect(page.getByText("That's 2,001 characters. Quick add takes up to 2,000 — use Paste for longer text.")).toBeVisible();
  await expect(field).toHaveValue("x".repeat(2_001));
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
});

test("a High item becomes a thread with an undo toast; the user stays on /add; Undo removes it and its events", async () => {
  await quickAdd(PLUMBER);
  const toast = page.getByRole("status").filter({ hasText: `Added "${PLUMBER}"` });
  await expect(toast).toBeVisible();
  await expect(page).toHaveURL(/\/add\?mode=quick$/);
  await expect(page.getByRole("textbox", { name: "Quick add" })).toHaveValue("");

  const [t] = await threads();
  expect(t).toMatchObject({ title: PLUMBER, status: "open" });
  const ev = await events(t!.id);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ actor: "ai", type: "created", after: expect.objectContaining({ via: "auto_create" }) });
  await expectNoViolations();

  await page.getByRole("button", { name: `Undo add: ${PLUMBER}` }).click();
  await expect(toast).toBeHidden();
  await expect.poll(async () => (await threads()).length).toBe(0);
  expect(await events(t!.id)).toEqual([]);
});

test("'… said they'd pay … by the 15th' becomes a Waiting thread, shown with the quick-add history line", async () => {
  await quickAdd(ACME);
  await expect(page.getByRole("status").filter({ hasText: 'Added "Acme to pay the invoice"' })).toBeVisible();
  const [t] = await threads();
  expect(t).toMatchObject({ status: "waiting", waiting_on: "Acme" });
  await page.goto(`/threads/${t!.id}`);
  await expect(page.getByText("Added from quick add.")).toBeVisible();
});

test("a Medium item is not auto-created: the user goes to the review tray", async () => {
  const before = (await threads()).length;
  await quickAdd(MAYBE);
  await expect(page).toHaveURL(/\/review\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "I found 1 thing in this" })).toBeVisible();
  await expect(page.locator("p.text-body-strong", { hasText: "Ask Dana about the gutters" })).toBeVisible();
  expect((await threads()).length).toBe(before);
});

test("mixed: the High item is a thread, the tray shows only the Medium one, and the undo toast follows", async () => {
  const before = (await threads()).length;
  await quickAdd(MIXED);
  await expect(page).toHaveURL(/\/review\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "I found 1 thing in this" })).toBeVisible();
  const titles = page.locator("p.text-body-strong");
  await expect(titles.filter({ hasText: "Book a dentist visit" })).toBeVisible();
  await expect(titles.filter({ hasText: "Call the bank about the card" })).toHaveCount(0);
  const toast = page.getByRole("status").filter({ hasText: 'Added "Call the bank about the card"' });
  await expect(toast).toBeVisible();
  expect((await threads()).length).toBe(before + 1);
  await expectNoViolations();

  await page.getByRole("button", { name: "Undo add: Call the bank about the card" }).click();
  await expect(toast).toBeHidden();
  await expect.poll(async () => (await threads()).length).toBe(before);
});
