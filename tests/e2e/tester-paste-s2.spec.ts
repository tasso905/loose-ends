import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester S2 checks (F2 paste → F5 → progress) against local Supabase and recorded fixtures
 * (AI_PROVIDER=fake; synthetic only). Service-role writes are test setup only (seeding a state or
 * the usage counter), never the behaviour under test.
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const MALFORMED = "This input always gets a malformed response.";
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "375", width: 375, height: 800 },
] as const;

test.describe.configure({ mode: "serial" });

const emailA = testEmail();
const emailB = testEmail();
let ctxA: BrowserContext;
let page: Page;

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function uid(email: string): Promise<string> {
  const { data } = await admin().auth.admin.listUsers({ perPage: 1000 });
  return data.users.find((u) => u.email === email)!.id;
}
async function sourcesCount(email: string): Promise<number> {
  const { count } = await admin().from("sources").select("*", { count: "exact", head: true }).eq("user_id", await uid(email));
  return count ?? 0;
}
async function usage(email: string): Promise<number> {
  const { data } = await admin().from("usage_counters").select("extractions").eq("user_id", await uid(email));
  return (data ?? []).reduce((n, r) => n + (r.extractions as number), 0);
}
async function signIn(browser: Browser, email: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(p, email);
  await p.goto(await magicLinkFor(email, since));
  await expect(p).toHaveURL(/\/onboarding/);
  await p.getByRole("button", { name: "Skip" }).click();
  await expect(p).toHaveURL(/\/add$/);
  return { ctx, page: p };
}
async function axe(p: Page) {
  const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
/** Seeds a source + extraction in a given state for user A (test setup only). */
async function seed(status: "running" | "succeeded" | "failed", opts: { secondsAgo?: number; stage?: string | null } = {}) {
  const db = admin();
  const user = await uid(emailA);
  const { data: src } = await db
    .from("sources")
    .insert({ user_id: user, kind: "paste", text_content: "Synthetic tester source.", reference_date: "2026-10-05", reference_date_source: "user" })
    .select("id")
    .single();
  const { data: ex } = await db
    .from("extractions")
    .insert({
      user_id: user, source_id: src!.id, status, stage: status === "running" ? (opts.stage ?? "reading") : null,
      model: "fake:recorded", prompt_version: "extract.v1", schema_version: "extraction.v1",
      error: status === "failed" ? "ai_malformed" : null,
      created_at: new Date(Date.now() - (opts.secondsAgo ?? 0) * 1000).toISOString(),
    })
    .select("id")
    .single();
  return ex!.id as string;
}
async function targetsAtLeast44(p: Page, selector: string) {
  const small: string[] = [];
  for (const el of await p.locator(selector).all()) {
    if (!(await el.isVisible())) continue;
    const b = (await el.boundingBox())!;
    if (b.height < 44 || b.width < 44) small.push(`${(await el.textContent())?.trim().slice(0, 30) || (await el.getAttribute("id"))} ${Math.round(b.width)}x${Math.round(b.height)}`);
  }
  expect(small).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  ({ ctx: ctxA, page } = await signIn(browser, emailA));
});
test.afterAll(async () => {
  await ctxA?.close();
  await deleteUsers([emailA, emailB]);
});

test("/add: axe with both sections open at desktop and 375 px; 44 px targets at 375 px", async () => {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp);
    await page.goto("/add?mode=paste");
    await axe(page);
    await page.getByText("When was this written?").click();
    await page.getByText("Add a title").click();
    await page.getByLabel("Paste a message or document").fill("a".repeat(30_001));
    await expect(page.locator("main").getByRole("alert")).toContainText("That's 30,001 characters.");
    await axe(page);
    if (vp.name === "375") {
      await page.getByLabel("Paste a message or document").fill("hello");
      await targetsAtLeast44(page, "main button, main summary, main input:not([type=hidden])");
      const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollW).toBeLessThanOrEqual(375);
    }
  }
  await page.setViewportSize(VIEWPORTS[0]);
});

