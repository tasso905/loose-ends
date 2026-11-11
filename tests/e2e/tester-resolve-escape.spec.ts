import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, openResolveSheet, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";
import { settled } from "./settled";

/**
 * Lead-tester (fix/s8-escape): rule 10 on every way the Resolve sheet can close while a save is in
 * flight, with the save then succeeding or failing; focus after Save, Undo and a failure; axe and
 * 44 px targets at 375 px; `closedby` follows `pending`; Add a reason now focus under a slow CPU.
 * Local Supabase + recorded LLM fixtures (AI_PROVIDER=fake). Synthetic text only.
 */

test.describe.configure({ mode: "serial" });

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const DECISION = "Synthetic decision Q7";
const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";
let threadId = "";
let threadUrl = "";

const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};
const reopen = async () => {
  await admin().from("decisions").delete().eq("thread_id", threadId);
  await admin().from("threads").update({ status: "open", resolution: null, resolved_at: null, kind: "commitment" }).eq("id", threadId);
};
const dbStatus = async () => (await admin().from("threads").select("status").eq("id", threadId).single()).data!.status as string;
const sheet = () => page.getByRole("dialog", { name: "How did this end?" });
const isServerAction = (method: string, headers: Record<string, string>) => method === "POST" && "next-action" in headers;
const sheetState = () =>
  page.evaluate(() => {
    const d = [...document.querySelectorAll("dialog")].find((x) => x.querySelector("h3")?.textContent === "How did this end?");
    if (!d) return "absent";
    const checked = d.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value ?? "none";
    return `${d.open ? "open" : "closed"}|${checked}|fields:${d.querySelectorAll("input:not([type=radio]), textarea").length}|invalid:${d.querySelectorAll("[aria-invalid=true]").length}`;
  });
const closedBy = () =>
  page.evaluate(() => [...document.querySelectorAll("dialog")].find((x) => x.querySelector("h3")?.textContent === "How did this end?")?.getAttribute("closedby") ?? null);
/** Where focus is: "body", "in-sheet:<tag>", or "#id" / tag outside the sheet. */
const focusAt = () =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return "body";
    if (a.closest("dialog")) return `in-sheet:${a.tagName.toLowerCase()}`;
    return a.id ? `#${a.id}` : a.tagName.toLowerCase();
  });
async function axe(p: Page) {
  await settled(p);
  const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
/** Holds every server action until `release()`; with `fail`, the held request then fails at the network. */
async function holdSave(fail: boolean) {
  let release!: () => void;
  let held = false;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/*", async (route) => {
    if (!isServerAction(route.request().method(), route.request().headers())) return route.continue();
    held = true;
    await gate;
    if (fail) return route.abort("failed");
    return route.continue();
  });
  return { release, isHeld: () => held };
}
async function startDecidedSave(fail: boolean) {
  await reopen();
  await page.goto(threadUrl);
  const h = await holdSave(fail);
  // Below 768 px Resolve… is in More actions (SITE_CONTRACT §3.4, S12 D2).
  await openResolveSheet(page);
  await expect(sheet()).toBeVisible();
  expect(await closedBy()).toBe("closerequest");
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill(DECISION);
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect.poll(h.isHeld).toBe(true);
  await expect.poll(closedBy).toBe("none");
  return h;
}

type ClosePath = "Escape once" | "Escape twice" | "Escape x3 + scrim" | "scrim" | "Cancel";
async function tryToClose(how: ClosePath) {
  if (how === "Escape once") await page.keyboard.press("Escape");
  else if (how === "Escape twice") {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  } else if (how === "Escape x3 + scrim") {
    for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
  } else if (how === "scrim") await page.mouse.click(5, 5);
  else await sheet().getByRole("button", { name: "Cancel" }).click({ force: true }); // disabled while pending
  await page.waitForTimeout(400);
}
/** While the save is held: the sheet is still open with the user's input, nothing claims success. */
async function expectNothingClaimed() {
  expect(await sheetState()).toBe("open|decided|fields:2|invalid:0");
  await expect(sheet().getByLabel("What did you decide?")).toHaveValue(DECISION);
  await expect(page.locator("#thread-status")).toHaveText("Open");
  await expect(page.getByRole("button", { name: /^Undo resolve:/ })).toHaveCount(0);
  expect(await dbStatus()).toBe("open");
}

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
  uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  threadId = (await admin().from("threads").select("id").eq("user_id", uid).single()).data!.id as string;
  threadUrl = `/threads/${threadId}`;
});

