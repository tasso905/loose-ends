import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester: a waiting_on loop's action is someone else's (D63, Nov 7 production report), so it
 * is never shown as the user's next action, in the Review Tray or on Thread detail. Recording
 * tests/fixtures/llm/tester-waiting-on.extract.json (synthetic): one waiting_on (Sam), one
 * commitment with owner other (Priya, maps to waiting_on), the user's own commitment, a request,
 * and a key_fact (never shown in the tray, D5). The user's own items keep their action: in the tray
 * in the Interpretation voice with the `Suggested` tag; on Thread detail as plain text with no tag,
 * because accepting confirmed it (coordinator, Nov 8). axe at 375 and 1280 px on the tray and detail.
 *
 * Written Mon Oct 5, 2026, so every date is in the past by the real clock: nothing here depends on
 * the run date (the tester-focus-combined weekday lesson).
 */

const TEXT =
  "Sam said he'll send the venue contract by Thursday. Priya told me she will bring the projector on Monday. I'll book the caterer on Friday. Can you confirm the headcount by Wednesday? The hall holds 80 people.";

const WAITING = [
  { title: "Venue contract from Sam", who: "Sam", action: "Send the venue contract" },
  { title: "Projector from Priya", who: "Priya", action: "Bring the projector" },
] as const;
const OWN = [
  { title: "Book the caterer", kind: "Commitment", action: "Book the caterer for the event" },
  { title: "Confirm the headcount", kind: "Request", action: "Reply with the final headcount" },
] as const;
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 900 },
] as const;

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
const threadIds: Record<string, string> = {};

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function axe() {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const card = (title: string): Locator =>
  page.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add$/);
  await page.getByLabel("Paste a message or document").fill(TEXT);
  await page.getByText("When was this written?").click();
  await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill("2026-10-05");
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 4 things in this" })).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("Review Tray: waiting_on and commitment-by-other show who and when, but no Suggested action", async () => {
  for (const w of WAITING) {
    const c = card(w.title);
    await expect(c).toHaveCount(1);
    await expect(c).toContainText("Waiting on");
    await expect(c).toContainText(`· ${w.who}`);
    await expect(c).toContainText(/\d+ days? overdue/);
    await expect(c.locator("blockquote")).toBeVisible();
    await expect(c.getByText(w.action, { exact: true })).toHaveCount(0);
    await expect(c.getByText("Suggested", { exact: true })).toHaveCount(0);
    await expect(c.getByRole("checkbox")).toBeEnabled();
  }
});

test("Review Tray: the user's own commitment and a request keep their action, tagged Suggested", async () => {
  for (const o of OWN) {
    const c = card(o.title);
    await expect(c).toHaveCount(1);
    await expect(c).toContainText(o.kind);
    await expect(c.getByText("Suggested", { exact: true })).toBeVisible();
    await expect(c.getByText(o.action, { exact: true })).toBeVisible();
  }
});

test("Review Tray: the key_fact is never shown, with or without its action", async () => {
  await expect(page.getByText("Hall capacity is 80")).toHaveCount(0);
  await expect(page.getByText("Plan for 80 guests")).toHaveCount(0);
});

test("Review Tray passes axe at 375 and 1280 px", async () => {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp);
    await expect(card(WAITING[0].title)).toBeVisible();
    await axe();
  }
});

test("accept all four: two waiting, two open", async () => {
  // High items start selected; any other band is ticked by hand (all four are acceptable).
  for (const t of [...WAITING, ...OWN]) {
    const box = card(t.title).getByRole("checkbox");
    if (!(await box.isChecked())) await box.check();
    await expect(box).toBeChecked();
  }
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("4 threads added")).toBeVisible();
  const uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  const { data } = await admin().from("threads").select("id, title, kind, status, next_action").eq("user_id", uid);
  expect(data).toHaveLength(4);
  for (const r of data!) threadIds[r.title as string] = r.id as string;
  const byTitle = Object.fromEntries(data!.map((r) => [r.title, { kind: r.kind, status: r.status, next_action: r.next_action }]));
  // The stored action is kept (it is what Sam/Priya will do); only the display is the user's.
  expect(byTitle).toEqual({
    "Venue contract from Sam": { kind: "waiting_on", status: "waiting", next_action: "Send the venue contract" },
    "Projector from Priya": { kind: "waiting_on", status: "waiting", next_action: "Bring the projector" },
    "Book the caterer": { kind: "commitment", status: "open", next_action: "Book the caterer for the event" },
    "Confirm the headcount": { kind: "request", status: "open", next_action: "Reply with the final headcount" },
  });
});

