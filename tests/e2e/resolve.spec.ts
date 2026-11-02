import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * S8 F11 Resolve sheet against local Supabase and recorded LLM fixtures (AI_PROVIDER=fake; the
 * synthetic Mike email): open/close, Decided with a verbatim reason, Undo (D44), Skip, a decision
 * thread (D6), `?sheet=resolve`, rule 10 while saving, axe and 375 px.
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const TITLE = "Send revised proposal to Mike";
const REASON = "  Mike asked for it twice,\nand the old draft had the wrong price.  ";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let threadUrl = "";
let threadId = "";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

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
async function expectNoViolations() {
  await animationsSettled();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const decisions = async () =>
  (await admin().from("decisions").select("choice, reason_user, resolution_event_id").eq("thread_id", threadId).order("decided_at")).data ?? [];
const thread = async () => (await admin().from("threads").select("status, resolution, kind").eq("id", threadId).single()).data!;
const isServerAction = (method: string, headers: Record<string, string>) => method === "POST" && "next-action" in headers;
const sheet = () => page.getByRole("dialog", { name: "How did this end?" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add$/);

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

test("Resolve… opens the sheet: heading, three choices with Done selected, Save and Skip; Escape closes it, focus returns, nothing saved", async () => {
  await page.goto(threadUrl);
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  const trigger = page.getByRole("button", { name: "Resolve…" });
  await trigger.click();
  await expect(sheet()).toBeVisible();
  await expect(sheet().getByRole("heading", { level: 3, name: "How did this end?" })).toBeVisible();
  const radios = sheet().getByRole("radio");
  await expect(radios).toHaveCount(3);
  await expect(sheet().getByRole("radio", { name: "Done" })).toBeChecked();
  await expect(sheet().getByRole("radio", { name: "Done" })).toBeFocused();
  await expect(sheet().getByRole("button", { name: "Save" })).toBeVisible();
  await expect(sheet().getByRole("button", { name: "Skip" })).toBeVisible();
  // Save and Skip are equally prominent: the same width.
  const [save, skip] = [await sheet().getByRole("button", { name: "Save" }).boundingBox(), await sheet().getByRole("button", { name: "Skip" }).boundingBox()];
  expect(Math.abs(save!.width - skip!.width)).toBeLessThan(1);
  await expectNoViolations();

  await page.keyboard.press("Escape");
  await expect(sheet()).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await thread()).toMatchObject({ status: "open", resolution: null });
});

test("Decided with no decision: Save shows the field error and saves nothing", async () => {
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await expect(sheet().getByLabel("What did you decide?")).toBeFocused();
  await expect(sheet().getByLabel("Want me to remember why?")).toBeVisible();
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet().getByText("Write what you decided, or choose another option.")).toBeVisible();
  await expect(sheet().getByLabel("What did you decide?")).toBeFocused();
  await expectNoViolations();
  expect(await decisions()).toEqual([]);
  await sheet().getByRole("button", { name: "Cancel" }).click();
  await expect(sheet()).toBeHidden();
});

test("rule 10: while Save is in flight the sheet stays open and nothing claims success", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(`**${threadUrl}`, async (route) => {
    if (isServerAction(route.request().method(), route.request().headers())) await gate;
    await route.continue();
  });
  // Regression guard (CI run 40501493393): the sheet must open on fresh state, not show the previous
  // test's Decided + field error for a frame. Record the dialog's contents the moment it opens.
  await page.evaluate(() => {
    // The Resolve sheet's own <dialog> (the page can hold others, e.g. the Why panel).
    const d = [...document.querySelectorAll("dialog")].find((x) => x.querySelector("h3")?.textContent === "How did this end?")!;
    const w = window as unknown as { __openFrame?: string };
    delete w.__openFrame;
    const o = new MutationObserver(() => {
      if (!d.open || w.__openFrame !== undefined) return;
      const checked = d.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value ?? "none";
      w.__openFrame = `${checked}|fields:${d.querySelectorAll("input:not([type=radio]), textarea").length}|invalid:${d.querySelectorAll("[aria-invalid=true]").length}`;
      o.disconnect();
    });
    o.observe(d, { attributes: true, attributeFilter: ["open"] });
  });
  await page.getByRole("button", { name: "Resolve…" }).click();
  await expect(sheet()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __openFrame?: string }).__openFrame)).toBe("done|fields:0|invalid:0");
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill("Send the corrected proposal Friday");
  await sheet().getByLabel("Want me to remember why?").fill(REASON);
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet().getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(page.locator("#thread-status")).toHaveText("Open");
  await expect(page.getByRole("status").filter({ hasText: "Resolved:" })).toHaveCount(0);
  release();
  await expect(sheet()).toBeHidden({ timeout: 10_000 });
  await page.unrouteAll();
});

