import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester, fix/reason-save-failure-focus (T-F1): after a reason save fails at the network, focus is on
 * the field, the text is kept and described by the error, nothing is claimed or stored, and a retry
 * works. Also offline and at 6x CPU. Synthetic text only; Thread detail, where no recording is needed.
 * Ask why's failure path is the same component and is covered in tester-focus-combined.spec.ts.
 */

test.describe.configure({ mode: "serial" });

const LABEL = "Want me to remember why?";
const SAVE_FAILED = "That didn't save. Try again.";
const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";

const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};
const isAction = (method: string, headers: Record<string, string>) => method === "POST" && "next-action" in headers;
async function seed(title: string) {
  const db = admin();
  const t = await db.from("threads").insert({ user_id: uid, title, kind: "decision", status: "resolved", resolution: "decided", resolved_at: "2026-10-18T14:05:00Z" }).select("id").single();
  const d = await db.from("decisions").insert({ user_id: uid, thread_id: t.data!.id, choice: "Took the river route", reason_user: null, context_facts: [], decided_at: "2026-10-18T14:05:00Z" }).select("id").single();
  return { threadId: t.data!.id as string, decisionId: d.data!.id as string };
}
async function failActions() {
  await page.route("**/*", (route) => (isAction(route.request().method(), route.request().headers()) ? route.abort("failed") : route.continue()));
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Ftoday");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today/, { timeout: 60_000 });
  uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
});

test.afterEach(async () => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.setOffline(false);
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("a failed save: focus on the field, text kept, error tied to it, nothing stored; axe clean; retry saves and focuses the reason", async () => {
  const { threadId, decisionId } = await seed("Choose a route, retry");
  await page.goto(`/threads/${threadId}`);
  await page.getByRole("button", { name: "Add a reason now" }).click();
  const field = page.getByLabel(LABEL);
  await field.fill("Quieter roads.");
  await failActions();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(SAVE_FAILED)).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Quieter roads.");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("You added a reason for your decision.")).toHaveCount(0);
  expect((await admin().from("decisions").select("reason_user").eq("id", decisionId).single()).data!.reason_user).toBeNull();
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => v.id)).toEqual([]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(`#reason-${decisionId}`)).toBeFocused({ timeout: 10_000 });
  expect((await admin().from("decisions").select("reason_user").eq("id", decisionId).single()).data!.reason_user).toBe("Quieter roads.");
});

test("offline: the offline copy shows and focus is on the field", async () => {
  const { threadId } = await seed("Choose a route, offline");
  await page.goto(`/threads/${threadId}`);
  await page.getByRole("button", { name: "Add a reason now" }).click();
  const field = page.getByLabel(LABEL);
  await field.fill("Quieter roads.");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled({ timeout: 10_000 });
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Quieter roads.");
});

test("CPU 6x, a held save that fails (3 runs): focus on the field, never left on <body>", async () => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  try {
    for (let i = 0; i < 3; i++) {
      const { threadId } = await seed(`Choose a route, slow ${i}`);
      await page.goto(`/threads/${threadId}`);
      await page.getByRole("button", { name: "Add a reason now" }).click();
      const field = page.getByLabel(LABEL);
      await field.fill("Quieter roads.");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      await page.route("**/*", async (route) => {
        if (!isAction(route.request().method(), route.request().headers())) return route.continue();
        await gate;
        return route.abort("failed");
      });
      await page.getByRole("button", { name: "Save" }).click();
      await page.waitForTimeout(300);
      release();
      await expect(page.getByText(SAVE_FAILED)).toBeVisible({ timeout: 15_000 });
      await expect(field, `run ${i + 1}`).toBeFocused({ timeout: 5_000 });
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
});
