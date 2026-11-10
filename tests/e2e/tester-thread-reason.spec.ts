import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";
import { settled } from "./settled";

/**
 * Lead-tester (fix/s9b-s10-thread-reason): Thread detail's Decision block, SITE_CONTRACT §2.7 as
 * amended by D58. A decision saved without a reason says "You didn't record a reason for this
 * decision." and offers "Add a reason now" (the shared NoReason form and addReasonAction):
 *  - rule 10: nothing appears under "You wrote" until the server confirms; a failed save shows the
 *    §2.13 copy and no reason;
 *  - rule 5: the reason is stored and shown exactly as typed;
 *  - History gains "You added a reason for your decision." and one reason_added event with before/after;
 *  - a second add (stale tab) is refused with invalid_transition and nothing is overwritten;
 *  - another user cannot add a reason to this decision;
 *  - keyboard path and focus; axe at desktop and 375 px; 44 px targets below 768 px.
 * Synthetic data only; recorded LLM fixtures are not needed (no model call on this page).
 */

test.describe.configure({ mode: "serial" });

const email = testEmail();
const otherEmail = testEmail();
const password = `pw-${randomUUID()}`;
let context: BrowserContext;
let page: Page;
let uid = "";
let otherClient: SupabaseClient;

const NO_REASON = "You didn't record a reason for this decision.";
const ADD = "Add a reason now";
const LABEL = "Want me to remember why?";
const HISTORY_LINE = "You added a reason for your decision.";
// Verbatim: leading spaces, two lines, a blank line, markup-like text, quotes, emoji, trailing spaces.
const REASON = "  Lighter on long days.\n\n<b>not bold</b> & \"quoted\" — it's 30% cheaper 🛶   ";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function axe(p: Page) {
  await settled(p);
  const results = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
const day = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();
const isServerAction = (route: Route) => route.request().method() === "POST" && "next-action" in route.request().headers();

/** A resolved decision thread with a decision that has no reason. */
async function seedDecision(title: string, choice: string, reason: string | null = null) {
  const db = admin();
  const t = await db.from("threads").insert({ user_id: uid, title, kind: "decision", status: "resolved", resolution: "decided", resolved_at: iso(-1) }).select("id").single();
  expect(t.error).toBeNull();
  const d = await db.from("decisions").insert({ user_id: uid, thread_id: t.data!.id, choice, reason_user: reason, context_facts: [], decided_at: iso(-1) }).select("id").single();
  expect(d.error).toBeNull();
  return { threadId: t.data!.id as string, decisionId: d.data!.id as string };
}
async function reasonEvents(threadId: string) {
  const { data } = await admin().from("thread_events").select("type, actor, before, after").eq("thread_id", threadId).eq("type", "reason_added");
  return data ?? [];
}

test.beforeAll(async ({ browser }) => {
  const db = admin();
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  uid = created.data.user!.id;
  const other = await db.auth.admin.createUser({ email: otherEmail, password, email_confirm: true });
  expect(other.error).toBeNull();
  const sb = localSupabase();
  otherClient = createClient(sb.url, sb.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await otherClient.auth.signInWithPassword({ email: otherEmail, password })).error).toBeNull();

  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Ftoday");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today/);
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email, otherEmail]);
});

test("no-reason state: the line and Add a reason now; no You wrote; keyboard open/cancel returns focus; axe at desktop", async () => {
  const { threadId } = await seedDecision("Pick a kayak", "The touring kayak");
  await page.goto(`/threads/${threadId}`);
  await expect(page.getByText(NO_REASON)).toBeVisible();
  await expect(page.getByText("You wrote", { exact: false })).toHaveCount(0);
  const add = page.getByRole("button", { name: ADD });
  await expect(add).toBeVisible();
  await axe(page);

  await add.focus();
  await page.keyboard.press("Enter");
  const field = page.getByLabel(LABEL);
  await expect(field).toBeFocused();
  await axe(page);
  // Blank is refused at the field, with no server call.
  let calls = 0;
  await page.route("**/threads/**", (route) => {
    if (isServerAction(route)) calls++;
    return route.continue();
  });
  await field.fill("   \n  ");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Write a reason first.")).toBeVisible();
  await expect(field).toBeFocused();
  expect(calls).toBe(0);
  await page.unroute("**/threads/**");

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel(LABEL)).toHaveCount(0);
  await expect(page.getByRole("button", { name: ADD })).toBeFocused();
});

