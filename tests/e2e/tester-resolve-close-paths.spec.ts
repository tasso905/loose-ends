import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester review of the PR #25 CI fix (ResolveSheet resets on close, 7b41c20): every way the
 * sheet closes must leave it fresh for the next open, and a close the sheet did not ask for must
 * not strand it. Local Supabase + recorded LLM fixtures (AI_PROVIDER=fake). Synthetic text only.
 * `test.fail` pins a defect: it asserts the SAFE behaviour and currently fails.
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
const reopen = async () => {
  await admin().from("decisions").delete().eq("thread_id", threadId);
  await admin().from("threads").update({ status: "open", resolution: null, resolved_at: null, kind: "commitment" }).eq("id", threadId);
};
const sheet = () => page.getByRole("dialog", { name: "How did this end?" });
const isServerAction = (method: string, headers: Record<string, string>) => method === "POST" && "next-action" in headers;
/** "open|closed" + checked radio + text field count + invalid count, or "absent" when the sheet is not in the DOM. */
const sheetState = () =>
  page.evaluate(() => {
    const d = [...document.querySelectorAll("dialog")].find((x) => x.querySelector("h3")?.textContent === "How did this end?");
    if (!d) return "absent";
    const checked = d.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value ?? "none";
    return `${d.open ? "open" : "closed"}|${checked}|fields:${d.querySelectorAll("input:not([type=radio]), textarea").length}|invalid:${d.querySelectorAll("[aria-invalid=true]").length}`;
  });
/** Holds every server action until `release()`; with `fail`, the held request then fails at the network. */
async function holdSave(fail: boolean) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/*", async (route) => {
    if (!isServerAction(route.request().method(), route.request().headers())) return route.continue();
    await gate;
    if (fail) return route.abort("failed");
    return route.continue();
  });
  return release;
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
  const uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  threadId = (await admin().from("threads").select("id").eq("user_id", uid).single()).data!.id as string;
  threadUrl = `/threads/${threadId}`;
});

test.afterEach(async () => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

// REGRESSION GUARD (PR #25, CI run 40501493393): the reset now happens on close, so each close path
// must leave the closed sheet fresh, and the next open must take a click on Decided at once.
for (const how of ["Cancel", "Escape", "scrim"] as const) {
  test(`closed with ${how} after Decided + a field error: the sheet is reset while closed and reopens fresh`, async () => {
    await reopen();
    await page.goto(threadUrl);
    await page.getByRole("button", { name: "Resolve…" }).click();
    await sheet().getByRole("radio", { name: "Decided" }).check();
    await sheet().getByRole("button", { name: "Save" }).click(); // blank decision: field error
    await expect(sheet().locator("[aria-invalid=true]")).toHaveCount(1);
    if (how === "Cancel") await sheet().getByRole("button", { name: "Cancel" }).click();
    else if (how === "Escape") await page.keyboard.press("Escape");
    else await page.mouse.click(5, 5);
    await expect(sheet()).toBeHidden();
    // d.close() runs first and the reset renders a moment later, so the closed sheet is polled.
    await expect.poll(sheetState, { timeout: 2_000 }).toBe("closed|done|fields:0|invalid:0");
    await page.getByRole("button", { name: "Resolve…" }).click();
    await expect(sheet()).toBeVisible();
    expect(await sheetState()).toBe("open|done|fields:0|invalid:0");
    await sheet().getByRole("radio", { name: "Decided" }).click();
    await expect(sheet().getByLabel("What did you decide?")).toBeVisible();
    await page.waitForTimeout(500);
    expect(await sheetState()).toBe("open|decided|fields:2|invalid:0");
    await sheet().getByRole("button", { name: "Cancel" }).click();
  });
}

// FIXED (was OPEN DEFECT; rule 10; pre-existing, also on 2058103 before the PR): while Save is in flight the
// sheet ignores Escape (onCancel → preventDefault, close() is a no-op while pending). Chrome only
// lets a page cancel one Escape without user activation in between: a second Escape closes the
// <dialog> natively, without a cancel event. The sheet vanishes before the server answers, and the
// parent's `open` stays true. Fix: closedby="none" while pending, and a native close re-opens it.
test("rule 10: a second Escape while Save is in flight does not close the sheet before the server confirms", async () => {
  await reopen();
  await page.goto(threadUrl);
  const release = await holdSave(false);
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill("Synthetic decision");
  await sheet().getByRole("button", { name: "Save" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const during = await sheetState();
  release();
  expect(during).toBe("open|decided|fields:2|invalid:0");
});

// FIXED (was OPEN DEFECT; rule 10; pre-existing): same native close, and then the save fails. The failure is
// never shown (the sheet that would show it is closed), and Resolve… no longer opens the sheet,
// because `open` never went false, until the page is reloaded. Now the sheet stays open, so the
// error shows in it; it closes with Cancel and Resolve… opens it again (adapted by lead-developer).
test("rule 10: after a native close during a failing save, the error is shown and Resolve… opens the sheet again", async () => {
  await reopen();
  await page.goto(threadUrl);
  const release = await holdSave(true);
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill("Synthetic decision");
  await sheet().getByRole("button", { name: "Save" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  release();
  await page.waitForTimeout(2_000);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await expect(sheet().getByText("That didn't save. Try again.")).toBeVisible();
  await sheet().getByRole("button", { name: "Cancel" }).click();
  await expect(sheet()).toBeHidden();
  await page.getByRole("button", { name: "Resolve…" }).click();
  await expect(sheet()).toBeVisible({ timeout: 3_000 });
});
