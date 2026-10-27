import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester S8 (F11 Resolve sheet) E2E attacks: keyboard-only path, focus after Save / scrim /
 * Escape, rule 10 under a slow or failing save, double submit, stale status, verbatim display of
 * hostile text, reduced motion, axe. Local Supabase + recorded LLM fixtures (AI_PROVIDER=fake).
 * Synthetic text only. `test.fail` pins a defect: it asserts the SAFE behaviour and currently fails.
 */

test.describe.configure({ mode: "serial" });

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const email = testEmail();
let context: BrowserContext;
let page: Page;
let threadId = "";
let threadUrl = "";

const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};
const decisions = async () => (await admin().from("decisions").select("choice, reason_user").eq("thread_id", threadId)).data ?? [];
const status = async () => (await admin().from("threads").select("status").eq("id", threadId).single()).data!.status as string;
const reopen = async () => {
  await admin().from("decisions").delete().eq("thread_id", threadId);
  await admin().from("threads").update({ status: "open", resolution: null, resolved_at: null, kind: "commitment" }).eq("id", threadId);
};
const sheet = () => page.getByRole("dialog", { name: "How did this end?" });
const isServerAction = (method: string, headers: Record<string, string>) => method === "POST" && "next-action" in headers;
// axe samples colours as rendered: run it only after finite animations (the sheet's fade-in) end,
// so a half-faded label is not reported as low contrast. Infinite ones (spinners) are skipped.
const animationsSettled = () =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
async function axe() {
  await animationsSettled();
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
const activeId = () => page.evaluate(() => (document.activeElement === document.body ? "BODY" : document.activeElement?.id || document.activeElement?.tagName));

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();
  const uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  threadId = (await admin().from("threads").select("id").eq("user_id", uid).single()).data!.id as string;
  threadUrl = `/threads/${threadId}`;
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

async function keyboardResolve() {
  await reopen();
  await page.goto(threadUrl);
  await page.getByRole("button", { name: "Resolve…" }).focus();
  await page.keyboard.press("Enter");
  await expect(sheet()).toBeVisible();
  await expect(sheet().getByRole("radio", { name: "Done" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(sheet().getByRole("radio", { name: "Decided" })).toBeChecked();
  await expect(sheet().getByLabel("What did you decide?")).toBeFocused();
  await page.keyboard.type("Send it Friday");
  await page.keyboard.press("Tab");
  await expect(sheet().getByLabel("Want me to remember why?")).toBeFocused();
  await page.keyboard.type("Line one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("line two");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(sheet().getByRole("button", { name: "Save" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sheet()).toBeHidden({ timeout: 10_000 });
  await expect(page.locator("#thread-status")).toHaveText("Resolved");
  expect(await decisions()).toEqual([{ choice: "Send it Friday", reason_user: "Line one\nline two" }]);
}

test("keyboard only: Resolve… → arrow to Decided → type decision and a multi-line reason → Save; saved verbatim", async () => {
  await keyboardResolve();
});

// REGRESSION GUARD (a11y, SITE_CONTRACT §3.3; WCAG 2.4.3; fixed in 7c4c3fa): focus used to be lost
// to <body> after Save, because #thread-status was focused while the modal dialog still made the
// page inert. It now moves once the dialog has closed, and stays there after the refresh.
test("after Save, focus lands on the thread status, never <body>", async () => {
  await keyboardResolve();
  await expect.poll(activeId, { timeout: 5_000 }).toBe("thread-status");
  await page.waitForTimeout(1_000);
  expect(await activeId()).toBe("thread-status");
});

test("after Save with the mouse (Not needed), focus also lands on the status; Undo returns it to Done", async () => {
  await reopen();
  await page.goto(threadUrl);
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Not needed" }).check();
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet()).toBeHidden({ timeout: 10_000 });
  await expect.poll(activeId, { timeout: 5_000 }).toBe("thread-status");
  await page.getByRole("button", { name: /^Undo resolve:/ }).click();
  await expect(page.locator("#thread-status")).toHaveText("Open");
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeFocused();
});

test("Enter in the decision field submits once (implicit submission); a fast double-click on Save writes one decision and shows no error", async () => {
  const resolvedCount = async () =>
    ((await admin().from("thread_events").select("type").eq("thread_id", threadId)).data ?? []).filter((e) => e.type === "resolved").length;
  // Enter in the decision field.
  await reopen();
  await page.goto(threadUrl);
  let before = await resolvedCount();
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill("By Enter");
  await page.keyboard.press("Enter");
  await expect(page.locator("#thread-status")).toHaveText("Resolved", { timeout: 10_000 });
  expect(await decisions()).toEqual([{ choice: "By Enter", reason_user: null }]);
  expect(await resolvedCount()).toBe(before + 1);

  // A fast double-click on Save.
  await reopen();
  await page.goto(threadUrl);
  before = await resolvedCount();
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill("Double");
  await sheet().getByRole("button", { name: "Save" }).dblclick();
  await expect(page.locator("#thread-status")).toHaveText("Resolved", { timeout: 10_000 });
  // (Next's empty route announcer also has role=alert: only alerts with text count.)
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
  expect(await decisions()).toEqual([{ choice: "Double", reason_user: null }]);
  expect(await resolvedCount()).toBe(before + 1);
});

test("the scrim closes the sheet and focus returns to Resolve…; nothing saved", async () => {
  await reopen();
  await page.goto(threadUrl);
  const trigger = page.getByRole("button", { name: "Resolve…" });
  await trigger.click();
  await expect(sheet()).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(sheet()).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await status()).toBe("open");
});

test("rule 10 under a slow save: Escape, Cancel and the scrim do not close the sheet; nothing claims success until the server confirms", async () => {
  await reopen();
  await page.goto(threadUrl);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(`**${threadUrl}`, async (route) => {
    if (isServerAction(route.request().method(), route.request().headers())) await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Not needed" }).check();
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet().getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(sheet().getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await expect(sheet()).toBeVisible();
  await expect(page.locator("#thread-status")).toHaveText("Open");
  await expect(page.getByRole("status").filter({ hasText: "Resolved:" })).toHaveCount(0);
  release();
  await expect(sheet()).toBeHidden({ timeout: 10_000 });
  await expect(page.locator("#thread-status")).toHaveText("Resolved");
  await page.unrouteAll();
});

test("a failed save (500) keeps the sheet open with the error inside it; the thread stays Open; Save works again; axe passes", async () => {
  await reopen();
  await page.goto(threadUrl);
  await page.route(`**${threadUrl}`, (route) =>
    isServerAction(route.request().method(), route.request().headers()) ? route.fulfill({ status: 500, body: "" }) : route.continue(),
  );
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill("Keep this text");
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet().getByText("That didn't save. Try again.")).toBeVisible({ timeout: 10_000 });
  await expect(sheet().getByLabel("What did you decide?")).toHaveValue("Keep this text");
  await expect(sheet().getByRole("button", { name: "Save" })).toBeEnabled();
  await expect(page.locator("#thread-status")).toHaveText("Open");
  expect(await status()).toBe("open");
  await axe();
  await page.unrouteAll();
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet()).toBeHidden({ timeout: 10_000 });
  expect(await decisions()).toEqual([{ choice: "Keep this text", reason_user: null }]);
});

test("stale page: resolved elsewhere, then Save → invalid_transition in the sheet with Refresh; nothing written", async () => {
  await reopen();
  await page.goto(threadUrl);
  await page.getByRole("button", { name: "Resolve…" }).click();
  await admin().from("threads").update({ status: "resolved", resolution: "done", resolved_at: new Date().toISOString() }).eq("id", threadId);
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill("Too late");
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet().getByRole("button", { name: "Refresh" })).toBeVisible({ timeout: 10_000 });
  expect(await decisions()).toEqual([]);
  await axe();
  await sheet().getByRole("button", { name: "Refresh" }).click();
  await page.keyboard.press("Escape");
});

test("hostile and exotic text is shown verbatim as text in the Decision block (no HTML, no reordering of stored characters)", async () => {
  await reopen();
  await page.goto(threadUrl);
  const choice = "<img src=x onerror=alert(1)> Renew 👩🏽‍💻";
  const reason = "  <script>window.__pwned=1</script>\n‮right-to-left‬ مرحبا  ";
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill(choice);
  await sheet().getByLabel("Want me to remember why?").fill(reason);
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet()).toBeHidden({ timeout: 10_000 });
  expect(await decisions()).toEqual([{ choice, reason_user: reason }]);
  const block = page.getByRole("region", { name: "Decision" });
  expect(await block.locator("blockquote").textContent()).toBe(reason);
  await expect(block.getByText(choice, { exact: true })).toBeVisible();
  expect(await block.locator("img, script").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  // You wrote voice: Plex Sans, never italic, never the serif reserved for source quotes.
  const style = await block.locator("blockquote").evaluate((el) => ({ font: getComputedStyle(el).fontFamily, italic: getComputedStyle(el).fontStyle }));
  expect(style.italic).toBe("normal");
  expect(style.font).toMatch(/Plex Sans/);
  expect(style.font).not.toMatch(/Plex Serif/);
  await axe();
});

test("prefers-reduced-motion: the Decided fields appear without animation", async () => {
  await reopen();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(threadUrl);
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  const anim = await sheet()
    .getByLabel("What did you decide?")
    .evaluate((el) => {
      const box = el.closest(".animate-fade-in") as HTMLElement | null;
      const s = box ? getComputedStyle(box) : null;
      return s ? { name: s.animationName, dur: parseFloat(s.animationDuration) } : null;
    });
  expect(anim === null || anim.name === "none" || anim.dur <= 0.01).toBe(true);
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: null });
});

test("desktop: the sheet is a centred dialog no wider than 480 px; radio cards in one row; axe with Decided expanded", async () => {
  await reopen();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(threadUrl);
  await page.getByRole("button", { name: "Resolve…" }).click();
  const box = (await sheet().boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(481);
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(2);
  const ys = await Promise.all(["Done", "Decided", "Not needed"].map(async (n) => (await sheet().locator("label").filter({ has: page.getByRole("radio", { name: n }) }).boundingBox())!.y));
  expect(new Set(ys.map(Math.round)).size).toBe(1);
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await axe();
  // Tab never reaches page content behind the modal sheet (a native modal <dialog> lets focus pass
  // to the browser's own UI after its last control, which reads as <body>; that is platform behaviour).
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest("dialog"))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Resolve…" })).toBeFocused();
});