test("rule 10: nothing under You wrote until the server confirms; then the reason verbatim, focus on it, History line, one event", async () => {
  const { threadId, decisionId } = await seedDecision("Pick a canoe paddle", "The bent-shaft paddle");
  await page.goto(`/threads/${threadId}`);
  await page.getByRole("button", { name: ADD }).click();
  await page.getByLabel(LABEL).fill(REASON);

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  await page.route("**/threads/**", async (route) => {
    if (isServerAction(route) && !held) {
      held = true;
      await gate;
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => held).toBe(true);
  // While the server has not answered: no You wrote, no reason text, Save disabled, field still there.
  await expect(page.getByText("You wrote")).toHaveCount(0);
  // (The text is still in the user's own field; it must not be rendered as a stored reason.)
  await expect(page.locator(`#reason-${decisionId}`)).toHaveCount(0);
  await expect(page.locator("blockquote", { hasText: "Lighter on long days." })).toHaveCount(0);
  await expect(page.getByText(NO_REASON)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await page.waitForTimeout(500);
  await expect(page.getByText("You wrote")).toHaveCount(0);
  await expect(page.locator(`#reason-${decisionId}`)).toHaveCount(0);
  expect((await admin().from("decisions").select("reason_user").eq("id", decisionId).single()).data!.reason_user).toBeNull();
  release();

  const fig = page.locator(`#reason-${decisionId}`);
  await expect(fig).toBeVisible();
  await expect(fig.locator("figcaption")).toContainText("You wrote");
  // Verbatim: the DOM text is exactly what was typed (whitespace-pre-wrap keeps spaces and lines).
  expect(await fig.locator("blockquote").evaluate((el) => el.textContent)).toBe(REASON);
  expect(await fig.locator("blockquote").evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");
  // You wrote voice: Plex Sans, never serif (serif is for source quotes), never italic.
  const style = await fig.locator("blockquote").evaluate((el) => ({ f: getComputedStyle(el).fontFamily, s: getComputedStyle(el).fontStyle }));
  expect(style.f.split(",")[0]).toMatch(/plexSans|Plex Sans/i);
  expect(style.s).toBe("normal");
  await expect(fig).toBeFocused();
  await expect(page.getByText(NO_REASON)).toHaveCount(0);
  await expect(page.getByRole("button", { name: ADD })).toHaveCount(0);
  // No markup was interpreted.
  await expect(fig.locator("blockquote b")).toHaveCount(0);

  expect((await admin().from("decisions").select("reason_user").eq("id", decisionId).single()).data!.reason_user).toBe(REASON);
  const events = await reasonEvents(threadId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ actor: "user", before: { decision_id: decisionId, reason_user: null }, after: { decision_id: decisionId, reason_user: REASON } });
  // History gains its line after the refresh, and keeps it on reload.
  const history = page.getByRole("region", { name: "History" });
  await expect(history.getByText(HISTORY_LINE)).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("region", { name: "History" }).getByText(HISTORY_LINE)).toHaveCount(1);
  expect(await page.locator(`#reason-${decisionId} blockquote`).evaluate((el) => el.textContent)).toBe(REASON);
  await expect(page.getByText(NO_REASON)).toHaveCount(0);
  await axe(page);
  await page.unroute("**/threads/**");
});

test("rule 10 failure: a save that never reaches the server shows the §2.13 copy and no You wrote; nothing stored", async () => {
  const { threadId, decisionId } = await seedDecision("Pick a tent", "The two-person tent");
  await page.goto(`/threads/${threadId}`);
  await page.getByRole("button", { name: ADD }).click();
  await page.getByLabel(LABEL).fill("Packs small.");
  await page.route("**/threads/**", (route) => (isServerAction(route) ? route.abort("failed") : route.continue()));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("That didn't save. Try again.")).toBeVisible();
  await expect(page.getByText("You wrote")).toHaveCount(0);
  await expect(page.locator(`#reason-${decisionId}`)).toHaveCount(0);
  await expect(page.getByLabel(LABEL)).toHaveValue("Packs small.");
  await page.unroute("**/threads/**");
  expect((await admin().from("decisions").select("reason_user").eq("id", decisionId).single()).data!.reason_user).toBeNull();
  expect(await reasonEvents(threadId)).toHaveLength(0);
});

test("a second add is refused: a stale tab gets invalid_transition copy, shows no You wrote, and the first reason stays", async () => {
  const { threadId, decisionId } = await seedDecision("Pick a stove", "The canister stove");
  const stale = await context.newPage();
  await stale.goto(`/threads/${threadId}`);
  await page.goto(`/threads/${threadId}`);

  await page.getByRole("button", { name: ADD }).click();
  await page.getByLabel(LABEL).fill("Boils fast.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(`#reason-${decisionId} blockquote`)).toHaveText("Boils fast.");

  await stale.getByRole("button", { name: ADD }).click();
  await stale.getByLabel(LABEL).fill("Second reason that must not be stored.");
  await stale.getByRole("button", { name: "Save" }).click();
  await expect(stale.getByText("That change isn't possible any more. Refresh to see the latest.")).toBeVisible();
  await expect(stale.getByText("You wrote")).toHaveCount(0);
  await expect(stale.locator(`#reason-${decisionId}`)).toHaveCount(0);
  await expect(stale.locator("blockquote", { hasText: "Second reason that must not be stored." })).toHaveCount(0);
  await axe(stale);
  await stale.close();

  expect((await admin().from("decisions").select("reason_user").eq("id", decisionId).single()).data!.reason_user).toBe("Boils fast.");
  expect(await reasonEvents(threadId)).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole("region", { name: "History" }).getByText(HISTORY_LINE)).toHaveCount(1);
});

test("a decision that already has a reason shows it verbatim and offers no Add a reason now", async () => {
  const { threadId } = await seedDecision("Pick a map", "The waterproof map", "Rain all week.");
  await page.goto(`/threads/${threadId}`);
  await expect(page.getByText("Rain all week.", { exact: true })).toBeVisible();
  await expect(page.getByText(NO_REASON)).toHaveCount(0);
  await expect(page.getByRole("button", { name: ADD })).toHaveCount(0);
});

test("another user cannot add a reason (RPC returns not_found; nothing written) or see the decision", async () => {
  const { threadId, decisionId } = await seedDecision("Pick a lantern", "The LED lantern");
  const { data, error } = await otherClient.rpc("decision_add_reason", { p_decision_id: decisionId, p_reason: "Hijack.", p_now: new Date().toISOString() });
  expect(error).toBeNull();
  expect(data).toMatchObject({ ok: false, error: "not_found" });
  expect((await otherClient.from("decisions").select("id").eq("id", decisionId)).data).toEqual([]);
  expect((await otherClient.from("thread_events").select("id").eq("thread_id", threadId)).data).toEqual([]);
  // Direct writes are refused too.
  await otherClient.from("decisions").update({ reason_user: "Hijack." }).eq("id", decisionId);
  expect((await admin().from("decisions").select("reason_user").eq("id", decisionId).single()).data!.reason_user).toBeNull();
  expect(await reasonEvents(threadId)).toHaveLength(0);
  // The owner still sees the no-reason state.
  await page.goto(`/threads/${threadId}`);
  await expect(page.getByText(NO_REASON)).toBeVisible();
});

test("375 px: no-reason state, open form and saved reason pass axe; targets are at least 44 px; no horizontal scroll", async () => {
  const { threadId, decisionId } = await seedDecision("Pick a sleeping pad", "The foam pad");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/threads/${threadId}`);
  await expect(page.getByText(NO_REASON)).toBeVisible();
  await axe(page);
  const add = page.getByRole("button", { name: ADD });
  expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await add.click();
  await axe(page);
  for (const name of ["Save", "Cancel"]) expect((await page.getByRole("button", { name }).boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
  await page.getByLabel(LABEL).fill("Never punctures.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(`#reason-${decisionId} blockquote`)).toHaveText("Never punctures.");
  await axe(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
});
