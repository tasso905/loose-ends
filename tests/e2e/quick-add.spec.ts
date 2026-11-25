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

test("a lost response, then Try again: one thread, one source, one daily count, and the same Undo (D2)", async () => {
  for (const table of ["threads", "sources", "usage_counters"]) await admin().from(table).delete().eq("user_id", uid);
  let lose = true;
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST" || !lose) return route.continue();
    lose = false;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await quickAdd(PLUMBER);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Added "${PLUMBER}"` })).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const { data: src } = await admin().from("sources").select("id").eq("user_id", uid);
  const { data: use } = await admin().from("usage_counters").select("extractions").eq("user_id", uid);
  expect({ threads: (await threads()).length, sources: src!.length, counted: use![0]!.extractions }).toEqual({ threads: 1, sources: 1, counted: 1 });
  await page.getByRole("button", { name: `Undo add: ${PLUMBER}` }).click();
  await expect.poll(async () => (await threads()).length).toBe(0);
});

test("a lost response: the banner claims nothing, offline or not, and keeps newer text (D1, D2)", async () => {
  await admin().from("threads").delete().eq("user_id", uid);
  const unknown = page.getByText("I can't tell if your last line was added. Try again: it won't be added twice.");
  let lose = true;
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST" || !lose) return route.continue();
    lose = false;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await quickAdd(PLUMBER);
  await expect(unknown).toBeVisible();
  const field = page.getByRole("textbox", { name: "Quick add" });
  await expect(field).toBeFocused();
  await expectNoViolations();
  await field.fill("Buy stamps");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(unknown).toBeVisible();
  await expect(page.getByText("Nothing was saved")).toHaveCount(0);
  await context.setOffline(false);
  // Try again is about the lost line, not the text typed since.
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Added "${PLUMBER}"` })).toBeVisible();
  await expect(field).toHaveValue("Buy stamps");
  await expect(field).toBeFocused();
  expect(await threads()).toHaveLength(1);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a response that arrives after the Undo window says what was added, with no Undo (D4)", async () => {
  await admin().from("threads").delete().eq("user_id", uid);
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 11_500));
    await route.fulfill({ response });
  });
  await quickAdd(PLUMBER);
  await expect(page.getByRole("status").filter({ hasText: `Added "${PLUMBER}"` })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /^Undo add/ })).toHaveCount(0);
  await expectNoViolations();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect(await threads()).toHaveLength(1);
});

test("a lost Undo response claims nothing either way (D2)", async () => {
  await admin().from("threads").delete().eq("user_id", uid);
  await quickAdd(PLUMBER);
  const undo = page.getByRole("button", { name: `Undo add: ${PLUMBER}` });
  await expect(undo).toBeVisible();
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });
  await undo.click();
  await expect(page.getByText("I can't tell if that was undone. Check Threads to see.")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect(await threads()).toHaveLength(0);
});

test("after a 6 s response, Undo is withdrawn before the server would refuse it (D4)", async () => {
  await admin().from("threads").delete().eq("user_id", uid);
  let createdAt = 0;
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    createdAt = performance.now();
    await new Promise((r) => setTimeout(r, 6_000));
    await route.fulfill({ response });
  });
  await quickAdd(PLUMBER);
  const undo = page.getByRole("button", { name: `Undo add: ${PLUMBER}` });
  await expect(undo).toBeVisible({ timeout: 10_000 });
  await undo.focus(); // a focused toast does not time out on its own: only the limit closes it
  await expect(undo).toBeHidden({ timeout: 10_000 });
  expect(performance.now() - createdAt).toBeLessThan(12_000);
  await expect(page.getByRole("textbox", { name: "Quick add" })).toBeFocused();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("offline with another line after a lost response: Try again is about the line it names (D2)", async () => {
  await admin().from("threads").delete().eq("user_id", uid);
  let lose = true;
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST" || !lose) return route.continue();
    lose = false;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await quickAdd(PLUMBER);
  await expect(page.getByText("I can't tell if your last line was added.")).toBeVisible();
  const addLine = async (line: string) => {
    await page.getByRole("textbox", { name: "Quick add" }).fill(line);
    await page.getByRole("button", { name: "Add", exact: true }).click();
  };
  await context.setOffline(true);
  await addLine("Buy stamps");
  await expect(page.getByText("Nothing was saved")).toBeVisible();
  await addLine(PLUMBER);
  await expect(page.getByText("I can't tell if your last line was added.")).toBeVisible();
  await expect(page.getByText("Nothing was saved")).toHaveCount(0);
  await context.setOffline(false);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Added "${PLUMBER}"` })).toBeVisible();
  expect(await threads()).toHaveLength(1);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("an unknown line stays unknown while another is added via /review, until its own Try again (D5)", async () => {
  await admin().from("threads").delete().eq("user_id", uid);
  let lose = true;
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST" || !lose) return route.continue();
    lose = false;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await quickAdd(PLUMBER);
  const banner = page.getByRole("alert").filter({ hasText: "I can't tell if your last line was added." });
  await expect(banner).toContainText(PLUMBER);
  // B goes to /review; A is still unknown when the user comes back.
  await page.getByRole("textbox", { name: "Quick add" }).fill(MIXED);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page).toHaveURL(/\/review\//);
  await page.goBack();
  await expect(banner).toContainText(PLUMBER);
  const field = page.getByRole("textbox", { name: "Quick add" });
  await field.fill("typed since");
  const before = (await threads()).length;
  await expectNoViolations();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Added "${PLUMBER}"` })).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(field).toHaveValue("typed since");
  expect((await threads()).length).toBe(before);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("two unknown lines: each is named, and each Try again is about its own line (D5)", async () => {
  await admin().from("threads").delete().eq("user_id", uid);
  let lost = 0;
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST" || lost >= 2) return route.continue();
    lost += 1;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await quickAdd(PLUMBER);
  const banners = page.getByRole("alert").filter({ hasText: "I can't tell if your last line was added." });
  await expect(banners).toHaveCount(1);
  await page.getByRole("textbox", { name: "Quick add" }).fill(ACME);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(banners).toHaveCount(2);
  await expectNoViolations();
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry.first()).toHaveAccessibleDescription(PLUMBER);
  await retry.first().click();
  await expect(page.getByRole("status").filter({ hasText: `Added "${PLUMBER}"` })).toBeVisible();
  await expect(banners).toHaveCount(1);
  await expect(banners).toContainText(ACME);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("at the daily limit, an unknown line that was never stored is settled by the server's answer (D5)", async () => {
  await admin().from("threads").delete().eq("user_id", uid);
  let lose = true;
  await page.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST" || !lose) return route.continue();
    lose = false;
    await route.abort("connectionreset"); // never reached the server
  });
  await quickAdd(PLUMBER);
  const banner = page.getByRole("alert").filter({ hasText: "I can't tell if your last line was added." });
  await expect(banner).toBeVisible();
  await admin().from("usage_counters").update({ extractions: 30 }).eq("user_id", uid);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await admin().from("usage_counters").update({ extractions: 0 }).eq("user_id", uid);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
