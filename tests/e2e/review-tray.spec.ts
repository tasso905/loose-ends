import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * S3 (F6 Review Tray) against local Supabase and recorded LLM fixtures (AI_PROVIDER=fake;
 * tests/fixtures/llm/mike-email, synthetic only): paste → accept → thread exists; the lunch line
 * sits under Also noticed, unchecked; reject + Undo; a rejected item is not proposed again.
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;

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

async function userId(): Promise<string> {
  const { data } = await admin().auth.admin.listUsers({ perPage: 1000 });
  return data.users.find((u) => u.email === email)!.id;
}

async function pasteMike() {
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByText("When was this written?").click();
  await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill("2026-10-05");
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page).toHaveURL(/\/review\/[0-9a-f-]{36}$/);
}

async function expectNoViolations() {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const likelyBox = () => page.getByRole("checkbox", { name: "Send revised proposal to Mike" });
const lunchBox = () => page.getByRole("checkbox", { name: "Lunch with Mike" });

test("tray: Likely pre-checked; the lunch line under Also noticed, collapsed and unchecked; axe passes", async () => {
  await pasteMike();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  await expect(likelyBox()).toBeChecked();
  await expect(page.getByRole("region", { name: "Likely" }).getByText("Clear commitment with a date.", { exact: false })).toBeVisible();

  const also = page.locator("details", { has: page.getByText("Also noticed (1)") });
  await expect(also).not.toHaveAttribute("open", /.*/);
  await expect(lunchBox()).toBeHidden();
  await expectNoViolations();

  await page.getByText("Also noticed (1)").click();
  await expect(lunchBox()).toBeVisible();
  await expect(lunchBox()).not.toBeChecked();
  await expect(also.getByText("Possible intention detected, but I'm not confident enough to remind you.", { exact: false })).toBeVisible();
  await expect(also.locator("blockquote")).toHaveText("We should grab lunch sometime");
  await expect(page.getByRole("button", { name: "Accept selected" })).toBeEnabled();
  await expectNoViolations();
});

test("Accept selected → N threads added · View in Today; the thread, its evidence and created event exist", async () => {
  const extractionId = page.url().split("/").pop()!;
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();
  await expect(page.getByRole("link", { name: "View in Today" })).toHaveAttribute("href", "/today");
  await expect(likelyBox()).toHaveCount(0);
  await expectNoViolations();

  const db = admin();
  const uid = await userId();
  const { data: threads } = await db.from("threads").select("id, title, kind, status, counterparty").eq("user_id", uid);
  expect(threads).toHaveLength(1);
  expect(threads![0]).toMatchObject({ title: "Send revised proposal to Mike", kind: "commitment", status: "open", counterparty: "Mike" });
  const threadId = threads![0]!.id as string;

  const { data: item } = await db.from("extraction_items").select("id, review_status, thread_id").eq("extraction_id", extractionId).eq("band", "high").single();
  expect(item).toMatchObject({ review_status: "accepted", thread_id: threadId });
  const { data: ev } = await db.from("evidence").select("quote, extraction_item_id").eq("thread_id", threadId);
  expect(ev).toEqual([{ quote: "I'll send you the revised proposal Friday", extraction_item_id: item!.id }]);
  const { data: events } = await db.from("thread_events").select("type, actor, after").eq("thread_id", threadId);
  expect(events).toHaveLength(1);
  expect(events![0]).toMatchObject({ type: "created", actor: "user", after: { via: "accept", extraction_item_id: item!.id } });

  // Survives a reload: the accepted item stays a result line, not a card.
  await page.reload();
  await expect(page.getByText("1 thread added")).toBeVisible();
  await expect(likelyBox()).toHaveCount(0);
});

test("Reject shows Rejected · Undo (stored); Undo restores it; a rejected item is not proposed on re-paste", async () => {
  const extractionId = page.url().split("/").pop()!;
  await page.getByText("Also noticed (1)").click();
  await page.getByRole("button", { name: "Reject: Lunch with Mike" }).click();
  await expect(page.getByText("Rejected ·")).toBeVisible();
  const undo = page.getByRole("button", { name: "Undo reject: Lunch with Mike" });
  await expect(undo).toBeFocused();
  await expectNoViolations();

  const db = admin();
  const lunch = async () =>
    (await db.from("extraction_items").select("review_status").eq("extraction_id", extractionId).eq("band", "low").single()).data;
  const suppressions = async () => (await db.from("suppressions").select("reason").eq("user_id", await userId())).data;
  expect(await lunch()).toEqual({ review_status: "rejected" });
  expect(await suppressions()).toEqual([{ reason: "rejected" }]);

  await undo.click();
  await expect(lunchBox()).toBeVisible();
  await expect(lunchBox()).not.toBeChecked();
  expect(await lunch()).toEqual({ review_status: "pending" });
  expect(await suppressions()).toEqual([]);

  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(page.getByText("Rejected ·")).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept selected" })).toHaveCount(0);

  await pasteMike();
  await expect(page.getByRole("heading", { level: 1, name: "I found 1 thing in this" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Lunch with Mike")).toHaveCount(0);
});
