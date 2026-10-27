import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester S10 (F10 Today, F8 Why) and S9b (Add a reason now, D58) on the page, against local
 * Supabase and recorded LLM fixtures (AI_PROVIDER=fake; no live model):
 *  - Today at desktop and 375 px with axe, with attention rows, collapsed sections and the Why sheet;
 *  - a thread whose snooze has passed is in attention and Done works from it (snoozed → resolved);
 *  - the Why sheet returns focus to the Why? link that opened it (Close, Escape, scrim); fonts;
 *  - an added reason appears as You wrote only after the server confirms (rule 10), verbatim, in
 *    Plex Sans with no italics;
 *  - Undo of a Decided resolve is refused once a reason was added in the undo window, and nothing is lost.
 */

const CANOE_DEC = "7e57a9a0-0000-4000-8000-000000000010";
const CANOE_Q = "Why did I sell the old canoe?"; // tests/fixtures/llm/tester-s9b-add-reason.ask-why.json

test.describe.configure({ mode: "serial" });

const email = testEmail();
const password = `pw-${randomUUID()}`;
let context: BrowserContext;
let page: Page;
let uid = "";
let userClient: SupabaseClient;
const ids: Record<string, string> = {};

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function axe(p: Page, include?: string) {
  let b = new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (include) b = b.include(include);
  const results = await b.analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
const day = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();
const isServerAction = (method: string, headers: Record<string, string>) => method === "POST" && "next-action" in headers;
const rowFor = (title: string) => page.getByTestId("attention-row").filter({ has: page.getByRole("link", { name: title, exact: true }) });

test.beforeAll(async ({ browser }) => {
  const db = admin();
  // Create the user with a password first (a later password change would end the browser session),
  // so the test can also call RPCs as them (auth.uid()) from a second supabase-js session.
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  uid = created.data.user!.id;
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Ftoday");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today/);

  const sb = localSupabase();
  userClient = createClient(sb.url, sb.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await userClient.auth.signInWithPassword({ email, password })).error).toBeNull();

  await db.from("decisions").delete().eq("id", CANOE_DEC);
  const mk = async (key: string, row: Record<string, unknown>) => {
    const { data, error } = await db.from("threads").insert({ user_id: uid, kind: "commitment", status: "open", ...row }).select("id").single();
    expect(error, key).toBeNull();
    ids[key] = data!.id as string;
  };
  for (let i = 1; i <= 6; i++) await mk(`over${i}`, { title: `Overdue chore ${i}`, due_at: iso(-i), counterparty: i === 1 ? "Mike" : null });
  await mk("woke", { title: "Snooze has passed", status: "snoozed", snoozed_until: iso(-0.5), due_at: iso(-10) });
  await mk("asleep", { title: "Still asleep", status: "snoozed", snoozed_until: iso(3), due_at: iso(-10) });
  await mk("wait", { title: "Waiting on the plumber", status: "waiting", waiting_on: "Delgado Plumbing", expected_by: iso(5) });
  await mk("soon", { title: "Coming up later", due_at: iso(9), confidence: 0.5 });
  await mk("canoe", { title: "Old canoe", kind: "decision", status: "resolved", resolution: "decided", resolved_at: iso(-2) });
  const ins = await db.from("decisions").insert({ id: CANOE_DEC, user_id: uid, thread_id: ids.canoe, choice: "Sold the old canoe", reason_user: null, context_facts: [], decided_at: iso(-2) });
  expect(ins.error).toBeNull();
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("Today (desktop): at most 5 rows, the passed snooze is ranked, the future snooze is nowhere; axe passes", async () => {
  await page.goto("/today");
  const rows = page.getByTestId("attention-row");
  await expect(rows).toHaveCount(5);
  // The woken thread is the most overdue (10 days): it ranks first.
  await expect(rows.first().getByRole("link", { name: "Snooze has passed", exact: true })).toBeVisible();
  await expect(page.getByText("Still asleep")).toHaveCount(0);
  for (const r of await rows.all()) {
    await expect(r.getByTestId("reason-line")).not.toBeEmpty();
    await expect(r.getByRole("link", { name: "Why?" })).toBeVisible();
  }
  await expect(page.getByTestId("section-waiting")).toContainText("1");
  await expect(page.getByTestId("section-coming-up")).toBeVisible();
  await expect(page.getByTestId("section-resolved")).toBeVisible();
  await axe(page);
});

test("Why sheet: focus returns to the Why? link that opened it after Close, Escape and a scrim click; the sheet passes axe", async () => {
  await page.goto("/today");
  const link = rowFor("Overdue chore 3").getByRole("link", { name: "Why?" });
  const dialog = page.getByRole("dialog", { name: "Why am I seeing this?" });

  await link.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("why-now")).toHaveText("It's still open. It's 3 days overdue.");
  await axe(page, "dialog");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(link).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(link).toBeFocused();

  await link.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(40, 400); // the scrim, left of the 440 px side sheet
  await expect(dialog).toBeHidden();
  await expect(link).toBeFocused();
});

test("Why sheet fonts: nothing italic; Plex Sans except the source quote", async () => {
  await rowFor("Overdue chore 3").getByRole("link", { name: "Why?" }).click();
  const dialog = page.getByRole("dialog", { name: "Why am I seeing this?" });
  await expect(dialog.getByTestId("why-now")).toBeVisible();
  const styles = await dialog.evaluate((root) =>
    Array.from(root.querySelectorAll("*")).map((el) => ({ style: getComputedStyle(el).fontStyle, family: getComputedStyle(el).fontFamily, serif: el.closest(".font-serif") !== null, tag: el.tagName })),
  );
  for (const s of styles) {
    expect(s.style, s.tag).toBe("normal");
    if (!s.serif && s.tag !== "svg" && s.tag !== "path") expect(s.family, s.tag).toMatch(/Plex.?Sans/i);
  }
  await page.keyboard.press("Escape");
});

test("the woken (snoozed) row: Done works from Today, the toast offers Undo, and Undo brings it back", async () => {
  await page.goto("/today");
  const row = rowFor("Snooze has passed");
  await row.getByRole("button", { name: /Done/ }).click();
  await expect(page.getByText('Marked done: "Snooze has passed"')).toBeVisible();
  await expect(rowFor("Snooze has passed")).toHaveCount(0);
  const t = (await admin().from("threads").select("status, resolution").eq("id", ids.woke).single()).data!;
  expect(t).toEqual({ status: "resolved", resolution: "done" });
  await page.getByRole("button", { name: "Undo done: Snooze has passed" }).click();
  await expect(rowFor("Snooze has passed")).toHaveCount(1, { timeout: 10_000 });
  expect((await admin().from("threads").select("status").eq("id", ids.woke).single()).data!.status).toBe("snoozed");
});

test("Today at 375 px: no horizontal scroll, 44 px targets, Why is a bottom sheet; axe passes on the page and the sheet", async () => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/today");
  await expect(page.getByTestId("attention-row")).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const first = page.getByTestId("attention-row").first();
  for (const el of [...(await first.getByRole("link").all()), ...(await first.getByRole("button").all())]) {
    expect((await el.boundingBox())!.height, (await el.getAttribute("aria-label")) ?? (await el.textContent()) ?? "").toBeGreaterThanOrEqual(44);
  }
  await axe(page);
  await first.getByRole("link", { name: "Why?" }).click();
  const dialog = page.getByRole("dialog", { name: "Why am I seeing this?" });
  await expect(dialog.getByTestId("why-now")).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(370);
  expect(box.y + box.height).toBeGreaterThanOrEqual(739);
  expect(box.height).toBeLessThanOrEqual(740 * 0.85 + 1);
  await axe(page, "dialog");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("Add a reason now: You wrote appears only after the server confirms (rule 10), verbatim, Plex Sans, no italics; focus moves to it", async () => {
  await page.goto("/decisions");
  await page.getByRole("textbox", { name: "Ask about a past decision" }).fill(CANOE_Q);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const card = page.getByRole("article");
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(card.getByText("You didn't record a reason for this decision.")).toBeVisible();
  await card.getByRole("button", { name: "Add a reason now" }).click();
  const field = card.getByLabel("Want me to remember why?");
  await expect(field).toBeFocused();
  const reason = "  It leaked,\nand the club had a spare.  ";
  await field.fill(reason);

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/decisions*", async (route) => {
    if (isServerAction(route.request().method(), route.request().headers())) await gate;
    await route.continue();
  });
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(card.getByText("You wrote:")).toHaveCount(0);
  await expect(card.getByTestId("reason")).toHaveCount(0);
  release();
  await expect(card.getByTestId("reason")).toBeVisible({ timeout: 10_000 });
  await page.unrouteAll();
  expect(await card.getByTestId("reason").textContent()).toBe(reason);
  await expect(card.getByText("You wrote:")).toBeVisible();
  await expect(card.getByText("You didn't record a reason for this decision.")).toHaveCount(0);
  await expect(card.locator("figure").filter({ has: page.getByTestId("reason") })).toBeFocused();
  const st = await card.getByTestId("reason").evaluate((el) => ({ family: getComputedStyle(el).fontFamily, style: getComputedStyle(el).fontStyle }));
  expect(st.family).toMatch(/Plex.?Sans/i);
  expect(st.style).toBe("normal");
  expect((await admin().from("decisions").select("reason_user").eq("id", CANOE_DEC).single()).data!.reason_user).toBe(reason);
  await axe(page);
});