test("counter: described by the textarea from 27,000; over-limit is an alert, aria-invalid, submit blocked, text kept", async () => {
  await page.goto("/add?mode=paste");
  const box = page.getByLabel("Paste a message or document");
  await box.fill("a".repeat(27_000));
  await expect(box).toHaveAttribute("aria-describedby", /text-counter/);
  await expect(page.locator("#text-counter")).toHaveText("27,000 / 30,000");
  await box.fill("a".repeat(30_001));
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await expect(box).toHaveAttribute("aria-describedby", /text-error/);
  await expect(page.locator("main").getByRole("alert")).toHaveText("That's 30,001 characters. The limit is 30,000 — trim it or split it into two pastes.");
  await expect(page.getByRole("button", { name: "Review source" })).toBeDisabled();
  expect((await box.inputValue()).length).toBe(30_001);
  // Back under the limit clears the error.
  await box.press("Backspace");
  await expect(page.locator("#text-error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review source" })).toBeEnabled();
});

test("30,000 with 1,000 line breaks: counter, form submission (CRLF) and stored text all agree on 30,000", async () => {
  await page.goto("/add?mode=paste");
  const text = Array.from({ length: 1_000 }, () => "b".repeat(29)).join("\n") + "\n";
  expect(text.length).toBe(30_000);
  const box = page.getByLabel("Paste a message or document");
  await box.fill(text);
  await expect(page.locator("#text-counter")).toHaveText("30,000 / 30,000");
  await expect(page.locator("#text-error")).toHaveCount(0);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page).toHaveURL(/\/review\/[0-9a-f-]{36}$/);
  const { data } = await admin().from("sources").select("text_content").eq("user_id", await uid(emailA)).order("created_at", { ascending: false }).limit(1).single();
  expect((data!.text_content as string).length).toBe(30_000);
  expect(data!.text_content).not.toContain("\r");
});

