import { expect, test } from "@playwright/test";
import { deleteUsers, magicLinkFor, profileFor, requestLink, testEmail } from "./helpers";

/** F1 sign-in and onboarding against local Supabase; the magic link is read from Mailpit. */

const created: string[] = [];
test.afterAll(async () => deleteUsers(created));

test("signed-out / goes to /sign-in with the pitch in order", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page).toHaveTitle("Sign in · Loose Ends");

  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toHaveCount(1);
  await expect(h1).toHaveText("Tie up your loose ends.");

  const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  const order = [
    "Loose Ends",
    "Tie up your loose ends.",
    "Paste in the mess. Get back what's still open, each with the sentence it came from.",
    "Email me a sign-in link",
    "Don't paste passwords or full account numbers.",
  ].map((s) => text.indexOf(s));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  // The wordmark is not a heading; analytics notice hidden until events ship (D22, rule 9).
  await expect(page.getByRole("heading", { name: "Loose Ends", exact: true })).toHaveCount(0);
  await expect(page.getByText(/analytics/i)).toHaveCount(0);
});

test("invalid email shows a field error and sends nothing", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Enter an email address");
  await expect(page.getByRole("heading", { name: "Check your email" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("?sent=1 without a confirmed send shows the form, not a false success (rule 10)", async ({ page }) => {
  await page.goto("/sign-in?sent=1");
  await expect(page.getByRole("heading", { name: "Check your email" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
});

test("offline send shows the offline copy", async ({ page, context }) => {
  await page.goto("/sign-in");
  await context.setOffline(true);
  await page.getByLabel("Email").fill(testEmail());
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("You're offline. Nothing was saved.");
  await context.setOffline(false);
});

test("expired or invalid links return to sign-in with the documented notice", async ({ page }) => {
  await page.goto("/auth/callback?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
  await expect(page).toHaveURL(/\/sign-in\?error=link_expired/);
  await expect(page.locator("main").getByRole("alert")).toContainText("That sign-in link has expired or was already used.");

  // A code with no PKCE verifier cookie: the link was opened in another browser.
  await page.goto("/auth/callback?code=not-a-real-code&next=%2Fthreads");
  await expect(page).toHaveURL(/\/sign-in\?error=link_other_browser&next=%2Fthreads/);
  await expect(page.locator("main").getByRole("alert")).toHaveText(
    "That link was opened in a different browser. Enter your email to get a new one, and open it in this browser.",
  );

  await page.goto("/auth/callback");
  await expect(page).toHaveURL(/\/sign-in\?error=link_expired$/);
});

test("signed-out deep link carries next; an off-site next is dropped", async ({ page }) => {
  await page.goto("/threads?filter=closed");
  await expect(page).toHaveURL("/sign-in?next=%2Fthreads%3Ffilter%3Dclosed");
  await page.goto("/sign-in?next=%2F%2Fevil.com");
  // The form's hidden next is the safe fallback, never the off-site value.
  await expect(page.locator('input[name="next"]')).toHaveValue("/today");
});

test("magic link → onboarding → skip → /today → sign out → deep link → back to it", async ({ page }) => {
  const email = testEmail();
  created.push(email);

  // First sign-in.
  await page.goto("/sign-in");
  const since1 = await requestLink(page, email);
  await expect(page).toHaveURL(/\/sign-in\?sent=1/);
  // The sent state names the link lifetime after the sent-to sentence (otp_expiry, tests/unit/auth-copy).
  const sentState = page.getByRole("status").filter({ hasText: "Check your email" });
  await expect(sentState.getByText(/^I sent a sign-in link to /)).toBeVisible();
  await expect(sentState.getByText("The link works for 1 hour.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Use a different email" })).toBeVisible();
  await page.goto(await magicLinkFor(email, since1));

  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What name and emails do people use for you?");
  await expect(page.getByText("Don't paste passwords or full account numbers.")).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();

  const profile = await profileFor(email);
  expect(profile?.aliases).toEqual([email]);
  expect(profile?.onboarded_at).not.toBeNull();
  expect(profile?.timezone).not.toBe(""); // detected from the browser

  // Shown once: onboarding now forwards to Today.
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/today$/);

  // Signed-in / goes to Today.
  await page.goto("/");
  await expect(page).toHaveURL(/\/today$/);

  // Sign out.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/today");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Ftoday/);

  // Signed-out deep link → sign-in → back to it (returning user: no onboarding).
  await page.goto("/today?from=deep-link");
  await expect(page).toHaveURL("/sign-in?next=%2Ftoday%3Ffrom%3Ddeep-link");
  const since2 = await requestLink(page, email);
  await expect(page).toHaveURL(/next=%2Ftoday%3Ffrom%3Ddeep-link/);
  await page.goto(await magicLinkFor(email, since2));
  await expect(page).toHaveURL("/today?from=deep-link");
});

test("first sign-in from a deep link: onboarding first, then next; answer is saved verbatim", async ({ page }) => {
  const email = testEmail();
  created.push(email);

  await page.goto("/today?view=first");
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));

  await expect(page).toHaveURL("/onboarding?next=%2Ftoday%3Fview%3Dfirst");
  await page.getByLabel("Names and emails").fill("Sam Lee, sam@work.example, Sammy");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL("/today?view=first");

  const profile = await profileFor(email);
  expect(profile?.aliases).toEqual([email, "Sam Lee", "sam@work.example", "Sammy"]);
  expect(profile?.display_name).toBe("Sam Lee");
});

test("a magic link that was already used shows the expired notice", async ({ page, browser }) => {
  const email = testEmail();
  created.push(email);
  await page.goto("/sign-in");
  const since = await requestLink(page, email);
  const link = await magicLinkFor(email, since);
  await page.goto(link);
  await expect(page).toHaveURL(/\/onboarding$/);

  // Same link again, from a signed-out browser: Supabase rejects it and the callback says so.
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto(link);
  await expect(p2).toHaveURL(/\/sign-in\?error=link_expired/);
  await expect(p2.locator("main").getByRole("alert")).toContainText("That sign-in link has expired or was already used.");
  await other.close();
});

test("after the account is deleted server-side, the old session lands on sign-in, not a redirect loop (B1)", async ({ page }) => {
  const email = testEmail();
  created.push(email);
  await page.goto("/sign-in");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today$/);

  await deleteUsers([email]); // the browser still holds an unexpired JWT

  await page.goto("/today");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Ftoday/);
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  expect((await page.context().cookies()).filter((c) => c.name.includes("auth-token"))).toEqual([]);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
});