test("Add a reason now: a server refusal never shows the reason (rule 10); the field keeps the text and shows the copy", async () => {
  // Fresh decision with no reason; the server will refuse because another tab adds one first.
  const db = admin();
  await db.from("decisions").update({ reason_user: null }).eq("id", CANOE_DEC);
  await page.goto("/decisions");
  await page.getByRole("textbox", { name: "Ask about a past decision" }).fill(CANOE_Q);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const card = page.getByRole("article");
  await expect(card.getByRole("button", { name: "Add a reason now" })).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: "Add a reason now" }).click();
  await card.getByLabel("Want me to remember why?").fill("This tab's words.");
  expect((await userClient.rpc("decision_add_reason", { p_decision_id: CANOE_DEC, p_reason: "Other tab won.", p_now: new Date().toISOString() })).data).toMatchObject({ ok: true });
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("That change isn't possible any more. Refresh to see the latest.")).toBeVisible();
  await expect(card.getByTestId("reason")).toHaveCount(0);
  await expect(card.locator("blockquote, figure")).toHaveCount(0); // never shown as You wrote; only the textarea holds it
  await expect(card.getByText("You wrote:")).toHaveCount(0);
  await expect(card.getByLabel("Want me to remember why?")).toHaveValue("This tab's words.");
  expect((await db.from("decisions").select("reason_user").eq("id", CANOE_DEC).single()).data!.reason_user).toBe("Other tab won.");
});

