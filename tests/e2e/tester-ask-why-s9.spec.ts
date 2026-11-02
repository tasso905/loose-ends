import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester S9 (F12 Ask why) on the page, against local Supabase and recorded LLM fixtures
 * (AI_PROVIDER=fake; never a live model):
 *  - tests/fixtures/llm/tester-s9-fabricated.ask-why.json cites an unretrieved decision, a fragment
 *    of the reason, an unknown evidence ID and a paraphrased fact: none of it may reach the page;
 *  - tests/fixtures/llm/tester-s9-interp-as-user.ask-why.json invents a reason for a decision with
 *    none and offers an Interpretation phrased as the user's words: it may only show as Interpretation;
 *  - three voices (Plex Sans, no italics, serif only for the source quote), keyboard-only use,
 *    Try again counting once, reduced motion, axe at 375 px and desktop.
 */

const DEC1 = "7e57a9a0-0000-4000-8000-000000000001";
const DEC2 = "7e57a9a0-0000-4000-8000-000000000002";
const EV1 = "7e57a9a0-0000-4000-8000-0000000000e1";
const REASON = "Their quote included permits and cleanup.\nThe other two did not.";
const FACT = "Total quote 4,200 dollars";
const FAB_Q = "Why did I hire Quillfeather for the kitchen?";
const GYM_Q = "Why did I cancel the gym membership?";
const FAIL_Q = "Why did I hire Quillfeather?"; // retrieves DEC1; no recording, so the model call fails

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";
let kitchenThread = "";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function axe(p: Page) {
  const results = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function asksToday(): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const { data } = await admin().from("usage_counters").select("asks").eq("user_id", uid).eq("day", day).maybeSingle();
  return (data?.asks as number | undefined) ?? 0;
}

