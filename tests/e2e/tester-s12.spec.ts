import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";
import { settled } from "./settled";

/**
 * Lead-tester S12 (F9): independent checks of the thread actions on Thread detail and Today, against
 * local Supabase and the recorded LLM fixtures (AI_PROVIDER=fake; synthetic text only).
 *
 * - MenuPopover keyboard: Arrow keys (with wrap), Home, End, Escape and Tab, focus back on the trigger.
 * - Focus after Undo goes to Done, for every reversible S12 action.
 * - Rule 10: while the server has not answered, no toast and no new status.
 * - 375 px: axe with the menus and sheets open, 44 px targets.
 * - prefers-reduced-motion: the menu and toast do not animate.
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const TITLE = "Send revised proposal to Mike";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let threadId = "";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function expectNoViolations() {
  await settled(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const status = () => page.locator("#thread-status");
const more = () => page.getByRole("button", { name: "More actions" });
const done = () => page.getByRole("button", { name: "Done", exact: true });
const toastFor = (text: string) => page.getByRole("status").filter({ hasText: text });

/** Puts the thread back to Open with a fresh page and no toast (direct write as the service role). */
async function resetOpen() {
  await admin()
    .from("threads")
    .update({ status: "open", resolution: null, resolved_at: null, waiting_on: null, expected_by: null, snoozed_until: null, title: TITLE })
    .eq("id", threadId);
  await admin().from("suppressions").delete().eq("thread_id", threadId);
  await page.goto(`/threads/${threadId}`);
  await expect(status()).toHaveText("Open");
}