test("Undo of a Decided resolve after a reason was added in the undo window: refused with the §2.13 copy; thread, decision and reason intact", async () => {
  const db = admin();
  const { data } = await db.from("threads").insert({ user_id: uid, title: "Pick a kayak", kind: "decision", status: "open" }).select("id").single();
  const threadId = data!.id as string;
  await page.goto(`/threads/${threadId}`);
  await page.getByRole("button", { name: "Resolve…" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: "Decided" }).check();
  await sheet.getByLabel("What did you decide?").fill("Bought the red kayak");
  await sheet.getByRole("button", { name: "Skip" }).click();
  const undo = page.getByRole("button", { name: "Undo resolve: Pick a kayak" });
  await expect(undo).toBeVisible();
  const dec = (await db.from("decisions").select("id, reason_user").eq("thread_id", threadId).single()).data!;
  expect(dec.reason_user).toBeNull();
  expect((await userClient.rpc("decision_add_reason", { p_decision_id: dec.id, p_reason: "Stable in waves.", p_now: new Date().toISOString() })).data).toMatchObject({ ok: true });
  await undo.click();
  await expect(page.getByText("That change isn't possible any more. Refresh to see the latest.")).toBeVisible();
  expect((await db.from("threads").select("status, resolution").eq("id", threadId).single()).data).toEqual({ status: "resolved", resolution: "decided" });
  expect((await db.from("decisions").select("reason_user").eq("id", dec.id).single()).data!.reason_user).toBe("Stable in waves.");
  await page.reload();
  await expect(page.getByText("Stable in waves.")).toBeVisible();
});

test("Thread detail: a decision with no reason offers Add a reason now (SITE_CONTRACT §2.7, D58)", async () => {
  test.fail(true, "DEFECT: DecisionBlock on Thread detail shows no no-reason line and no Add a reason now (§2.7 as amended by D58)");
  const db = admin();
  const { data } = await db.from("threads").insert({ user_id: uid, title: "Pick a paddle", kind: "decision", status: "resolved", resolution: "decided", resolved_at: iso(-1) }).select("id").single();
  await db.from("decisions").insert({ user_id: uid, thread_id: data!.id, choice: "Carbon paddle", reason_user: null, context_facts: [], decided_at: iso(-1) });
  await page.goto(`/threads/${data!.id}`);
  await expect(page.getByText("You didn't record a reason for this decision.")).toBeVisible({ timeout: 3_000 });
  await expect(page.getByRole("button", { name: "Add a reason now" })).toBeVisible({ timeout: 3_000 });
});
