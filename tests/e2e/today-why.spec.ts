import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";
import { settled } from "./settled";

/**
 * S10: F10 Today and the F8 Why panel against local Supabase and recorded LLM fixtures
 * (AI_PROVIDER=fake; synthetic Mike email). The pasted source is dated Oct 5, so "Friday" (Oct 9)
 * is overdue by the real clock. Extra threads are seeded with the service role to fill the
 * attention cap and the collapsed sections. Nothing on these pages calls a model (rule 6): the Why
 * panel is a server action reading stored rows, and no extraction recording exists for it.
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const TITLE = "Send revised proposal to Mike";
const QUOTE = "I'll send you the revised proposal Friday";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let userId = "";
let threadId = "";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function expectNoViolations() {
  // A toast or the Why sheet still fading in reads as low contrast; let it finish first.
  await settled(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const rows = () => page.getByTestId("attention-row");
const sheet = () => page.getByRole("dialog", { name: "Why am I seeing this?" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Ftoday");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today$/);
  const { data } = await admin().auth.admin.listUsers({ perPage: 1000 });
  userId = data.users.find((u) => u.email === email)!.id;
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("empty Today: heading, local-date greeting, empty state and Add something; axe passes", async () => {
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await expect(page.getByText(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]+ \d{1,2}$/)).toBeVisible();
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Add something" })).toHaveAttribute("href", "/add");
  await expect(page.getByTestId("count-line")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /to review$/ })).toHaveCount(0);
  await expectNoViolations();
});

test("pending proposals show the review chip; the Low one is not counted (rule 4)", async () => {
  await page.goto("/add");
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByText("When was this written?").click();
  await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill("2026-10-05");
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  const tray = page.url();

  await page.goto("/today");
  const chip = page.getByRole("link", { name: "1 to review" });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("href", new URL(tray).pathname);
  await expect(page.getByText(/lunch/i)).toHaveCount(0);
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();
  await expectNoViolations();

  await chip.click();
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();
});

test("an accepted overdue thread is worth attention, with a reason line from the source and Why?", async () => {
  await page.goto("/today");
  await expect(page.getByTestId("count-line")).toHaveText("1 thing is worth your attention");
  await expect(rows()).toHaveCount(1);
  const row = rows().first();
  await expect(row.getByRole("link", { name: TITLE, exact: true })).toBeVisible();
  await expect(row.getByTestId("reason-line")).toHaveText('You told Mike "Friday" on Oct 5');
  await expect(row.getByText(/days overdue$/)).toBeVisible();
  await expect(row.getByRole("button", { name: `Done: ${TITLE}` })).toBeVisible();
  // The Low lunch proposal is still pending, and still never shown or counted (rule 4).
  await expect(page.getByText(/lunch/i)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /to review$/ })).toHaveCount(0);
  threadId = (await row.getByRole("link", { name: TITLE, exact: true }).getAttribute("href"))!.split("/").pop()!;
  await expectNoViolations();
});

test("Why? opens the sheet from stored fields: quote in context, source, date step, why now; Escape returns focus", async () => {
  const actions: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) actions.push(r.url());
  });
  const why = rows().first().getByRole("link", { name: "Why?" });
  await expect(why).toHaveAttribute("href", `/threads/${threadId}?panel=why`);
  await why.click();
  await expect(sheet()).toBeVisible();
  await expect(sheet().getByTestId("why-quote")).toHaveText(QUOTE);
  expect(await sheet().getByTestId("why-quote").evaluate((el) => getComputedStyle(el.parentElement!).fontFamily)).toMatch(/Plex Serif/i);
  await expect(sheet().getByText("Thanks Mike —", { exact: false })).toBeVisible();
  await expect(sheet().getByText("Pasted text · Oct 5")).toBeVisible();
  await expect(sheet().getByText('I read "Friday" as Fri Oct 9 (message dated Mon Oct 5).')).toBeVisible();
  await expect(sheet().getByTestId("why-now")).toHaveText(/^It's still open\. It's \d+ days overdue\.$/);
  await expect(sheet().getByText("Likely", { exact: true })).toBeVisible();
  await expect(sheet().getByRole("link", { name: "This is wrong" })).toHaveAttribute("href", `/threads/${threadId}`);
  await expect(sheet().getByRole("link", { name: "Open source" })).toHaveCount(0);
  expect(actions.length).toBeGreaterThan(0);
  await expectNoViolations();

  await page.keyboard.press("Escape");
  await expect(sheet()).toHaveCount(0);
  await expect(why).toBeFocused();
});

test("the cap: at most 5 in attention, highest first; collapsed sections show counts and are hidden at 0", async () => {
  const seed = [
    ...Array.from({ length: 5 }, (_, i) => ({ title: `Overdue seed ${i + 1}`, due_at: days(-25 + i), confidence: 1 })),
    { title: "Waiting seed", status: "waiting", kind: "waiting_on", waiting_on: "Dana", expected_by: days(5), due_at: days(5) },
    { title: "Coming up seed", due_at: days(6), confidence: 0.5 },
    { title: "Resolved seed", status: "resolved", resolution: "done", resolved_at: days(-1) },
    { title: "Old resolved seed", status: "resolved", resolution: "done", resolved_at: days(-9) },
  ].map((t) => ({
    // A bulk insert sends every row with the union of the keys, so each row spells out its defaults.
    user_id: userId,
    kind: "commitment",
    status: "open",
    due_at: null,
    due_certainty: "due_at" in t && t.due_at ? "explicit" : "none",
    due_time_known: false,
    confidence: null,
    waiting_on: null,
    expected_by: null,
    resolution: null,
    resolved_at: null,
    ...t,
  }));
  const { error } = await admin().from("threads").insert(seed);
  expect(error).toBeNull();

  await page.goto("/today");
  await expect(rows()).toHaveCount(5);
  await expect(page.getByTestId("count-line")).toHaveText("5 things are worth your attention");
  // Overdue × confidence 1.0 is the top score; ties go to the earliest due date, and every seed is due before Mike's Oct 9.
  await expect(rows().getByRole("link", { name: /^Overdue seed/ })).toHaveText(["Overdue seed 1", "Overdue seed 2", "Overdue seed 3", "Overdue seed 4", "Overdue seed 5"]);
  // Seeded threads have no source: the reason line says so plainly.
  await expect(rows().first().getByTestId("reason-line")).toHaveText(/^You added this on [A-Z][a-z]{2} \d{1,2}$/);

  for (const [id, name, count] of [
    ["waiting", "Waiting on others", "1"],
    ["coming-up", "Coming up", "1"],
    ["resolved", "Recently resolved", "1"],
  ] as const) {
    const section = page.getByTestId(`section-${id}`);
    await expect(section.locator("summary")).toHaveText(`${name}${count}`);
    await expect(section.getByRole("link")).toBeHidden();
  }
  await page.getByTestId("section-waiting").locator("summary").click();
  await expect(page.getByTestId("section-waiting").getByRole("link", { name: /Waiting seed/ })).toBeVisible();
  await expect(page.getByText("Old resolved seed")).toHaveCount(0);
  await expect(page.getByText(TITLE)).toHaveCount(0);
  await expectNoViolations();
});

test("Done on a Today row: the row leaves, the undo toast stays, Undo brings it back", async () => {
  const row = rows().filter({ hasText: "Overdue seed 1" });
  await row.getByRole("button", { name: "Done: Overdue seed 1" }).click();
  await expect(page.getByRole("status").filter({ hasText: 'Marked done: "Overdue seed 1"' })).toBeVisible();
  await expect(rows().filter({ hasText: "Overdue seed 1" })).toHaveCount(0);
  await expect(rows().filter({ hasText: TITLE })).toHaveCount(1); // Mike moves up into the five
  await expect(page.locator("#today-heading")).toBeFocused();
  await page.getByRole("button", { name: "Undo done: Overdue seed 1" }).click();
  await expect(rows().filter({ hasText: "Overdue seed 1" })).toHaveCount(1);
  await expect(rows().filter({ hasText: TITLE })).toHaveCount(0);
});

test("Thread detail: Why? link and ?panel=why opens the sheet; closing drops the parameter", async () => {
  await page.goto(`/threads/${threadId}?panel=why`);
  await expect(sheet()).toBeVisible();
  await expect(sheet().getByTestId("why-quote")).toHaveText(QUOTE);
  await expectNoViolations();
  await sheet().getByRole("button", { name: "Close" }).click();
  await expect(sheet()).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/threads/${threadId}$`));
  const why = page.getByRole("link", { name: "Why?" });
  await expect(why).toBeFocused();
  await why.click();
  await expect(sheet()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("the Why panel for another user's thread is not found, and the sheet shows the error with Try again", async () => {
  const { data: u } = await admin().auth.admin.createUser({ email: `other-${email}`, email_confirm: true });
  const { data: th } = await admin().from("threads").insert({ user_id: u.user!.id, title: "Someone else's thread", kind: "commitment" }).select("id").single();
  try {
    // The no-JavaScript link target is the not-found page (RLS).
    await page.goto(`/threads/${th!.id}?panel=why`);
    await expect(page.getByText("This thread doesn't exist or was deleted.")).toBeVisible();
    await expect(page.getByText("Someone else's thread")).toHaveCount(0);
  } finally {
    await admin().auth.admin.deleteUser(u.user!.id);
  }

  // A failing load: the sheet keeps the user's place and offers Try again.
  await page.goto(`/threads/${threadId}`);
  await page.route("**/*", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) return route.abort();
    return route.continue();
  });
  await page.getByRole("link", { name: "Why?" }).click();
  await expect(sheet().getByText("Couldn't load this explanation.")).toBeVisible();
  await expect(sheet().getByRole("button", { name: "Try again" })).toBeVisible();
  await expectNoViolations();
  await page.unroute("**/*");
  await sheet().getByRole("button", { name: "Try again" }).click();
  await expect(sheet().getByTestId("why-quote")).toHaveText(QUOTE);
  await page.keyboard.press("Escape");
});

test("375 px: no horizontal scroll; Why is a bottom sheet; touch targets ≥ 44 px", async () => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/today");
  await expect(rows()).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const why = rows().first().getByRole("link", { name: "Why?" });
  expect((await why.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.getByTestId("section-waiting").locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await why.click();
  await expect(sheet()).toBeVisible();
  const box = (await sheet().boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(374);
  expect(box.y + box.height).toBeGreaterThanOrEqual(739);
  expect(box.height).toBeLessThanOrEqual(740 * 0.85 + 1);
  await expectNoViolations();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
});