test.afterEach(async () => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.setViewportSize({ width: 1280, height: 720 });
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

for (const how of ["Escape once", "Escape twice", "Escape x3 + scrim", "scrim", "Cancel"] as const) {
  test(`rule 10, success: ${how} while Save is in flight changes nothing until the server confirms; then the sheet closes, the toast shows, focus on the status`, async () => {
    const h = await startDecidedSave(false);
    await tryToClose(how);
    await expectNothingClaimed();
    h.release();
    await expect(sheet()).toBeHidden({ timeout: 10_000 });
    await expect(page.locator("#thread-status")).toHaveText("Resolved");
    await expect(page.getByRole("button", { name: /^Undo resolve:/ })).toBeVisible();
    await expect.poll(focusAt, { timeout: 5_000 }).toBe("#thread-status");
    expect(await dbStatus()).toBe("resolved");
    const { data } = await admin().from("decisions").select("choice").eq("thread_id", threadId);
    expect(data).toEqual([{ choice: DECISION }]);
  });
}

for (const how of ["Escape twice", "scrim"] as const) {
  test(`rule 10, failure: ${how} while a failing Save is in flight; the error shows in the open sheet with the input kept, focus stays in the sheet, nothing saved; Save again works`, async () => {
    const h = await startDecidedSave(true);
    await tryToClose(how);
    await expectNothingClaimed();
    h.release();
    await expect(sheet().getByText("That didn't save. Try again.")).toBeVisible();
    expect(await sheetState()).toBe("open|decided|fields:2|invalid:0");
    await expect(sheet().getByLabel("What did you decide?")).toHaveValue(DECISION);
    await expect.poll(closedBy).toBe("closerequest");
    // Focus after the failure is pinned separately below (OPEN DEFECT).
    await expect(page.locator("#thread-status")).toHaveText("Open");
    await expect(page.getByRole("button", { name: /^Undo resolve:/ })).toHaveCount(0);
    expect(await dbStatus()).toBe("open");
    await axe(page);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await sheet().getByRole("button", { name: "Save" }).click();
    await expect(sheet()).toBeHidden({ timeout: 10_000 });
    await expect(page.locator("#thread-status")).toHaveText("Resolved");
    expect(await dbStatus()).toBe("resolved");
  });
}

// FIXED (was OPEN DEFECT; focus now moves to the error wrapper, tabIndex -1) (a11y, WCAG 2.4.3; pre-existing, not introduced by fix/s8-escape): Save is disabled
// while pending, so the focused Save button drops focus to <body>; when the save fails, the error
// (role=alert) renders in the still-open sheet but nothing moves focus back into it. The repo's bar
// elsewhere is "never <body>" (7c4c3fa, T-U1). Asserts the safe behaviour; fails today.
test("focus after a failed save is inside the sheet (error banner or Save), never <body>", async () => {
  const h = await startDecidedSave(true);
  h.release();
  await expect(sheet().getByText("That didn't save. Try again.")).toBeVisible();
  await page.waitForTimeout(300);
  expect(await focusAt()).toMatch(/^in-sheet:/);
});

test("after a failed save, Cancel closes the sheet, focus returns to Resolve…, and the sheet reopens fresh", async () => {
  const h = await startDecidedSave(true);
  h.release();
  await expect(sheet().getByText("That didn't save. Try again.")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await sheet().getByRole("button", { name: "Cancel" }).click();
  await expect(sheet()).toBeHidden();
  await expect(page.getByRole("button", { name: "Resolve…" })).toBeFocused();
  await expect.poll(sheetState, { timeout: 2_000 }).toBe("closed|done|fields:0|invalid:0");
  await page.getByRole("button", { name: "Resolve…" }).click();
  await expect(sheet()).toBeVisible();
  expect(await sheetState()).toBe("open|done|fields:0|invalid:0");
  await expect(sheet().getByText("That didn't save. Try again.")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet()).toBeHidden();
  await expect(page.getByRole("button", { name: "Resolve…" })).toBeFocused();
});

test("the pending sheet and the error sheet pass axe at desktop and 375 px; at 375 px its buttons are 44 px targets", async () => {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 720 });
    const h = await startDecidedSave(true);
    await tryToClose("Escape twice");
    await axe(page);
    if (width === 375) {
      for (const name of ["Save", "Cancel"]) {
        const box = await sheet().getByRole("button", { name, exact: true }).boundingBox();
        expect(box!.height, name).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    h.release();
    await expect(sheet().getByText("That didn't save. Try again.")).toBeVisible();
    await axe(page);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await sheet().getByRole("button", { name: "Cancel" }).click();
    await expect(sheet()).toBeHidden();
  }
});

test("Undo right after Save focuses Done at once, before the Save's refresh lands (5 runs, CPU slowed 4x)", async () => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    for (let i = 0; i < 5; i++) {
      await reopen();
      await page.goto(threadUrl);
      await page.getByRole("button", { name: "Resolve…" }).click();
      await sheet().getByRole("radio", { name: "Not needed" }).check();
      await sheet().getByRole("button", { name: "Save" }).click();
      const undo = page.getByRole("button", { name: /^Undo resolve:/ });
      await undo.click({ timeout: 10_000 });
      await expect(page.locator("#thread-status")).toHaveText("Open", { timeout: 10_000 });
      await expect(page.getByRole("button", { name: "Done", exact: true }), `run ${i + 1}`).toBeFocused({ timeout: 5_000 });
      await page.waitForTimeout(800);
      await expect(page.getByRole("button", { name: "Done", exact: true }), `run ${i + 1}: focus stays on Done`).toBeFocused();
      expect(await dbStatus()).toBe("open");
    }
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
});