async function height(l: Locator) {
  return (await l.boundingBox())!.height;
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on("dialog", () => {
    throw new Error("No reversible action may ask for a browser confirmation (D8)");
  });
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add$/);
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByText("When was this written?").click();
  await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill("2026-10-05");
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();
  const uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  const { data } = await admin().from("threads").select("id").eq("user_id", uid);
  threadId = data![0]!.id as string;
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("More actions menu: ArrowDown/ArrowUp wrap, Home, End; Tab and Escape close it and return focus to the trigger", async () => {
  await resetOpen();
  await more().focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "More actions" });
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveText(["Snooze", "Edit", "Dismiss", "Forget permanently…"]);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(more()).toBeFocused();
  await expect(more()).toHaveAttribute("aria-expanded", "false");

  // Snooze submenu from More: Escape closes and focus returns to More actions.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // Snooze
  const snooze = page.getByRole("menu", { name: "Snooze" });
  await expect(snooze.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(snooze.getByRole("menuitem", { name: "Pick a date…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(snooze).toHaveCount(0);
  await expect(more()).toBeFocused();
  expect((await admin().from("threads").select("status").eq("id", threadId).single()).data!.status).toBe("open");
});

test("keyboard only: Mark waiting → Undo puts focus on Done", async () => {
  await resetOpen();
  await page.getByRole("button", { name: "Mark waiting", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Mark waiting" });
  await expect(dialog.getByLabel("Waiting on")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Mike");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(status()).toHaveText("Waiting");
  const undo = page.getByRole("button", { name: `Undo mark waiting: ${TITLE}` });
  await undo.focus();
  await page.keyboard.press("Enter");
  await expect(status()).toHaveText("Open");
  await expect(done()).toBeFocused();
});

for (const c of [
  { name: "Dismiss", item: "Dismiss", undo: `Undo dismiss: ${TITLE}`, after: "Dismissed" },
  { name: "Snooze (Tomorrow)", item: "Snooze", undo: `Undo snooze: ${TITLE}`, after: "Snoozed" },
] as const) {
  test(`${c.name} → Undo puts focus on Done`, async () => {
    await resetOpen();
    await more().click();
    await page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: c.item }).click();
    if (c.item === "Snooze") await page.getByRole("menu", { name: "Snooze" }).getByRole("menuitem", { name: /^Tomorrow, 9:00/ }).click();
    await expect(status()).toHaveText(c.after);
    const undo = page.getByRole("button", { name: c.undo });
    await undo.focus();
    await page.keyboard.press("Enter");
    await expect(status()).toHaveText("Open");
    await expect(done()).toBeFocused();
  });
}

test("Edit → Undo puts focus on Done; the title comes back", async () => {
  await resetOpen();
  await more().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit thread" });
  await dialog.getByLabel("Title").fill("Send the proposal to Mike today");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  const undo = page.getByRole("button", { name: "Undo edit: Send the proposal to Mike today" });
  await undo.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(done()).toBeFocused();
});

test("rule 10: while the server has not answered a Dismiss, no toast and the status stays Open", async () => {
  await resetOpen();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  await page.route(`**/threads/${threadId}`, async (route) => {
    if (route.request().method() === "POST" && !held) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  await more().click();
  await page.getByRole("menuitem", { name: "Dismiss" }).click();
  await expect.poll(() => held).toBe(true);
  // Give the UI time to (wrongly) claim success.
  await page.waitForTimeout(1_000);
  await expect(toastFor("Dismissed:")).toHaveCount(0);
  await expect(status()).toHaveText("Open");
  release();
  await expect(toastFor(`Dismissed: "${TITLE}"`)).toBeVisible();
  await expect(status()).toHaveText("Dismissed");
  await page.unroute(`**/threads/${threadId}`);
});

test("375 px: axe passes with the menus and sheets open; menu items, sheet buttons, toast Undo and Today Snooze are 44 px", async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  await resetOpen();
  await expectNoViolations();

  // SITE_CONTRACT §3.4 (lead-tester D2): below 768 px only Done and Snooze are buttons.
  for (const name of ["Done", "Snooze"]) {
    const b = page.getByRole("button", { name, exact: true });
    await expect(b).toBeVisible();
    expect(await height(b), name).toBeGreaterThanOrEqual(44);
  }
  for (const name of ["Resolve…", "Mark waiting"]) await expect(page.getByRole("button", { name, exact: true })).toBeHidden();

  await more().click();
  const menu = page.getByRole("menu", { name: "More actions" });
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveText(["Resolve…", "Mark waiting", "Edit", "Dismiss", "Forget permanently…"]);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Forget permanently…" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  for (const i of await items.all()) expect(await height(i), await i.innerText()).toBeGreaterThanOrEqual(44);
  expect(await height(more())).toBeGreaterThanOrEqual(44);
  await expectNoViolations();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Snooze", exact: true }).click();
  const snooze = page.getByRole("menu", { name: "Snooze" }).getByRole("menuitem");
  for (const i of await snooze.all()) expect(await height(i)).toBeGreaterThanOrEqual(44);
  await expectNoViolations();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Snooze", exact: true })).toBeFocused();

  await more().click();
  await page.getByRole("menuitem", { name: "Mark waiting" }).click();
  const mw = page.getByRole("dialog", { name: "Mark waiting" });
  await expect(mw).toBeVisible();
  await expectNoViolations();
  for (const b of await mw.getByRole("button").all()) expect(await height(b), await b.innerText()).toBeGreaterThanOrEqual(44);
  const box = (await mw.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(375);
  await mw.getByRole("button", { name: "Cancel" }).click();
  await expect(mw).toBeHidden();
  // Mark waiting came from the menu, so focus returns to More actions.
  await expect(more()).toBeFocused();

  await more().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const ed = page.getByRole("dialog", { name: "Edit thread" });
  await expect(ed).toBeVisible();
  await expectNoViolations();
  await ed.getByRole("button", { name: "Cancel" }).click();
  await expect(ed).toBeHidden();
  await expect(more()).toBeFocused();

  await more().click();
  await page.getByRole("menuitem", { name: "Dismiss" }).click();
  const undo = page.getByRole("button", { name: `Undo dismiss: ${TITLE}` });
  await expect(undo).toBeVisible();
  expect(await height(undo)).toBeGreaterThanOrEqual(44);
  await expectNoViolations();
  await undo.click();
  await expect(status()).toHaveText("Open");

  await page.goto("/today");
  const row = page.getByTestId("attention-row").filter({ hasText: TITLE });
  const snoozeBtn = row.getByRole("button", { name: `Snooze: ${TITLE}` });
  await expect(snoozeBtn).toBeVisible();
  expect(await height(snoozeBtn)).toBeGreaterThanOrEqual(44);
  await snoozeBtn.click();
  await expectNoViolations();
  await page.keyboard.press("Escape");
  await expect(snoozeBtn).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("1280 px: axe on Thread detail in waiting, snoozed and dismissed states", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const s of [
    { status: "waiting", waiting_on: "Mike", label: "Waiting" },
    { status: "snoozed", snoozed_until: "2030-01-01T14:00:00Z", label: "Snoozed" },
    { status: "dismissed", label: "Dismissed" },
  ] as const) {
    const { label, ...patch } = s;
    await admin().from("threads").update(patch).eq("id", threadId);
    await page.goto(`/threads/${threadId}`);
    await expect(status()).toHaveText(label);
    await expectNoViolations();
    if (await more().count()) {
      await more().click();
      await expectNoViolations();
      await page.keyboard.press("Escape");
    }
  }
});

test("prefers-reduced-motion: menu and toast do not animate", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await resetOpen();
    await more().click();
    const menu = page.getByRole("menu", { name: "More actions" });
    const dur = (l: Locator) => l.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) + parseFloat(getComputedStyle(el).animationDuration));
    expect(await dur(menu)).toBeLessThanOrEqual(0.0001);
    await page.getByRole("menuitem", { name: "Dismiss" }).click();
    const t = toastFor(`Dismissed: "${TITLE}"`);
    await expect(t).toBeVisible();
    expect(await dur(t)).toBeLessThanOrEqual(0.0001);
    await page.getByRole("button", { name: `Undo dismiss: ${TITLE}` }).click();
    await expect(status()).toHaveText("Open");
  } finally {
    await page.emulateMedia({ reducedMotion: null });
  }
});

// --- Lead-tester D2 re-verification: focus never lands on a button hidden by the other layout -----

/** Focus is on a rendered element (not <body>, not display:none). */
async function expectVisibleFocus(where: string) {
  const info = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName ?? "null",
      name: el?.getAttribute("aria-label") ?? el?.innerText?.slice(0, 30) ?? "",
      rendered: !!el && el !== document.body && el.getClientRects().length > 0,
    };
  });
  expect(info.rendered, `${where}: focus on ${info.tag} "${info.name}"`).toBe(true);
}

