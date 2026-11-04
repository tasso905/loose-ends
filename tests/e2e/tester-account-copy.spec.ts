import { expect, test } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";

/** Lead-tester: D74's two lines exactly as the user sees them, and the old lines nowhere. */
const EXPORT_HINT = "One file with the text you've added and every thread, decision and setting.";
const ACCOUNT_DELETED = "Your account and your data in Loose Ends were deleted.";

test("Settings shows the export hint and the sign-in page shows the deleted notice, word for word", async ({ browser }) => {
  const email = testEmail();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto("/sign-in?next=%2Fsettings");
    const since = await requestLink(page, email);
    await page.goto(await magicLinkFor(email, since));
    await page.getByRole("button", { name: "Skip" }).click();
    await page.goto("/settings");
    await expect(page.getByText(EXPORT_HINT, { exact: true })).toBeVisible();
    await expect(page.getByText("One file with everything you've added")).toHaveCount(0);

    await page.getByRole("button", { name: "Delete account…" }).click();
    const d = page.getByRole("dialog", { name: "Delete your account?" });
    await d.getByLabel("Type delete to confirm").fill("delete");
    await d.getByRole("button", { name: "Delete account" }).click();
    await expect(page).toHaveURL(/\/sign-in$/, { timeout: 20_000 });
    await expect(page.getByRole("status").filter({ hasText: ACCOUNT_DELETED })).toHaveText(ACCOUNT_DELETED);
    await expect(page.getByText("everything in it were deleted")).toHaveCount(0);
  } finally {
    await context.close();
    await deleteUsers([email]);
  }
});