test("written-on: Assumed by default → stored 'defaulted'; a picked date → stored 'user', no Assumed", async () => {
  await page.goto("/add?mode=paste");
  await expect(page.getByText("Assumed", { exact: true })).toBeVisible();
  await page.getByText("When was this written?").click();
  await expect(page.getByText("I assumed this was written today. Change it if it wasn't.")).toBeVisible();
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page).toHaveURL(/\/review\//);
  const latest = async () =>
    (await admin().from("sources").select("reference_date, reference_date_source").eq("user_id", await uid(emailA)).order("created_at", { ascending: false }).limit(1).single()).data;
  expect((await latest())!.reference_date_source).toBe("defaulted");

  await page.goto("/add?mode=paste");
  await page.getByText("When was this written?").click();
  await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill("2026-10-05");
  await expect(page.getByText("Assumed", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Mon Oct 5")).toBeVisible();
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page).toHaveURL(/\/review\//);
  expect(await latest()).toEqual({ reference_date: "2026-10-05", reference_date_source: "user" });
});

test("keyboard only: paste → open date → submit → results; Also noticed collapsed and opened by keyboard", async () => {
  await page.goto("/add?mode=paste");
  await page.keyboard.press("Tab"); // skip link or first control
  for (let i = 0; i < 10 && !(await page.getByLabel("Paste a message or document").evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(page.getByLabel("Paste a message or document")).toBeFocused();
  await page.keyboard.insertText(MIKE);
  await page.keyboard.press("Tab");
  await expect(page.locator("summary", { hasText: "When was this written?" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("I assumed this was written today. Change it if it wasn't.")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator("#written_on")).toBeFocused();
  // Leave the date as today (Assumed); Tab out through Chromium's month/day/year segments.
  const titleSummary = page.locator("summary", { hasText: "Add a title" });
  for (let i = 0; i < 4 && !(await titleSummary.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(titleSummary).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Review source" })).toBeFocused();
  await page.keyboard.press("Enter");
  // Written today (defaulted), "Friday" still resolves; the recording returns the same three items.
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });

  const also = page.locator("details", { hasText: "Also noticed (1)" });
  await expect(also).not.toHaveAttribute("open", "");
  await expect(page.getByText("Lunch with Mike")).toBeHidden();
  await also.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Lunch with Mike")).toBeVisible();
});

// DEFECT S2-4: a keyboard typo in the date field (e.g. "10052026" typed into the year segment gives
// year 100520) passes the browser, the server's Zod check rejects it as invalid_date, and submitPaste
// maps every non-length validation failure to save_failed: the page shows the retryable banner
// "That didn't save. Try again." with a Try again button that can never succeed. Safe behaviour: a
// field error at the date (or the browser's own min/max), never a retryable save failure.
test("an out-of-range written-on date is reported at the field, not as a retryable save failure", async () => {
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByText("When was this written?").click();
  // Set the slip's result directly: typing "10052026" gives year 100520 only where the date field is
  // year-first (en-CA); in an en-US browser it is a valid Oct 5, so typing made this test locale-dependent.
  await page.locator("#written_on").evaluate((el: HTMLInputElement) => {
    el.value = "100520-02-06";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const before = await sourcesCount(emailA);
  await page.getByRole("button", { name: "Review source" }).click();
  await page.waitForTimeout(1_500);
  expect(await sourcesCount(emailA)).toBe(before); // nothing stored either way
  await expect(page.locator("main").getByText("That didn't save. Try again.")).toHaveCount(0, { timeout: 1_000 });
});

test("done page (Mike): axe at desktop and 375 px with Also noticed open; 44 px summary; the unverified item is not in the HTML/RSC payload", async () => {
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  const url = page.url();
  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp);
    await page.goto(url);
    await page.getByText("Also noticed (1)").click();
    await axe(page);
    if (vp.name === "375") await targetsAtLeast44(page, "main summary, main button, main a");
  }
  await page.setViewportSize(VIEWPORTS[0]);
  // Rule 1 at the wire: neither the page HTML (incl. the RSC payload) nor the poll JSON carries the dropped item.
  const html = await (await page.request.get(url)).text();
  expect(html).not.toMatch(/insurer/i);
  const id = url.split("/").pop()!;
  const json = await (await page.request.get(`/api/extractions/${id}`)).text();
  expect(json).not.toMatch(/insurer/i);
  // Rule 9: the poll response never carries raw model output or the source text.
  expect(json).not.toContain("raw_output");
  expect(json).not.toContain("We should grab lunch sometime. ");
  expect(json).not.toContain("text_content");
});

test("running, slow, failed and zero states: axe at desktop and 375 px", async () => {
  const running = await seed("running", { stage: "finding" });
  const slow = await seed("running", { secondsAgo: 50, stage: "checking" });
  const failed = await seed("failed");
  const zero = await seed("succeeded");
  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp);
    await page.goto(`/review/${running}`);
    await expect(page.getByRole("status")).toHaveText("Finding commitments…");
    await axe(page);
    await page.goto(`/review/${slow}`);
    await expect(page.getByRole("status")).toContainText("Checking dates…");
    await expect(page.getByRole("status")).toContainText("Still working. I'll show results here.");
    await axe(page);
    await page.goto(`/review/${failed}`);
    await expect(page.locator("main").getByRole("alert")).toHaveText("Something went wrong reading this. Your text is saved.");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Add" })).toBeVisible();
    await axe(page);
    if (vp.name === "375") await targetsAtLeast44(page, "main button, main a");
    await page.goto(`/review/${zero}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing here needs your attention");
    await axe(page);
  }
  await page.setViewportSize(VIEWPORTS[0]);
});

test("prefers-reduced-motion: skeleton pulse stops at 0.8 opacity; the stage fade is effectively instant", async () => {
  const running = await seed("running", { stage: "reading" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/review/${running}`);
  await expect(page.getByRole("status")).toHaveText("Reading…");
  const sk = page.locator(".animate-skeleton").first();
  const style = await sk.evaluate((el) => ({ name: getComputedStyle(el).animationName, opacity: getComputedStyle(el).opacity }));
  expect(style).toEqual({ name: "none", opacity: "0.8" });
  const fade = await page.locator(".animate-fade-in").first().evaluate((el) => getComputedStyle(el).animationDuration);
  expect(parseFloat(fade)).toBeLessThanOrEqual(0.12); // ≤ 120 ms (DESIGN_STANDARD), in seconds
  await page.emulateMedia({ reducedMotion: null });
});

test("rule 10: an aborted submit shows the save error, stays on /add, keeps the text and creates nothing", async () => {
  await page.goto("/add?mode=paste");
  const before = await sourcesCount(emailA);
  await page.getByLabel("Paste a message or document").fill("Synthetic: aborted submit.");
  await page.route("**/add*", (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()));
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText(/That didn't save\. Try again\.|You're offline\. Nothing was saved\./);
  await expect(page).toHaveURL(/\/add/);
  await expect(page.getByLabel("Paste a message or document")).toHaveValue("Synthetic: aborted submit.");
  await page.unroute("**/add*");
  expect(await sourcesCount(emailA)).toBe(before);
});

test("rule 10: while the server has not answered, the page does not leave /add and the button is busy", async () => {
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(MIKE);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/add*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Review source" }).click();
  await page.waitForTimeout(1_000);
  await expect(page).toHaveURL(/\/add/);
  await expect(page.getByRole("button", { name: "Review source" })).toBeDisabled();
  await expect(page.locator("form")).toHaveAttribute("aria-busy", "true");
  release();
  await expect(page).toHaveURL(/\/review\//);
  await page.unroute("**/add*");
});

test("double submit: a double click and a repeated Enter create one source and one count", async () => {
  await page.goto("/add?mode=paste");
  const s0 = await sourcesCount(emailA);
  const u0 = await usage(emailA);
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).dblclick();
  await expect(page).toHaveURL(/\/review\//);
  await page.waitForTimeout(1_500);
  expect(await sourcesCount(emailA)).toBe(s0 + 1);
  expect(await usage(emailA)).toBe(u0 + 1);

  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/review\//);
  await page.waitForTimeout(1_500);
  expect(await sourcesCount(emailA)).toBe(s0 + 2);
});

test("rate limit: at 30 the submit shows the exact copy, stores nothing, keeps the text; Try again on a failure still works and is not counted", async () => {
  // Fail one first (counted), then move today's counter to the limit (test setup).
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(MALFORMED);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByText("Something went wrong reading this. Your text is saved.")).toBeVisible({ timeout: 20_000 });
  const failedUrl = page.url();
  const day = new Date().toISOString().slice(0, 10);
  await admin().from("usage_counters").update({ extractions: 30 }).eq("user_id", await uid(emailA)).eq("day", day);
  expect(await usage(emailA)).toBe(30);

  const before = await sourcesCount(emailA);
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill("Synthetic: the 31st.");
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("You've reached today's limit of 30 sources. It resets at midnight (UTC).");
  await expect(page).toHaveURL(/\/add/);
  await expect(page.getByLabel("Paste a message or document")).toHaveValue("Synthetic: the 31st.");
  // No retry button for a non-retryable error.
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect(await sourcesCount(emailA)).toBe(before);
  expect(await usage(emailA)).toBe(30);

  await page.goto(failedUrl);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).not.toHaveURL(failedUrl);
  await expect(page.getByText("Something went wrong reading this. Your text is saved.")).toBeVisible({ timeout: 20_000 });
  expect(await usage(emailA)).toBe(30);
});

test("cross-user via routes: B gets 404 from the poll API and the not-found page for A's extraction", async ({ browser }) => {
  const id = await seed("running");
  const done = await seed("succeeded");
  const b = await signIn(browser, emailB);
  for (const x of [id, done]) {
    const res = await b.page.request.get(`/api/extractions/${x}`);
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "This doesn't exist or was deleted.", retryable: false } });
    await b.page.goto(`/review/${x}`);
    await expect(b.page.getByRole("heading", { name: "This doesn't exist or was deleted." })).toBeVisible();
  }
  expect((await b.page.request.get("/api/extractions/not-a-uuid")).status()).toBe(404);
  // B's polls never changed A's row.
  const { data } = await admin().from("extractions").select("status").eq("id", id).single();
  expect(data!.status).toBe("running");
  await b.ctx.close();
});