const box = (p = page) => p.getByRole("textbox", { name: "Ask about a past decision" });
const askButton = (p = page) => p.getByRole("button", { name: "Ask", exact: true });
const isServerAction = (method: string, headers: Record<string, string>) => method === "POST" && "next-action" in headers;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fdecisions");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();

  const db = admin();
  uid = (await db.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  await db.from("decisions").delete().in("id", [DEC1, DEC2]); // leftovers from an aborted run
  const mk = async (title: string, counterparty: string | null) =>
    (
      await db
        .from("threads")
        .insert({ user_id: uid, title, kind: "decision", counterparty, status: "resolved", resolution: "decided", resolved_at: "2026-10-18T14:05:00Z" })
        .select("id")
        .single()
    ).data!.id as string;
  kitchenThread = await mk("Kitchen remodel contractor", "Quillfeather Builders");
  const gymThread = await mk("Gym membership", null);
  const ins = await db.from("decisions").insert([
    { id: DEC1, user_id: uid, thread_id: kitchenThread, choice: "Hired Quillfeather for the kitchen", reason_user: REASON, context_facts: [{ text: FACT, evidence_id: EV1 }], decided_at: "2026-10-18T14:05:00Z" },
    { id: DEC2, user_id: uid, thread_id: gymThread, choice: "Cancelled the gym membership", reason_user: null, context_facts: [], decided_at: "2026-10-10T10:00:00Z" },
  ]);
  expect(ins.error).toBeNull();
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("fabricated recording: only the retrieved decision, its whole stored reason and its stored fact reach the page", async () => {
  await page.goto("/decisions");
  await box().fill(FAB_Q);
  await askButton().click();
  const card = page.getByRole("article");
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  expect(await card.getByTestId("reason").textContent()).toBe(REASON);
  await expect(card.locator("blockquote.font-serif")).toHaveText([FACT]);
  await expect(card.getByText("Permits seem to have decided it.")).toBeVisible();
  const text = (await page.locator("main").textContent()) ?? "";
  for (const bad of ["I owed them a favour.", "3,000", "Quote about 4k"]) expect(text, bad).not.toContain(bad);
  // The fragment never appears on its own: only inside the whole reason.
  expect(text.split("Their quote included permits").length - 1).toBe(1);
  await axe(page);
});

test("three voices: Plex Sans everywhere but the source quote (serif); no italics anywhere in the answer", async () => {
  const card = page.getByRole("article");
  const styles = await card.evaluate((root) =>
    Array.from(root.querySelectorAll("*")).map((el) => {
      const cs = getComputedStyle(el);
      return { tag: el.tagName, serif: el.closest("blockquote.font-serif") !== null, family: cs.fontFamily, style: cs.fontStyle, text: (el.textContent ?? "").slice(0, 30) };
    }),
  );
  for (const s of styles) {
    expect(s.style, `${s.tag} "${s.text}"`).toBe("normal");
    if (s.serif) expect(s.family, s.text).toMatch(/Plex.?Serif/i);
    else expect(s.family, `${s.tag} "${s.text}"`).toMatch(/Plex.?Sans/i);
  }
  // The user's reason is Plex Sans (user words), not the serif source voice.
  expect(await card.getByTestId("reason").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Plex.?Sans/i);
});

test("an Interpretation phrased as the user's words never shows as You wrote; the no-reason state stays", async () => {
  await box().fill(GYM_Q);
  await askButton().click();
  const card = page.getByRole("article");
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(card.getByText("You didn't record a reason for this decision.")).toBeVisible();
  await expect(card.getByText("You wrote:", { exact: true })).toHaveCount(0);
  await expect(card.getByTestId("reason")).toHaveCount(0);
  // The model's sentence is under the Interpretation label, in the secondary interpretation block.
  const interp = card.getByText('You wrote: "It cost too much."');
  await expect(interp).toBeVisible();
  const label = await interp.evaluate((el) => el.previousElementSibling?.textContent ?? "");
  expect(label).toBe("Interpretation:");
  await axe(page);
});

test("SITE_CONTRACT §2.11 / CONTENT_MODEL §10: the no-reason state offers Add a reason now", async () => {
  test.fail(true, "DEFECT: AnswerCard renders the no-reason sentence without the `Add a reason now` action");
  await expect(page.getByRole("article").getByRole("link", { name: "Add a reason now" }).or(page.getByRole("article").getByRole("button", { name: "Add a reason now" }))).toBeVisible({ timeout: 2_000 });
});

test("keyboard only: Tab to the box, type, Enter to ask, Tab to Open thread, Enter opens the thread", async () => {
  await page.goto("/decisions");
  await expect(box()).toBeVisible();
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await box().evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  await page.keyboard.type(FAB_Q);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article")).toHaveCount(1, { timeout: 15_000 });
  const open = page.getByRole("link", { name: "Open thread: Kitchen remodel contractor" });
  let onLink = false;
  for (let i = 0; i < 10 && !onLink; i++) {
    await page.keyboard.press("Tab");
    onLink = await open.evaluate((el) => el === document.activeElement);
  }
  expect(onLink).toBe(true);
  // A visible focus indicator on the link.
  const outline = await open.evaluate((el) => {
    const cs = getComputedStyle(el);
    return cs.outlineStyle !== "none" || cs.boxShadow !== "none";
  });
  expect(outline).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/threads/${kitchenThread}$`));
});

test("ask_failed: Try again by keyboard keeps the question, shows no answer, and counts exactly one ask per press", async () => {
  await page.goto("/decisions");
  await box().fill(FAIL_Q);
  const before = await asksToday();
  await box().press("Enter");
  const msg = page.getByText("I couldn't answer that just now. Try asking again.");
  await expect(msg).toBeVisible({ timeout: 15_000 });
  expect(await asksToday()).toBe(before + 1);
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(box()).toHaveValue(FAIL_Q);

  const retry = page.getByRole("button", { name: "Try again" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(msg).toBeVisible({ timeout: 15_000 });
  await expect(retry).toBeEnabled();
  expect(await asksToday()).toBe(before + 2);
  await expect(box()).toHaveValue(FAIL_Q);
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("rule 10: an answer on screen is cleared the moment a new ask starts, before the server replies", async () => {
  await box().fill(FAB_Q);
  await askButton().click();
  await expect(page.getByRole("article")).toHaveCount(1, { timeout: 15_000 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/decisions*", async (route) => {
    if (isServerAction(route.request().method(), route.request().headers())) await gate;
    await route.continue();
  });
  await box().fill(FAIL_Q);
  await askButton().click();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByText("I couldn't answer that just now. Try asking again.")).toHaveCount(0);
  release();
  await expect(page.getByText("I couldn't answer that just now. Try asking again.")).toBeVisible({ timeout: 15_000 });
  await page.unrouteAll();
});

test("prefers-reduced-motion: only the status spinner animates (DESIGN_STANDARD keeps it, with the Ask label visible); nothing else moves", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", storageState: await context.storageState() });
  const p = await ctx.newPage();
  await p.goto("/decisions");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await p.route("**/decisions*", async (route) => {
    if (isServerAction(route.request().method(), route.request().headers())) await gate;
    await route.continue();
  });
  await box(p).fill(FAB_Q);
  await askButton(p).click();
  await expect(askButton(p)).toBeDisabled();
  await expect(askButton(p)).toHaveText("Ask");
  const moving = await p.evaluate(() =>
    Array.from(document.querySelectorAll("body *")).flatMap((el) => {
      if (el.closest(".animate-spin-status")) return [];
      const cs = getComputedStyle(el);
      const secs = (v: string) => Math.max(...v.split(",").map((x) => (x.trim().endsWith("ms") ? parseFloat(x) / 1000 : parseFloat(x))));
      const anim = cs.animationName !== "none" && secs(cs.animationDuration) > 0.01;
      const trans = cs.transitionProperty !== "none" && secs(cs.transitionDuration) > 0.01;
      return anim || trans ? [`${el.tagName}.${el.className}`] : [];
    }),
  );
  expect(moving).toEqual([]);
  release();
  await expect(p.getByRole("article")).toHaveCount(1, { timeout: 15_000 });
  const cardMoving = await p.getByRole("article").evaluate((root) =>
    Array.from(root.querySelectorAll("*")).filter((el) => {
      const cs = getComputedStyle(el);
      return parseFloat(cs.transitionDuration) > 0.01 || parseFloat(cs.animationDuration) > 0.01;
    }).length,
  );
  expect(cardMoving).toBe(0);
  await ctx.close();
});

test("375 px: no-reason answer and ask_failed state, no horizontal scroll, 44 px targets, axe passes", async () => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/decisions");
  await box().fill(GYM_Q);
  await askButton().click();
  await expect(page.getByRole("article")).toHaveCount(1, { timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await box().fill(FAIL_Q);
  await askButton().click();
  await expect(page.getByText("I couldn't answer that just now. Try asking again.")).toBeVisible({ timeout: 15_000 });
  expect((await page.getByRole("button", { name: "Try again" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("desktop: the ask_failed state passes axe", async () => {
  await page.goto("/decisions");
  await box().fill(FAIL_Q);
  await askButton().click();
  await expect(page.getByText("I couldn't answer that just now. Try asking again.")).toBeVisible({ timeout: 15_000 });
  await axe(page);
});

test("the box holds at most 300 characters; a pasted 301-character question is cut to 300", async () => {
  await page.goto("/decisions");
  await box().fill("");
  await box().focus();
  await page.keyboard.insertText("a".repeat(301));
  await expect(box()).toHaveValue("a".repeat(300));
});
