import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester, independent of the developer's specs: the core loop sign in → paste → review → accept
 * → Today → detail → Done → Undo, KEYBOARD ONLY; rule 4 on Today; rule 10 offline; the undo toast
 * under reduced motion; 375 px layout and 44 px targets; the not-found HTTP status; the toast's
 * paused timer against the server's fixed 8 s window. Local Supabase + recorded LLM fixtures
 * (AI_PROVIDER=fake; synthetic Mike email only).
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const TITLE = "Send revised proposal to Mike";
const INVALID = "That change isn't possible any more. Refresh to see the latest.";
const NOT_FOUND = "This thread doesn't exist or was deleted.";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let threadUrl = "";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function uid(addr = email) {
  return (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === addr)!.id;
}
async function thread() {
  const { data } = await admin().from("threads").select("id, status, resolution, resolved_at").eq("user_id", await uid());
  return data ?? [];
}
async function eventTypes(threadId: string) {
  const { data } = await admin().from("thread_events").select("type").eq("thread_id", threadId).order("id");
  return (data ?? []).map((e) => e.type as string);
}
async function axe(p: Page = page) {
  const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** Presses Tab until `target` has focus (fails after `max` presses). Returns the number of presses. */
async function tabTo(target: Locator, max = 40, key = "Tab"): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press(key);
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return i;
  }
  throw new Error(`could not reach ${target} with ${key} in ${max} presses`);
}

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

test("keyboard only: paste → review → accept → View in Today → detail → Done → Undo, focus never lost", async () => {
  await page.goto("/add?mode=paste");
  const box = page.getByLabel("Paste a message or document");
  await tabTo(box);
  await page.keyboard.insertText(MIKE);
  const disclosure = page.getByText("When was this written?");
  await tabTo(disclosure);
  await page.keyboard.press("Enter");
  const date = page.getByLabel("I assumed this was written today. Change it if it wasn't.");
  await tabTo(date);
  await date.fill("2026-10-05"); // date inputs take typed segments; fill is the equivalent of typing
  await tabTo(page.getByRole("button", { name: "Review source" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });

  // Nothing is a thread before accept (rule 2).
  expect(await thread()).toEqual([]);
  await tabTo(page.getByRole("button", { name: "Accept selected" }));
  await page.keyboard.press("Enter");
  await expect(page.getByText("1 thread added")).toBeVisible();
  await tabTo(page.getByRole("link", { name: "View in Today" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/today$/);

  // Rule 4: the unaccepted Low lunch line never appears on Today.
  await expect(page.getByText(/lunch/i)).toHaveCount(0);
  const row = page.getByRole("link", { name: new RegExp(TITLE) });
  await tabTo(row);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]{36}$/);
  threadUrl = page.url();
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();

  const done = page.getByRole("button", { name: "Done", exact: true });
  await tabTo(done);
  await page.keyboard.press("Enter");
  await expect(page.locator("#thread-status")).toHaveText("Resolved");
  // The Done button left the page: focus went to the status line, not <body>.
  await expect(page.locator("#thread-status")).toBeFocused();
  const undo = page.getByRole("button", { name: `Undo done: ${TITLE}` });
  const presses = await tabTo(undo, 15);
  test.info().annotations.push({ type: "tabs from status to Undo", description: String(presses) });
  await page.keyboard.press("Enter");
  await expect(page.locator("#thread-status")).toHaveText("Open");
  // Focus is not lost: it lands on Done (back after the refresh) or the status line, never <body>.
  await expect(done).toBeVisible();
  await page.waitForTimeout(500);
  const active = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}#${el.id}|${(el.textContent ?? "").trim().slice(0, 30)}` : "none";
  });
  test.info().annotations.push({ type: "focus after Undo", description: active });
  expect(active, "focus after keyboard Undo").not.toMatch(/^body/);
  const [t] = await thread();
  expect(t).toMatchObject({ status: "open", resolution: null, resolved_at: null });
  expect(await eventTypes(t!.id)).toEqual(["created", "resolved", "undone"]);
});

// DEFECT (minor, SITE_CONTRACT §3.2 "Focus the first relevant field on /add"): nothing is focused
// on arrival, so a keyboard user tabs past the skip link and header first.
test("/add focuses the paste field on arrival (§3.2)", async () => {
  test.fail(true, "DEFECT: /add does not focus its first field");
  await page.goto("/add?mode=paste");
  await expect(page.getByLabel("Paste a message or document")).toBeFocused({ timeout: 3_000 });
});

test("Threads tabs: arrow keys move between Active and Closed; Enter opens; aria-selected follows", async () => {
  await page.goto("/threads");
  const active = page.getByRole("tab", { name: "Active" });
  const closed = page.getByRole("tab", { name: "Closed" });
  await tabTo(active);
  await page.keyboard.press("ArrowRight");
  await expect(closed).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/filter=closed/);
  await expect(page.getByRole("tab", { name: "Closed" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Active" })).toHaveAttribute("aria-selected", "false");
  await axe();
});

test("rule 10 offline: Done shows the offline banner, no success toast, status unchanged", async () => {
  await page.goto(threadUrl);
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await context.setOffline(true);
  try {
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "You're offline. Nothing was saved." })).toBeVisible();
    await expect(page.getByText(/Marked done/)).toHaveCount(0);
    await expect(page.locator("#thread-status")).toHaveText("Open");
  } finally {
    await context.setOffline(false);
  }
  expect((await thread())[0]).toMatchObject({ status: "open" });
});