test("Thread detail, waiting_on: header and due chip intact; no Next action, no What you need to do, no action text", async () => {
  for (const w of WAITING) {
    await page.goto(`/threads/${threadIds[w.title]}`);
    await expect(page.getByRole("heading", { level: 1, name: w.title })).toBeVisible();
    const header = page.locator("#thread-title + p");
    await expect(header).toContainText("Waiting on");
    await expect(header).toContainText(`· ${w.who}`);
    await expect(header).toContainText(/\d+ days? overdue/);
    await expect(page.getByRole("heading", { name: "Next action" })).toHaveCount(0);
    await expect(page.getByText("What you need to do")).toHaveCount(0);
    await expect(page.getByText(w.action, { exact: true })).toHaveCount(0);
    await expect(page.getByText("Suggested", { exact: true })).toHaveCount(0);
    // The compact card still says when (By when), so it is not empty.
    await expect(page.getByRole("heading", { level: 2, name: "About this" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Evidence" }).locator("blockquote")).toBeVisible();
  }
});

test("Thread detail, the user's own: Next action and What you need to do show the action, with no Suggested tag", async () => {
  for (const o of OWN) {
    await page.goto(`/threads/${threadIds[o.title]}`);
    const next = page.locator("section", { has: page.getByRole("heading", { level: 2, name: "Next action" }) });
    await expect(next.getByText("Suggested", { exact: true })).toHaveCount(0);
    await expect(next.getByText(o.action, { exact: true })).toBeVisible();
    const about = page.locator("section", { has: page.getByRole("heading", { level: 2, name: "About this" }) });
    await expect(about.getByText("What you need to do")).toBeVisible();
    await expect(about.getByText("Suggested", { exact: true })).toHaveCount(0);
    await expect(about.getByText(o.action, { exact: true })).toBeVisible();
  }
});

test("Thread detail passes axe at 375 and 1280 px (waiting_on and commitment)", async () => {
  for (const title of [WAITING[0].title, OWN[0].title]) {
    await page.goto(`/threads/${threadIds[title]}`);
    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await axe();
    }
  }
  await page.setViewportSize(VIEWPORTS[1]);
});

test("Why panel on a waiting_on thread opens from stored fields and passes axe", async () => {
  await page.goto(`/threads/${threadIds[WAITING[0].title]}?panel=why`);
  const panel = page.getByRole("dialog", { name: "Why am I seeing this?" });
  await expect(panel).toBeVisible({ timeout: 10_000 });
  // The Why panel never shows the next action either way; it must not start to (unchanged by the fix).
  await expect(panel.getByText("Send the venue contract", { exact: true })).toHaveCount(0);
  await axe();
});

test("Threads index lists all four; Today shows the user's two overdue items by title only", async () => {
  await page.goto("/threads");
  for (const t of [...WAITING, ...OWN]) await expect(page.getByRole("link", { name: t.title }).first()).toBeVisible();
  await page.goto("/today");
  for (const o of OWN) await expect(page.getByRole("button", { name: `Done: ${o.title}`, exact: true })).toBeVisible();
  for (const t of [...WAITING, ...OWN]) await expect(page.getByText(t.action, { exact: true })).toHaveCount(0);
});

// Thread detail never tags a next action (accepted = confirmed, coordinator Nov 8); this checks an
// edited one shows the stored new text, still untagged, with the edit in History.
test("an edited next action shows the new stored text as plain text, and History records the edit", async () => {
  const id = threadIds[OWN[0].title]!;
  const db = admin();
  const { data: row } = await db.from("threads").select("user_id, next_action").eq("id", id).single();
  // Stand-in for a user edit (no edit UI yet): the same thread_events shape transition() writes.
  expect((await db.from("threads").update({ next_action: "Call the caterer first" }).eq("id", id)).error).toBeNull();
  const ev = await db.from("thread_events").insert({
    user_id: row!.user_id,
    thread_id: id,
    actor: "user",
    type: "edited",
    before: { next_action: row!.next_action },
    after: { next_action: "Call the caterer first" },
  });
  expect(ev.error).toBeNull();
  await page.goto(`/threads/${id}`);
  const next = page.locator("section", { has: page.getByRole("heading", { level: 2, name: "Next action" }) });
  await expect(next.getByText("Call the caterer first", { exact: true })).toBeVisible();
  await expect(page.getByText("Book the caterer for the event", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Suggested", { exact: true })).toHaveCount(0);
  await expect(page.getByText("You edited this.")).toBeVisible();
});
