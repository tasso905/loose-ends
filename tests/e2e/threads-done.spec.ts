import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * S4 core loop against local Supabase and recorded LLM fixtures (AI_PROVIDER=fake; synthetic Mike
 * email): paste → accept → View in Today → Thread detail → Done → Undo, with axe on the Threads
 * index, Thread detail and the undo toast.
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const TITLE = "Send revised proposal to Mike";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let threadUrl = "";

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

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function expectNoViolations() {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function threadRow() {
  const uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  const { data: own } = await admin().from("threads").select("id, status, resolution, resolved_at").eq("user_id", uid);
  expect(own).toHaveLength(1);
  return own![0]!;
}

async function eventTypes(threadId: string) {
  const { data } = await admin().from("thread_events").select("type").eq("thread_id", threadId).order("id");
  return (data ?? []).map((e) => e.type as string);
}

test("paste → accept → View in Today lists the thread and links to its detail", async () => {
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByText("When was this written?").click();
  await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill("2026-10-05");
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();

  await page.getByRole("link", { name: "View in Today" }).click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
  // Interim Today: a plain list, no ranking or count claims.
  await expect(page.getByText(/worth your attention/i)).toHaveCount(0);
  const link = page.getByRole("list", { name: "Active threads" }).getByRole("link", { name: new RegExp(TITLE) });
  await expect(link).toBeVisible();
  await expectNoViolations();

  await link.click();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]{36}$/);
  threadUrl = page.url();
});

test("Thread detail: header, evidence in serif, history; tab title is the thread title; axe passes", async () => {
  await expect(page).toHaveTitle(TITLE);
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(page.locator("#thread-status")).toHaveText("Open");
  const quote = page.getByRole("region", { name: "Evidence" }).locator("blockquote");
  await expect(quote).toHaveText("I'll send you the revised proposal Friday");
  expect(await quote.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Plex Serif/i);
  await expect(page.getByRole("region", { name: "History" }).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await expectNoViolations();
});

test("Done runs at once (no dialog), shows an 8 s undo toast; Undo restores Open and appends 'undone'", async () => {
  page.on("dialog", () => {
    throw new Error("Done must not ask for confirmation (D8)");
  });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const status = page.getByRole("status").filter({ hasText: `Marked done: "${TITLE}"` });
  await expect(status).toBeVisible();
  await expect(page.locator("#thread-status")).toHaveText("Resolved");
  await expect(page.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  const t = await threadRow();
  expect(t).toMatchObject({ status: "resolved", resolution: "done" });
  expect(await eventTypes(t.id)).toEqual(["created", "resolved"]);

  const undo = page.getByRole("button", { name: `Undo done: ${TITLE}` });
  await undo.focus(); // focus pauses the timer
  await expectNoViolations();
  await page.keyboard.press("Enter"); // keyboard Undo
  await expect(page.locator("#thread-status")).toHaveText("Open");
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  // Focus returns to Done once it is back on the page (not left on the status line or <body>).
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: /Undo done/ })).toHaveCount(0);
  expect(await threadRow()).toMatchObject({ status: "open", resolution: null, resolved_at: null });
  expect(await eventTypes(t.id)).toEqual(["created", "resolved", "undone"]);
  await expect(page.getByRole("region", { name: "History" }).getByRole("listitem")).toHaveCount(3);
});

test("left alone, the toast leaves after 8 s and the thread stays Done; it then lists under Closed", async () => {
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const undo = page.getByRole("button", { name: `Undo done: ${TITLE}` });
  await expect(undo).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(undo).toHaveCount(0, { timeout: 12_000 });
  expect(await threadRow()).toMatchObject({ status: "resolved", resolution: "done" });

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Threads" }).click();
  await expect(page).toHaveURL(/\/threads$/);
  await expect(page.getByRole("tab", { name: "Active" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No open threads.")).toBeVisible();
  await expectNoViolations();
  await page.getByRole("tab", { name: "Closed" }).click();
  await expect(page).toHaveURL(/\/threads\?filter=closed$/);
  await expect(page.getByRole("tab", { name: "Closed" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Active" })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("tabpanel").getByRole("link", { name: new RegExp(TITLE) })).toContainText("Resolved");
  await expectNoViolations();
});

test("a stale Done (thread changed elsewhere) shows invalid_transition copy with Refresh", async () => {
  // Reopen behind the page's back (no Reopen UI yet): the page still shows Resolved, so set it to
  // open, load the page, then resolve it elsewhere.
  const t = await threadRow();
  await admin().from("threads").update({ status: "open", resolution: null, resolved_at: null }).eq("id", t.id);
  await page.goto(threadUrl);
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await admin().from("threads").update({ status: "waiting", waiting_on: "Mike" }).eq("id", t.id);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That change isn't possible any more. Refresh to see the latest." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  expect(await threadRow()).toMatchObject({ status: "waiting" });
});

test("an unknown or another user's thread id shows the plain not-found page", async () => {
  await page.goto(`/threads/${randomUUID()}`);
  await expect(page.getByRole("heading", { name: "This thread doesn't exist or was deleted." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Today" })).toBeVisible();

  // Another user's real thread reads the same.
  const other = testEmail();
  const { data: u } = await admin().auth.admin.createUser({ email: other, email_confirm: true });
  try {
    const { data: th } = await admin().from("threads").insert({ user_id: u.user!.id, title: "Someone else's thread", kind: "commitment" }).select("id").single();
    await page.goto(`/threads/${th!.id}`);
    await expect(page.getByRole("heading", { name: "This thread doesn't exist or was deleted." })).toBeVisible();
    await expect(page.getByText("Someone else's thread")).toHaveCount(0);
  } finally {
    await deleteUsers([other]);
  }
});
