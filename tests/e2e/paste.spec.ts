import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * S2 (F2 paste → F5 extraction → progress) against local Supabase and recorded LLM fixtures
 * (AI_PROVIDER=fake; tests/fixtures/llm, synthetic only). One signed-in user for the file.
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const MALFORMED = "This input always gets a malformed response.";
const SLOW = "Hi Dana, I'll book the venue for the team offsite by Thursday. Synthetic E2E fixture (slow response).";
const STAGES = /Reading…|Finding commitments…|Checking dates…/;

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

async function paste(text: string, writtenOn?: string) {
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(text);
  if (writtenOn) {
    await page.getByText("When was this written?").click();
    await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill(writtenOn);
    await expect(page.getByText("Assumed", { exact: true })).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Review source" }).click();
}

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function userId(): Promise<string> {
  const { data: users } = await admin().auth.admin.listUsers({ perPage: 1000 });
  return users.users.find((u) => u.email === email)!.id;
}

async function usageCount(): Promise<number> {
  const { data } = await admin().from("usage_counters").select("extractions").eq("user_id", await userId());
  return (data ?? []).reduce((n, r) => n + (r.extractions as number), 0);
}

async function expectNoViolations() {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("Add: written-on date is Assumed by default; over-limit shows the count and blocks submit", async () => {
  await page.goto("/add?mode=paste");
  await expect(page).toHaveTitle("Add · Loose Ends");
  await expect(page.getByText("Assumed", { exact: true })).toBeVisible();
  const submit = page.getByRole("button", { name: "Review source" });
  await expect(submit).toBeDisabled();
  await expectNoViolations();

  const box = page.getByLabel("Paste a message or document");
  await box.fill("a".repeat(26_999));
  await expect(page.getByText("/ 30,000")).toHaveCount(0);
  await box.fill("a".repeat(27_000));
  await expect(page.getByText("27,000 / 30,000")).toBeVisible();
  await box.fill("a".repeat(30_001));
  await expect(page.getByText("That's 30,001 characters. The limit is 30,000 — trim it or split it into two pastes.")).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(box).toHaveValue("a".repeat(30_001)); // never truncated
  await expectNoViolations();
});

test("title over 120 characters is reported at the field and kept whole; the counter is a polite live region", async () => {
  await page.goto("/add?mode=paste");
  await expect(page.locator("#text-counter")).toHaveAttribute("aria-live", "polite");
  await page.getByLabel("Paste a message or document").fill("Synthetic note.");
  await page.getByText("Add a title").click();
  const title = page.getByLabel("Title (optional)");
  await title.fill("t".repeat(121));
  await expect(title).toHaveValue("t".repeat(121)); // never truncated
  await expect(page.getByText("Titles can be up to 120 characters.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review source" })).toBeDisabled();
  await title.fill("t".repeat(120));
  await expect(page.getByText("Titles can be up to 120 characters.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review source" })).toBeEnabled();
});

test("paste the Mike email → verified proposals appear; the invented item is not shown", async () => {
  // Written Mon Oct 5, so "Friday" is Fri Oct 9 and chrono agrees with the model.
  await paste(MIKE, "2026-10-05");
  await expect(page).toHaveURL(/\/review\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  const likely = page.getByRole("region", { name: "Likely" });
  await expect(likely.getByText("Send revised proposal to Mike")).toBeVisible();
  await expect(likely.getByText("Clear commitment with a date.", { exact: false })).toBeVisible();
  await expect(likely.getByText("I'll send you the revised proposal Friday")).toBeVisible();
  await expect(page.getByText("Also noticed (1)")).toBeVisible();
  await expect(page.getByText("Call the insurer")).toHaveCount(0);
  await expectNoViolations();

  // The proposals survive a refresh (they are stored, not held in the page).
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible();
});

test("progress is visible within 500 ms of submit and shows real pipeline steps", async () => {
  // /add and /review were compiled by the earlier tests, so the dev server compile is not measured.
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(SLOW);
  const submit = page.getByRole("button", { name: "Review source" });
  const started = Date.now();
  await submit.click();
  await expect(page.getByRole("status")).toContainText(STAGES, { timeout: 500 });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(500);
  await expect(page.getByRole("status")).toContainText("Finding commitments…");
  await expect(page.getByRole("heading", { level: 1, name: "I found 1 thing in this" })).toBeVisible({ timeout: 20_000 });
});

test("an always-malformed response → extraction_failed with Try again (not counted again) and Back to Add", async () => {
  const before = await usageCount();
  await paste(MALFORMED);
  const message = page.getByText("Something went wrong reading this. Your text is saved.");
  await expect(message).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: "Back to Add" })).toHaveAttribute("href", "/add");
  await expectNoViolations();
  const firstUrl = page.url();
  expect(await usageCount()).toBe(before + 1);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).not.toHaveURL(firstUrl);
  await expect(message).toBeVisible({ timeout: 20_000 });
  expect(await usageCount()).toBe(before + 1);

  await page.getByRole("link", { name: "Back to Add" }).click();
  await expect(page).toHaveURL(/\/add$/);
});

test("poll API: own id 200, unknown id 404, signed out 401; unknown review page is not found", async ({ browser }) => {
  const url = page.url();
  await paste(MIKE);
  await expect(page).toHaveURL(/\/review\//);
  const id = page.url().split("/").pop()!;
  expect(url).not.toBe(page.url());

  const res = await page.request.get(`/api/extractions/${id}`);
  expect(res.status()).toBe(200);
  expect((await page.request.get("/api/extractions/3f1c2b4a-8d6e-4c1a-9b2e-7a5d3c1e0f9a")).status()).toBe(404);

  const anon = await browser.newContext();
  expect((await anon.request.get(`/api/extractions/${id}`)).status()).toBe(401);
  await anon.close();

  // A real 404, not a soft one: /review/[id] has no loading boundary above its notFound().
  const notFound = await page.goto("/review/3f1c2b4a-8d6e-4c1a-9b2e-7a5d3c1e0f9a");
  expect(notFound?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This doesn't exist or was deleted." })).toBeVisible();
});

test("a running extraction shows the slow copy after 45 s and fails after 90 s (A2)", async () => {
  // Seeded with the service role (test setup only): a source and a running attempt started 50 s ago.
  const db = admin();
  const uid = await userId();
  const { data: src } = await db
    .from("sources")
    .insert({ user_id: uid, kind: "paste", text_content: "Synthetic slow source.", reference_date: "2026-10-05", reference_date_source: "user" })
    .select("id")
    .single();
  const startedAt = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  const { data: ex } = await db
    .from("extractions")
    .insert({
      user_id: uid, source_id: src!.id, status: "running", stage: "finding", model: "fake:recorded",
      prompt_version: "extract.v1", schema_version: "extraction.v1", created_at: startedAt(50),
    })
    .select("id")
    .single();

  await page.goto(`/review/${ex!.id}`);
  await expect(page.getByRole("status")).toContainText("Finding commitments…");
  await expect(page.getByRole("status")).toContainText("Still working. I'll show results here.");
  await expectNoViolations();

  await db.from("extractions").update({ created_at: startedAt(95) }).eq("id", ex!.id);
  // The next poll marks it failed; the source is kept.
  await expect(page.getByText("Something went wrong reading this. Your text is saved.")).toBeVisible({ timeout: 5_000 });
  const { data: row } = await db.from("extractions").select("status, error").eq("id", ex!.id).single();
  expect(row).toEqual({ status: "failed", error: "timeout" });
});