test("reduced motion: the undo toast appears without movement (transition ≤ 0.01 ms); axe passes on the toast", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await page.goto(threadUrl);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    const undo = page.getByRole("button", { name: `Undo done: ${TITLE}` });
    await expect(undo).toBeVisible();
    const card = undo.locator("xpath=..");
    const durations = await card.evaluate((el) => getComputedStyle(el).transitionDuration);
    // Computed as seconds, e.g. "1e-05s" for the global 0.01 ms rule.
    for (const d of durations.split(",")) expect(parseFloat(d), durations).toBeLessThanOrEqual(0.00001);
    await undo.focus();
    await axe();
    await undo.click();
    await expect(page.locator("#thread-status")).toHaveText("Open");
  } finally {
    await page.emulateMedia({ reducedMotion: null });
  }
});

test("375 px: no horizontal scroll on Today, Threads, detail and the toast; their controls are ≥ 44 px; axe passes", async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  try {
    const small: string[] = [];
    const check = async (where: string) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${where} horizontal overflow`).toBeLessThanOrEqual(0);
      const targets = page.locator("main button:visible, main a:visible, main [role=tab]:visible, nav a:visible, [role=status] button:visible");
      for (const el of await targets.all()) {
        const b = await el.boundingBox();
        if (!b) continue;
        const name = ((await el.getAttribute("aria-label")) ?? (await el.innerText())).trim().slice(0, 40);
        if (b.height < 44 || b.width < 44) small.push(`${where}: "${name}" ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
      await axe();
    };
    await page.goto("/today");
    await check("today");
    await page.goto("/threads");
    await check("threads");
    await page.goto(threadUrl);
    await check("detail");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    const undo = page.getByRole("button", { name: `Undo done: ${TITLE}` });
    await expect(undo).toBeVisible();
    await undo.hover();
    await check("toast");
    await undo.click();
    await expect(page.locator("#thread-status")).toHaveText("Open");
    expect(small).toEqual([]);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

// DEFECT (same class as S1's): an unknown id, or another user's thread, renders the not-found copy
// but with HTTP 200, because loading.tsx streams the response before notFound() runs. Crawlers,
// monitoring and anything that reads the status see a success. Safe behaviour: HTTP 404.
test("not-found thread: HTTP 404, not a soft 404 (unknown id and another user's thread)", async () => {
  test.fail(true, "DEFECT: soft 404 (HTTP 200) behind app/threads/[id]/loading.tsx");
  const res = await page.goto(`/threads/${randomUUID()}`);
  await expect(page.getByRole("heading", { name: NOT_FOUND })).toBeVisible();
  const other = testEmail();
  const { data: u } = await admin().auth.admin.createUser({ email: other, email_confirm: true });
  try {
    const { data: th } = await admin().from("threads").insert({ user_id: u.user!.id, title: "Synthetic other thread", kind: "commitment" }).select("id").single();
    const res2 = await page.goto(`/threads/${th!.id}`);
    await expect(page.getByRole("heading", { name: NOT_FOUND })).toBeVisible();
    await expect(page.getByText("Synthetic other thread")).toHaveCount(0);
    await expect(page).toHaveTitle(/^Thread/);
    expect([res?.status(), res2?.status()]).toEqual([404, 404]);
  } finally {
    await deleteUsers([other]);
  }
});

test("not-found thread: no content of another user's thread leaks (title, quote, tab title)", async () => {
  const other = testEmail();
  const { data: u } = await admin().auth.admin.createUser({ email: other, email_confirm: true });
  try {
    const { data: th } = await admin().from("threads").insert({ user_id: u.user!.id, title: "Synthetic leak probe", kind: "commitment" }).select("id").single();
    const res = await page.goto(`/threads/${th!.id}`);
    const html = (await res?.text()) ?? "";
    expect(html).not.toContain("Synthetic leak probe");
    await expect(page.getByRole("heading", { name: NOT_FOUND })).toBeVisible();
    await expect(page).not.toHaveTitle(/Synthetic leak probe/);
  } finally {
    await deleteUsers([other]);
  }
});

// CONFLICT (DESIGN_STANDARD "Undo toast: the timer pauses while hovered or focused" vs proposed
// D44 (a), "within 8 s of the event" on the server): a user who focuses or hovers the toast keeps
// Undo on screen past 8 s, presses it, and gets invalid_transition. The UI offers an action the
// server will refuse. Safe behaviour: an Undo the toast still offers works (or the toast leaves at
// 8 s regardless). Needs a decision (lead-program-manager), not just a code fix.
test("an Undo the toast still offers after a paused 8 s works", async () => {
  test.fail(true, "CONFLICT: paused toast vs fixed 8 s server window (D44 a)");
  await page.goto(threadUrl);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const undo = page.getByRole("button", { name: `Undo done: ${TITLE}` });
  await expect(undo).toBeVisible();
  await undo.focus();
  await page.waitForTimeout(9_000);
  await expect(undo).toBeVisible(); // paused: still offered
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: INVALID })).toHaveCount(0);
  await expect(page.locator("#thread-status")).toHaveText("Open");
});

test("after the refused late Undo: the page says so with §2.13 copy and Refresh, and the thread stays Done", async () => {
  // Continues from the previous test's state (thread resolved, late undo refused).
  await expect(page.getByRole("alert").filter({ hasText: INVALID })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  await expect(page.getByText(/Marked done.*Undo/)).toHaveCount(0);
  const [t] = await thread();
  expect(t).toMatchObject({ status: "resolved", resolution: "done" });
  const types = await eventTypes(t!.id);
  expect(types.at(-1)).toBe("resolved");
  expect(types.filter((x) => x === "undone").length).toBe(types.filter((x) => x === "resolved").length - 1);
});