test("Decided saved: the reason exactly as typed, linked to the resolution event; the thread shows the decision in the You wrote voice", async () => {
  await expect(page.locator("#thread-status")).toHaveText("Resolved");
  await expect(page.getByRole("status").filter({ hasText: `Resolved: "${TITLE}"` })).toBeVisible();
  const [d] = await decisions();
  expect(d).toMatchObject({ choice: "Send the corrected proposal Friday", reason_user: REASON });
  const { data: ev } = await admin().from("thread_events").select("id, type").eq("thread_id", threadId).order("id");
  expect(d!.resolution_event_id).toBe(ev!.at(-1)!.id);
  expect(ev!.at(-1)!.type).toBe("resolved");

  const block = page.getByRole("region", { name: "Decision" });
  await expect(block.getByText("Send the corrected proposal Friday")).toBeVisible();
  await expect(block.getByText(/^You decided · /)).toBeVisible();
  await expect(block.getByText(/^You wrote · /)).toBeVisible();
  expect(await block.locator("blockquote").textContent()).toBe(REASON);
  await expect(page.getByRole("region", { name: "History" })).toContainText("You resolved this.");
  await expectNoViolations();
});

test("Undo (D44): the thread is Open again, the decision is gone, and focus returns to Done", async () => {
  await page.getByRole("button", { name: `Undo resolve: ${TITLE}` }).click();
  await expect(page.locator("#thread-status")).toHaveText("Open");
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeFocused();
  await expect(page.getByRole("region", { name: "Decision" })).toHaveCount(0);
  expect(await decisions()).toEqual([]);
  expect(await thread()).toMatchObject({ status: "open", resolution: null });
});

test("Skip is one tap: the decision is saved without a reason, and nothing asks for one again", async () => {
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill("Skip the lunch");
  await sheet().getByLabel("Want me to remember why?").fill("typed, then skipped");
  await sheet().getByRole("button", { name: "Skip" }).click();
  await expect(sheet()).toBeHidden();
  await expect(page.locator("#thread-status")).toHaveText("Resolved");
  expect(await decisions()).toMatchObject([{ choice: "Skip the lunch", reason_user: null }]);
  const block = page.getByRole("region", { name: "Decision" });
  await expect(block.getByText("Skip the lunch")).toBeVisible();
  await expect(block.getByText(/You wrote/)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Want me to remember why?")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resolve…" })).toHaveCount(0);
});

test("a decision thread (D6): no Done; Resolve… offers Decided and Not needed, Decided preselected; Not needed writes no decision", async () => {
  // Reopen as a decision thread behind the page's back (Reopen and Edit have no UI yet).
  await admin().from("threads").update({ status: "open", resolution: null, resolved_at: null, kind: "decision" }).eq("id", threadId);
  await page.goto(`${threadUrl}?sheet=resolve`);
  // ?sheet=resolve opens the sheet (SITE_CONTRACT §1.2).
  await expect(sheet()).toBeVisible();
  await expect(sheet().getByRole("radio")).toHaveCount(2);
  await expect(sheet().getByRole("radio", { name: "Done" })).toHaveCount(0);
  await expect(sheet().getByRole("radio", { name: "Decided" })).toBeChecked();
  await expect(sheet().getByLabel("What did you decide?")).toBeFocused();
  await sheet().getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resolve…" })).toBeFocused();

  const before = (await decisions()).length;
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Not needed" }).check();
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet()).toBeHidden();
  await expect(page.locator("#thread-status")).toHaveText("Resolved");
  expect(await thread()).toMatchObject({ status: "resolved", resolution: "not_needed" });
  expect((await decisions()).length).toBe(before);
  await expect(page.getByRole("region", { name: "Decision" })).toHaveCount(0);
});

test("375 px: the sheet is a bottom sheet with 44 px targets, no horizontal scroll; axe passes", async () => {
  await admin().from("threads").update({ status: "open", resolution: null, resolved_at: null, kind: "commitment" }).eq("id", threadId);
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto(threadUrl);
  await page.getByRole("button", { name: "Resolve…" }).click();
  await expect(sheet()).toBeVisible();
  const box = (await sheet().boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(740);
  expect(Math.round(box.width)).toBe(375);
  for (const name of ["Save", "Skip", "Cancel"]) {
    expect((await sheet().getByRole("button", { name }).boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
  }
  for (const name of ["Done", "Decided", "Not needed"]) {
    const card = sheet().locator("label").filter({ has: page.getByRole("radio", { name }) });
    expect((await card.boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoViolations();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
});