for (const width of [375, 1280] as const) {
  test(`${width} px: focus after Undo, Cancel and sheet close is always on a visible control`, async () => {
    await page.setViewportSize({ width, height: 812 });
    const mobile = width < 768;
    try {
      // Undo after Dismiss → Done (visible on both layouts).
      await resetOpen();
      await more().click();
      await page.getByRole("menuitem", { name: "Dismiss" }).click();
      await expect(status()).toHaveText("Dismissed");
      await page.getByRole("button", { name: `Undo dismiss: ${TITLE}` }).focus();
      await page.keyboard.press("Enter");
      await expect(status()).toHaveText("Open");
      await expect(done()).toBeFocused();
      await expectVisibleFocus("undo dismiss");

      // Resolve… Cancel → Resolve… on desktop, More actions on mobile (Resolve… is in the menu there).
      await expect(page.getByRole("button", { name: /Undo / })).toHaveCount(0, { timeout: 12_000 });
      if (mobile) {
        await more().click();
        await page.getByRole("menuitem", { name: "Resolve…" }).click();
      } else {
        await page.getByRole("button", { name: "Resolve…", exact: true }).click();
      }
      const rs = page.getByRole("dialog", { name: "How did this end?" });
      await expect(rs).toBeVisible();
      await rs.getByRole("button", { name: "Cancel" }).click();
      await expect(rs).toBeHidden();
      await expect(mobile ? more() : page.getByRole("button", { name: "Resolve…", exact: true })).toBeFocused();
      await expectVisibleFocus("resolve cancel");

      // Mark waiting: Escape closes the sheet → its button on desktop, More actions on mobile.
      if (mobile) {
        await more().click();
        await page.getByRole("menuitem", { name: "Mark waiting" }).click();
      } else {
        await page.getByRole("button", { name: "Mark waiting", exact: true }).click();
      }
      const mw = page.getByRole("dialog", { name: "Mark waiting" });
      await expect(mw).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(mw).toBeHidden();
      await expect(mobile ? more() : page.getByRole("button", { name: "Mark waiting", exact: true })).toBeFocused();
      await expectVisibleFocus("mark waiting escape");

      // Snooze menu Escape → the Snooze button on mobile, More actions on desktop.
      if (mobile) {
        await page.getByRole("button", { name: "Snooze", exact: true }).click();
      } else {
        await more().click();
        await page.getByRole("menuitem", { name: "Snooze" }).click();
      }
      await expect(page.getByRole("menu", { name: "Snooze" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(mobile ? page.getByRole("button", { name: "Snooze", exact: true }) : more()).toBeFocused();
      await expectVisibleFocus("snooze escape");

      // A dismissed thread: Reopen and Edit are buttons on desktop, in More on mobile. Edit Cancel.
      await admin().from("threads").update({ status: "dismissed" }).eq("id", threadId);
      await page.goto(`/threads/${threadId}`);
      await expect(status()).toHaveText("Dismissed");
      if (mobile) {
        await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeHidden();
        await more().click();
        await expect(page.getByRole("menu", { name: "More actions" }).getByRole("menuitem")).toHaveText(["Reopen", "Edit", "Forget permanently…"]);
        await page.getByRole("menuitem", { name: "Edit" }).click();
      } else {
        await page.getByRole("button", { name: "Edit", exact: true }).click();
      }
      const ed = page.getByRole("dialog", { name: "Edit thread" });
      await ed.getByRole("button", { name: "Cancel" }).click();
      await expect(ed).toBeHidden();
      await expect(mobile ? more() : page.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
      await expectVisibleFocus("edit cancel on a dismissed thread");
      await expectNoViolations();

      // A decision thread: Resolve… replaces Done (D6). Undo of Snooze → Resolve…, visible on both layouts.
      await admin().from("threads").update({ status: "open", kind: "decision" }).eq("id", threadId);
      await page.goto(`/threads/${threadId}`);
      await expect(status()).toHaveText("Open");
      // No Done on a decision thread, so Snooze is among the first three on desktop too: a button on both.
      await expect(done()).toHaveCount(0);
      await page.getByRole("button", { name: "Snooze", exact: true }).click();
      await page.getByRole("menu", { name: "Snooze" }).getByRole("menuitem", { name: /^Tomorrow, 9:00/ }).click();
      await expect(status()).toHaveText("Snoozed");
      await page.getByRole("button", { name: `Undo snooze: ${TITLE}` }).focus();
      await page.keyboard.press("Enter");
      await expect(status()).toHaveText("Open");
      await expect(page.getByRole("button", { name: "Resolve…", exact: true })).toBeFocused();
      await expectVisibleFocus("undo snooze on a decision thread");
      await expectNoViolations();
    } finally {
      await admin().from("threads").update({ kind: "commitment" }).eq("id", threadId);
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  });
}
