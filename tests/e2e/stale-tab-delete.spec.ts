import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, profileFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * One browser, shared cookies: a page rendered for A is still open in tab 1 when B signs in from tab 2.
 * What A then confirms in tab 1 must not reach B's account (rules 8, 10). Synthetic users only.
 */

const emails: string[] = [];
const newEmail = () => {
  const e = testEmail();
  emails.push(e);
  return e;
};
test.afterAll(() => deleteUsers(emails));

const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};
const DELETED = "Your account and your data in Loose Ends were deleted.";

async function signIn(page: Page, email: string, next: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
}

/** Tab 2: A signs out there, then B signs in. Tab 1 is left alone. */
async function switchUser(context: BrowserContext, email: string): Promise<Page> {
  const tab2 = await context.newPage();
  await tab2.goto("/today");
  await tab2.getByRole("button", { name: "Sign out" }).click();
  await expect(tab2).toHaveURL(/\/sign-in/);
  await signIn(tab2, email, "/today");
  return tab2;
}

async function skipOnboarding(page: Page, to: RegExp) {
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(to);
}

async function state(uid: string) {
  const db = admin();
  return {
    user: (await db.auth.admin.getUserById(uid)).data.user?.email ?? null,
    profile: (await db.from("profiles").select("*").eq("id", uid)).data,
    settings: (await db.from("user_settings").select("*").eq("user_id", uid)).data,
    sources: (await db.from("sources").select("*").eq("user_id", uid)).data,
    files: ((await db.storage.from("sources").list(uid)).data ?? []).map((o) => o.name),
  };
}

async function seed(email: string, title: string) {
  const db = admin();
  const uid = (await db.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  const path = `${uid}/${randomUUID()}`;
  const up = await db.storage.from("sources").upload(path, new Blob(["Synthetic notes."]), { contentType: "text/plain" });
  expect(up.error).toBeNull();
  const src = await db
    .from("sources")
    .insert({ user_id: uid, kind: "upload", title, text_content: "Synthetic notes.", storage_path: path, reference_date: "2026-10-20", reference_date_source: "user" })
    .select("id");
  expect(src.error).toBeNull();
  return { state: () => state(uid) };
}

test("Delete account confirmed in A's tab after B signed in: neither account is touched, nothing claims success, and the tab loads B's own Settings", async ({ browser }) => {
  const [emailA, emailB] = [newEmail(), newEmail()];
  const context = await browser.newContext();
  const tab1 = await context.newPage();
  await signIn(tab1, emailA, "/settings");
  await skipOnboarding(tab1, /\/settings/);
  const a = await seed(emailA, "Avery fence notes");
  await tab1.reload();
  await expect(tab1.getByText("Avery fence notes")).toBeVisible();
  await tab1.getByRole("button", { name: "Delete account…" }).click();
  const d = tab1.getByRole("dialog", { name: "Delete your account?" });
  await d.getByLabel("Type delete to confirm").fill("delete");

  const tab2 = await switchUser(context, emailB);
  await skipOnboarding(tab2, /\/today/);
  const b = await seed(emailB, "Blake gate notes");
  const before = { a: await a.state(), b: await b.state() };
  expect(before.b.user).toBe(emailB);

  let documents = 0;
  tab1.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === tab1.mainFrame()) documents += 1;
  });
  await d.getByRole("button", { name: "Delete account" }).click();

  await expect(d).toBeHidden({ timeout: 20_000 });
  expect({ a: await a.state(), b: await b.state() }).toEqual(before);
  await expect(tab1).toHaveURL(/\/settings$/);
  await expect(tab1.getByText("Blake gate notes")).toBeVisible();
  // A new document, not a soft refresh of A's page.
  expect(documents).toBeGreaterThan(0);
  const html = await tab1.content();
  expect(html).not.toContain("Avery fence notes");
  expect(html).not.toContain(emailA);
  await expect(tab1.getByText(DELETED)).toHaveCount(0);
  expect((await context.cookies()).filter((c) => c.name === "le_account_deleted")).toEqual([]);

  // B can still delete B's own account from the page that loaded.
  await tab1.getByRole("button", { name: "Delete account…" }).click();
  await expect(d.getByLabel("Type delete to confirm")).toHaveValue("");
  await d.getByLabel("Type delete to confirm").fill("delete");
  await d.getByRole("button", { name: "Delete account" }).click();
  await expect(tab1).toHaveURL(/\/sign-in$/, { timeout: 20_000 });
  await expect(tab1.getByRole("status").filter({ hasText: DELETED })).toBeVisible();
  expect((await b.state()).user).toBeNull();
  expect(await a.state()).toEqual(before.a);
  await context.close();
});