// FIXED (was OPEN DEFECT; undo() uses Done only when enabled, else waits for it) (a11y regression introduced by 18c0c2b, ThreadActions undo()): an Undo clicked while
// Done's own transition is still pending (Done is `disabled` until its refresh lands) now calls
// focus() on the disabled Done, which does nothing, and skips the old fallback, so focus ends on
// <body>. With origin/main's ThreadActions the same steps end on Done (2/2); with 18c0c2b on
// <body> (4/4 alone, --workers=1). Asserts the safe behaviour; fails today.
test("Done then an immediate Undo: focus returns to Done (not <body>)", async () => {
  await reopen();
  await page.goto(threadUrl);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const doneDisabledAtUndo = await page.getByRole("button", { name: "Done", exact: true }).isDisabled().catch(() => null);
  await page.getByRole("button", { name: /^Undo done:/ }).click();
  await expect(page.locator("#thread-status")).toHaveText("Open");
  await page.waitForTimeout(1_500);
  const where = await focusAt();
  const doneDisabled = await page.getByRole("button", { name: "Done", exact: true }).isDisabled();
  test.info().annotations.push({ type: "diag", description: `done disabled at undo=${doneDisabledAtUndo}; focus 1.5s after Undo=${where}; Done disabled now=${doneDisabled}` });
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeFocused();
  await page.waitForTimeout(800);
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeFocused();
});

test("Add a reason now: focus lands on the saved reason even with the CPU slowed 6x (3 runs)", async () => {
  const cdp = await context.newCDPSession(page);
  try {
    for (let i = 0; i < 3; i++) {
      const db = admin();
      const t = await db.from("threads").insert({ user_id: uid, title: `Pick a rope ${i}`, kind: "decision", status: "resolved", resolution: "decided", resolved_at: new Date(Date.now() - 86_400_000).toISOString() }).select("id").single();
      const d = await db.from("decisions").insert({ user_id: uid, thread_id: t.data!.id, choice: "The dynamic rope", reason_user: null, context_facts: [], decided_at: new Date(Date.now() - 86_400_000).toISOString() }).select("id").single();
      await page.goto(`/threads/${t.data!.id}`);
      await page.getByRole("button", { name: "Add a reason now" }).click();
      await page.getByLabel("Want me to remember why?").fill(`Stretches under load ${i}.`);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.locator(`#reason-${d.data!.id}`), `run ${i + 1}`).toBeFocused({ timeout: 10_000 });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    }
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
});
