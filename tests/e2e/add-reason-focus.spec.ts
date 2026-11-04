import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Focus after "Add a reason now" → Save (WCAG 2.4.3; CI flake on #33 / #34, Nov 2). Focus used to
 * move in a requestAnimationFrame after the reason was set, which raced React's commit (and, on
 * Thread detail, the router.refresh() that adds the History line): when the frame fired first, the
 * reason element did not exist yet and focus fell to <body>. These tests force both orders every run:
 *  - every animation frame fires at once (a microtask), before React can commit the reason;
 *  - Thread detail's refresh response is held back until well after the reason is shown.
 * Synthetic data; the Ask-why answer is the recording add-reason.spec.ts uses.
 */

const DEC = "e2e5b9b0-0000-4000-8000-000000000001";
const ASK = "Why did I pick the pool gym?";
const LABEL = "Want me to remember why?";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** From now on every animation frame fires at once: the order in which the old code lost focus. */
async function framesFireFirst(p: Page) {
  await p.evaluate(() => {
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(performance.now()));
      return 0;
    };
  });
}

/** A resolved decision thread whose decision has no reason. */
async function seedDecision(title: string, id?: string) {
  const db = admin();
  if (id) await db.from("decisions").delete().eq("id", id); // leftovers from an aborted run
  const t = await db
    .from("threads")
    .insert({ user_id: uid, title, kind: "decision", status: "resolved", resolution: "decided", resolved_at: "2026-10-18T14:05:00Z" })
    .select("id")
    .single();
  expect(t.error).toBeNull();
  const d = await db
    .from("decisions")
    .insert({ ...(id ? { id } : {}), user_id: uid, thread_id: t.data!.id, choice: "Joined the pool gym", reason_user: null, context_facts: [], decided_at: "2026-10-18T14:05:00Z" })
    .select("id")
    .single();
  expect(d.error).toBeNull();
  return { threadId: t.data!.id as string, decisionId: d.data!.id as string };
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Ftoday");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today/, { timeout: 60_000 });
  uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("Ask why: focus lands on the saved reason even when the frame fires before React commits", async () => {
  await seedDecision("Choose a gym", DEC);
  await page.goto("/decisions");
  await page.getByRole("textbox", { name: "Ask about a past decision" }).fill(ASK);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const card = page.getByRole("article");
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await card.getByRole("button", { name: "Add a reason now" }).click();
  await card.getByLabel(LABEL).fill("Open early and on my way.");
  await framesFireFirst(page);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByTestId("reason")).toBeVisible();
  await expect(page.locator(`#reason-${DEC}`)).toBeFocused();
});

test("Thread detail: focus stays on the saved reason when the refresh lands late", async () => {
  const { threadId, decisionId } = await seedDecision("Choose a pool");
  await page.goto(`/threads/${threadId}`);
  await page.getByRole("button", { name: "Add a reason now" }).click();
  await page.getByLabel(LABEL).fill("Closer to work.");
  await framesFireFirst(page);

  // Hold the refresh (an RSC GET after the action) until the reason is shown and focused.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  await page.route(`**/threads/${threadId}*`, async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET" && "rsc" in req.headers()) {
      held += 1;
      await gate;
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Save" }).click();
  const reason = page.locator(`#reason-${decisionId}`);
  await expect(reason).toBeVisible();
  await expect(reason).toBeFocused();
  await expect.poll(() => held).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  release();
  // The refresh landed: History has its line, and focus is still on the reason.
  await expect(page.getByText("You added a reason for your decision.")).toBeVisible({ timeout: 10_000 });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await expect(reason).toBeFocused();
});