test("signed out from tab 2: Delete account in tab 1 deletes nothing and claims nothing", async ({ browser }) => {
  const emailA = newEmail();
  const context = await browser.newContext();
  const tab1 = await context.newPage();
  await signIn(tab1, emailA, "/settings");
  await skipOnboarding(tab1, /\/settings/);
  const a = await seed(emailA, "Avery shed notes");
  await tab1.reload();
  await tab1.getByRole("button", { name: "Delete account…" }).click();
  const d = tab1.getByRole("dialog", { name: "Delete your account?" });
  await d.getByLabel("Type delete to confirm").fill("delete");
  const before = await a.state();
  const tab2 = await context.newPage();
  await tab2.goto("/today");
  await tab2.getByRole("button", { name: "Sign out" }).click();
  await expect(tab2).toHaveURL(/\/sign-in/);
  await d.getByRole("button", { name: "Delete account" }).click();
  // The proxy turns a signed-out POST away before the action runs.
  await expect(d.getByText("That didn't save. Try again.")).toBeVisible({ timeout: 20_000 });
  await expect(tab1.getByText(DELETED)).toHaveCount(0);
  expect(await a.state()).toEqual(before);

  // Then B signs in, and the dialog A left open is confirmed again.
  const emailB = newEmail();
  await signIn(tab2, emailB, "/today");
  await skipOnboarding(tab2, /\/today/);
  const b = await seed(emailB, "Blake shed notes");
  const beforeB = await b.state();
  await d.getByRole("button", { name: "Delete account" }).click();
  await expect(tab1.getByText("Blake shed notes")).toBeVisible({ timeout: 20_000 });
  await expect(d).toBeHidden();
  expect(await tab1.content()).not.toContain("Avery shed notes");
  await expect(tab1.getByText(DELETED)).toHaveCount(0);
  expect({ a: await a.state(), b: await b.state() }).toEqual({ a: before, b: beforeB });
  await context.close();
});

test("onboarding answered in A's tab after B signed in: stored for no one, and the tab loads B's own onboarding", async ({ browser }) => {
  const [emailA, emailB] = [newEmail(), newEmail()];
  const context = await browser.newContext();
  const tab1 = await context.newPage();
  await signIn(tab1, emailA, "/today");
  await tab1.getByLabel("Names and emails").fill("Avery Synthetic");

  await switchUser(context, emailB);
  const before = { a: await profileFor(emailA), b: await profileFor(emailB) };
  expect(before.b).not.toBeNull();
  await tab1.getByRole("button", { name: "Save" }).click();
  await expect(tab1.getByText(emailB)).toBeVisible({ timeout: 20_000 });
  expect({ a: await profileFor(emailA), b: await profileFor(emailB) }).toEqual(before);
  await expect(tab1.getByText(emailA)).toHaveCount(0);
  await expect(tab1.getByLabel("Names and emails")).toHaveValue("");
  expect(await tab1.content()).not.toContain("Avery Synthetic");

  // B's own answer saves.
  await tab1.getByLabel("Names and emails").fill("Blake Synthetic");
  await tab1.getByRole("button", { name: "Save" }).click();
  await expect(tab1).toHaveURL(/\/today/);
  expect((await profileFor(emailB))!.aliases).toContain("Blake Synthetic");
  await context.close();
});
