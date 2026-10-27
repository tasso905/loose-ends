import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * S9b "Add a reason now" (D58; SITE_CONTRACT §2.11, CONTENT_MODEL §10) against local Supabase and
 * the recorded Ask-why answer tests/fixtures/llm/e2e-add-reason.ask-why.json (AI_PROVIDER=fake).
 * The decision is seeded without a reason; the recording cites it with a user_reason part, which
 * the server drops until a reason exists, and then shows the stored reason verbatim.
 */

const DEC = "e2e5b9b0-0000-4000-8000-000000000001";
const ASK = "Why did I pick the pool gym?";
const REASON = "  The pool is open early,\nand it's on my way to work.  ";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let threadId = "";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function expectNoViolations() {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const box = () => page.getByRole("textbox", { name: "Ask about a past decision" });
const card = () => page.getByRole("article");
const field = () => card().getByRole("textbox", { name: "Want me to remember why?" });

async function ask() {
  await box().fill(ASK);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(card()).toHaveCount(1, { timeout: 15_000 });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fdecisions");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  const db = admin();
  const uid = (await db.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  await db.from("decisions").delete().eq("id", DEC); // leftovers from an aborted run
  const { data: th } = await db
    .from("threads")
    .insert({ user_id: uid, title: "Choose a gym", kind: "decision", status: "resolved", resolution: "decided", resolved_at: "2026-10-18T14:05:00Z" })
    .select("id")
    .single();
  threadId = th!.id as string;
  const { error } = await db.from("decisions").insert({ id: DEC, user_id: uid, thread_id: threadId, choice: "Joined the pool gym", reason_user: null, context_facts: [], decided_at: "2026-10-18T14:05:00Z" });
  expect(error).toBeNull();
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("the no-reason state offers Add a reason now; Cancel closes the field and returns focus", async () => {
  await page.goto("/decisions");
  await ask();
  await expect(card().getByText("You didn't record a reason for this decision.")).toBeVisible();
  const add = card().getByRole("button", { name: "Add a reason now" });
  await add.click();
  await expect(field()).toBeFocused();
  await expectNoViolations();
  await card().getByRole("button", { name: "Cancel" }).click();
  await expect(field()).toHaveCount(0);
  await expect(add).toBeFocused();
});

test("a blank reason is refused at the field and nothing is saved", async () => {
  await card().getByRole("button", { name: "Add a reason now" }).click();
  await field().fill(" \n ");
  await card().getByRole("button", { name: "Save" }).click();
  await expect(card().getByText("Write a reason first.")).toBeVisible();
  await expect(field()).toHaveAttribute("aria-invalid", "true");
  await expect(field()).toBeFocused();
  const { data } = await admin().from("decisions").select("reason_user").eq("id", DEC).single();
  expect(data!.reason_user).toBeNull();
});

test("Save stores the reason verbatim, shows it as You wrote only after the server confirms, and Ask why shows it", async () => {
  await field().fill(REASON);
  await card().getByRole("button", { name: "Save" }).click();
  await expect(card().getByTestId("reason")).toHaveText(REASON, { useInnerText: false });
  expect(await card().getByTestId("reason").textContent()).toBe(REASON);
  await expect(card().getByText("You wrote:")).toBeVisible();
  await expect(card().getByText("You didn't record a reason for this decision.")).toHaveCount(0);
  await expect(card().getByRole("button", { name: "Add a reason now" })).toHaveCount(0);
  await expect(page.locator(`#reason-${DEC}`)).toBeFocused();
  const { data } = await admin().from("decisions").select("reason_user").eq("id", DEC).single();
  expect(data!.reason_user).toBe(REASON);
  const { data: ev } = await admin().from("thread_events").select("type, actor, before, after").eq("thread_id", threadId).order("id");
  expect(ev).toEqual([{ type: "reason_added", actor: "user", before: { decision_id: DEC, reason_user: null }, after: { decision_id: DEC, reason_user: REASON } }]);
  await expectNoViolations();

  // A fresh ask answers with the new reason, verbatim.
  await page.goto("/decisions");
  await ask();
  expect(await card().getByTestId("reason").textContent()).toBe(REASON);
  await expect(card().getByRole("button", { name: "Add a reason now" })).toHaveCount(0);
});

test("a second tab cannot replace the reason: the stale page is refused and the stored reason stays", async () => {
  await admin().from("decisions").update({ reason_user: null }).eq("id", DEC);
  await page.goto("/decisions");
  await ask();
  await admin().from("decisions").update({ reason_user: "Set elsewhere" }).eq("id", DEC);
  await card().getByRole("button", { name: "Add a reason now" }).click();
  await field().fill("Mine");
  await card().getByRole("button", { name: "Save" }).click();
  await expect(card().getByText("That change isn't possible any more. Refresh to see the latest.")).toBeVisible();
  await expect(card().getByTestId("reason")).toHaveCount(0);
  const { data } = await admin().from("decisions").select("reason_user").eq("id", DEC).single();
  expect(data!.reason_user).toBe("Set elsewhere");
});

test("375 px: the field and buttons fit, with 44 px targets", async () => {
  await admin().from("decisions").update({ reason_user: null }).eq("id", DEC);
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/decisions");
  await ask();
  const add = card().getByRole("button", { name: "Add a reason now" });
  expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await add.click();
  expect((await card().getByRole("button", { name: "Save" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoViolations();
  await page.setViewportSize({ width: 1280, height: 800 });
});
