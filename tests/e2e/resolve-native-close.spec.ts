import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * The Resolve sheet's fallback for a native <dialog> close it did not ask for (browsers without
 * `closedby`, or any other close the page does not see as a cancel). Simulated with dialog.close().
 * Rule 10: while a save is in flight the sheet stays open; otherwise the parent is told it closed,
 * so Resolve… opens it again. Local Supabase + recorded LLM fixtures. Synthetic text only.
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

const nativeClose = () =>
  page.evaluate(() => {
    [...document.querySelectorAll("dialog")].find((x) => x.querySelector("h3")?.textContent === "How did this end?")?.close();
  });

test("a native close while Save is in flight re-opens the sheet, and a failed save shows its error", async () => {
  await reopen();
  await page.goto(threadUrl);
  const release = await holdSave(true);
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill("Synthetic decision");
  await sheet().getByRole("button", { name: "Save" }).click();
  await expect(sheet().getByRole("button", { name: "Save" })).toBeDisabled();
  await nativeClose();
  await expect.poll(sheetState, { timeout: 2_000 }).toBe("open|decided|fields:2|invalid:0");
  release();
  await expect(sheet().getByText("That didn't save. Try again.")).toBeVisible();
  // Nothing was saved: the thread is still open.
  const { data } = await admin().from("threads").select("status").eq("id", threadId).single();
  expect(data!.status).toBe("open");
});

test("a native close when nothing is pending closes the sheet, resets it, and Resolve… opens it again", async () => {
  await reopen();
  await page.goto(threadUrl);
  await page.getByRole("button", { name: "Resolve…" }).click();
  await sheet().getByRole("radio", { name: "Decided" }).check();
  await sheet().getByLabel("What did you decide?").fill("Synthetic decision");
  await nativeClose();
  await expect(sheet()).toBeHidden();
  await expect.poll(sheetState, { timeout: 2_000 }).toBe("closed|done|fields:0|invalid:0");
  await page.getByRole("button", { name: "Resolve…" }).click();
  await expect(sheet()).toBeVisible();
  expect(await sheetState()).toBe("open|done|fields:0|invalid:0");
});
