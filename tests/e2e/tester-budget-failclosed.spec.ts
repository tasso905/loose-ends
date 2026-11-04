import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester: DAILY_AI_BUDGET_USD fails closed in the browser. Only for a server started with
 * AI_PROVIDER=google and NO AI_API_KEY, so no request can reach Google whatever the code does, and with
 * the cap unset, invalid, or the service key missing. Skipped unless LE_BUDGET_CLOSED=1 on an isolated
 * stack. The server log, read by the runner, shows which refusal it was.
 */
const container = process.env.LE_S11_DB_CONTAINER ?? "";
test.skip(process.env.LE_BUDGET_CLOSED !== "1" || container === "" || container === "supabase_db_loose-ends", "needs LE_BUDGET_CLOSED and an isolated stack");

const SAVE_FAILED = "That didn't save. Try again.";
const ASK_FAILED = "I couldn't answer that just now. Try asking again.";
const NO_RECORD = "I don't have a recorded decision about that.";
const TEXT = "Thanks Mike. I'll send you the revised proposal Friday.";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";
const bodies: string[] = [];

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
const spendRow = () => execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", "select cost_micros || '/' || calls from private.ai_spend_daily where day = (now() at time zone 'UTC')::date"]).toString().trim();
async function usage() {
  const { data } = await admin().from("usage_counters").select("extractions, asks").eq("user_id", uid).maybeSingle();
  return data ?? { extractions: 0, asks: 0 };
}
/** Nothing that names a key, a stack frame or the budget reaches the page or an action's response. */
async function expectNothingLeaked() {
  const html = await page.content();
  const key = localSupabase().serviceRoleKey;
  for (const text of [...bodies, html]) {
    expect(text.includes(key), "service key").toBe(false);
    for (const bad of [/SUPABASE_SERVICE_ROLE_KEY/, /service_role/, /AiBudgetError/, /budgetDb/, /ai_budget/, /createAdminClient/, /node_modules/, /\bat .*\.(js|ts):\d+/, /AI_API_KEY/]) {
      expect(bad.test(text), String(bad)).toBe(false);
    }
  }
}

test.beforeAll(async ({ browser }) => {
  execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-c", "delete from private.ai_spend_daily"]);
  context = await browser.newContext();
  page = await context.newPage();
  page.on("response", async (r) => {
    if (r.request().method() === "POST" && "next-action" in r.request().headers()) bodies.push(await r.text().catch(() => ""));
  });
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  const db = admin();
  uid = (await db.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  const t = await db.from("threads").insert({ user_id: uid, title: "Kitchen remodel contractor", kind: "decision", status: "resolved", resolution: "decided", resolved_at: "2026-10-18T14:05:00Z" }).select("id").single();
  const d = await db.from("decisions").insert({ user_id: uid, thread_id: t.data!.id, choice: "Hired Quillfeather for the kitchen", reason_user: "Their quote included permits.", context_facts: [], decided_at: "2026-10-18T14:05:00Z" });
  expect(d.error).toBeNull();
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("paste: save_failed, text kept, nothing saved or counted", async () => {
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(TEXT);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByText(SAVE_FAILED)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Paste a message or document")).toHaveValue(TEXT);
  expect((await admin().from("sources").select("id").eq("user_id", uid)).data).toEqual([]);
  expect(await usage()).toMatchObject({ extractions: 0 });
  await expectNothingLeaked();
});

test("upload: save_failed, no file kept, nothing saved or counted", async () => {
  await page.goto("/add?mode=upload");
  await page.locator("#file").setInputFiles({ name: "Mike email.txt", mimeType: "text/plain", buffer: Buffer.from(TEXT) });
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByText(SAVE_FAILED)).toBeVisible({ timeout: 20_000 });
  expect((await admin().from("sources").select("id").eq("user_id", uid)).data).toEqual([]);
  await expect.poll(async () => (await admin().storage.from("sources").list(uid)).data?.length ?? 0).toBe(0);
  expect(await usage()).toMatchObject({ extractions: 0 });
  await expectNothingLeaked();
});

test("Try again on a failed source: save_failed, no attempt used", async () => {
  const db = admin();
  const s = await db.from("sources").insert({ user_id: uid, kind: "paste", text_content: TEXT, reference_date: "2026-11-04", reference_date_source: "user", pipeline_attempts: 1 }).select("id").single();
  const e = await db.from("extractions").insert({ user_id: uid, source_id: s.data!.id, status: "failed", error: "ai_budget", model: "recorded", prompt_version: "t", schema_version: "t" }).select("id").single();
  await page.goto(`/review/${e.data!.id}`);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(SAVE_FAILED)).toBeVisible({ timeout: 20_000 });
  expect((await db.from("extractions").select("id").eq("source_id", s.data!.id)).data).toHaveLength(1);
  expect((await db.from("sources").select("pipeline_attempts").eq("id", s.data!.id).single()).data?.pipeline_attempts).toBe(1);
  await expectNothingLeaked();
  await db.from("sources").delete().eq("id", s.data!.id);
});

test("Ask why with a match: ask_failed, not counted; zero match still answers", async () => {
  await page.goto("/decisions");
  const box = page.getByRole("textbox", { name: "Ask about a past decision" });
  await box.fill("Why did I hire Quillfeather for the kitchen?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText(ASK_FAILED)).toBeVisible({ timeout: 20_000 });
  expect(await usage()).toMatchObject({ asks: 0 });
  await expectNothingLeaked();
  await page.goto("/decisions");
  await box.fill("Why did I choose the zzyzx plan?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText(NO_RECORD)).toBeVisible({ timeout: 20_000 });
  expect(await usage()).toMatchObject({ asks: 1 });
  expect(spendRow()).toBe("");
  await expectNothingLeaked();
  console.log(`action responses read: ${bodies.length}`);
  expect(bodies.length).toBeGreaterThanOrEqual(5);
});
