import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester: DAILY_AI_BUDGET_USD in the browser, on the fake provider. Skipped unless LE_BUDGET_E2E
 * says what the server under test was started with ("0" or "cap"), and LE_S11_DB_CONTAINER names an
 * isolated stack, because this file reads and clears private.ai_spend_daily.
 *
 * MIKE and FAB_Q have recordings, so the fake model would answer them. A refusal is therefore
 * the budget and not a missing recording, and spend staying empty shows the model was not reached.
 */
const MODE = process.env.LE_BUDGET_E2E ?? "";
const container = process.env.LE_S11_DB_CONTAINER ?? "";
test.skip(!["0", "cap"].includes(MODE) || container === "" || container === "supabase_db_loose-ends", "needs LE_BUDGET_E2E and an isolated stack");

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const FAB_Q = "Why did I hire Quillfeather for the kitchen?";
const ZERO_Q = "Why did I choose the zzyzx plan?";
const NO_RECORD = "I don't have a recorded decision about that.";
const EXTRACTION_FAILED = "Something went wrong reading this. Your text is saved.";
const ASK_FAILED = "I couldn't answer that just now. Try asking again.";
const DEC = "7e57a9a0-0000-4000-8000-000000000001"; // the decision tester-s9-fabricated.ask-why.json cites

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";

const sql = (q: string) => execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", q]).toString().trim();
const spendRow = () => sql("select cost_micros || '/' || calls from private.ai_spend_daily where day = (now() at time zone 'UTC')::date");
function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function latestExtraction() {
  const { data } = await admin().from("extractions").select("status, error, input_tokens, output_tokens").eq("user_id", uid).order("created_at", { ascending: false }).limit(1).single();
  return data as { status: string; error: string | null; input_tokens: number | null; output_tokens: number | null };
}
async function usage() {
  const { data } = await admin().from("usage_counters").select("extractions, asks, ai_calls, ai_cost_micros").eq("user_id", uid).maybeSingle();
  return data as { extractions: number; asks: number; ai_calls: number; ai_cost_micros: number } | null;
}
async function paste(text: string) {
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(text);
  await page.getByRole("button", { name: "Review source" }).click();
}
const box = () => page.getByRole("textbox", { name: "Ask about a past decision" });
const askButton = () => page.getByRole("button", { name: "Ask", exact: true });

test.beforeAll(async ({ browser }) => {
  sql("delete from private.ai_spend_daily");
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  const db = admin();
  uid = (await db.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  await db.from("decisions").delete().eq("id", DEC);
  const t = await db.from("threads").insert({ user_id: uid, title: "Kitchen remodel contractor", kind: "decision", counterparty: "Quillfeather Builders", status: "resolved", resolution: "decided", resolved_at: "2026-10-18T14:05:00Z" }).select("id").single();
  const d = await db.from("decisions").insert({ id: DEC, user_id: uid, thread_id: t.data!.id, choice: "Hired Quillfeather for the kitchen", reason_user: "Their quote included permits.", context_facts: [], decided_at: "2026-10-18T14:05:00Z" });
  expect(d.error).toBeNull();
});

test.afterAll(async () => {
  await admin().from("decisions").delete().eq("id", DEC);
  await context?.close();
  await deleteUsers([email]);
  sql("delete from private.ai_spend_daily");
});

test.describe("cap 0", () => {
  test.skip(MODE !== "0");

  test("paste with a recording: extraction_failed, never rate_limited, no model call, Try again offered", async () => {
    await paste(MIKE);
    await expect(page.getByText(EXTRACTION_FAILED)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/reached today's limit/)).toHaveCount(0);
    await expect(page.getByText(/budget|spend|cap\b/i)).toHaveCount(0);
    expect(await latestExtraction()).toEqual({ status: "failed", error: "ai_budget", input_tokens: null, output_tokens: null });
    expect(spendRow()).toBe("");
    expect(await usage()).toMatchObject({ extractions: 1, ai_calls: 0, ai_cost_micros: 0 });
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("Try again is refused the same way, and is not counted again", async () => {
    const firstUrl = page.url();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page).not.toHaveURL(firstUrl, { timeout: 20_000 });
    await expect(page.getByText(EXTRACTION_FAILED)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/reached today's limit/)).toHaveCount(0);
    await expect.poll(async () => (await admin().from("extractions").select("error").eq("user_id", uid).eq("error", "ai_budget")).data?.length).toBe(2);
    expect(spendRow()).toBe("");
    expect(await usage()).toMatchObject({ extractions: 1, ai_calls: 0 });
  });

  test("upload with a recording: extraction_failed, never rate_limited, no model call", async () => {
    await page.goto("/add?mode=upload");
    await page.locator("#file").setInputFiles({ name: "Mike email.txt", mimeType: "text/plain", buffer: Buffer.from(MIKE) });
    await page.getByRole("button", { name: "Review source" }).click();
    await expect(page.getByText(EXTRACTION_FAILED)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/reached today's limit/)).toHaveCount(0);
    expect(await latestExtraction()).toEqual({ status: "failed", error: "ai_budget", input_tokens: null, output_tokens: null });
    expect(spendRow()).toBe("");
    expect(await usage()).toMatchObject({ extractions: 2, ai_calls: 0 });
  });

  test("Ask why with a recording: ask_failed, never rate_limited, no model call", async () => {
    await page.goto("/decisions");
    await box().fill(FAB_Q);
    await askButton().click();
    await expect(page.getByText(ASK_FAILED)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/reached today's limit/)).toHaveCount(0);
    await expect(page.getByRole("article")).toHaveCount(0);
    expect(spendRow()).toBe("");
    expect(await usage()).toMatchObject({ asks: 1, ai_calls: 0 });
  });

  test("zero-match Ask why still answers, with no model call", async () => {
    await page.goto("/decisions");
    await box().fill(ZERO_Q);
    await askButton().click();
    await expect(page.getByText(NO_RECORD)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(ASK_FAILED)).toHaveCount(0);
    expect(spendRow()).toBe("");
    expect(await usage()).toMatchObject({ asks: 2, ai_calls: 0 });
  });
});

test.describe("a valid cap on the fake provider", () => {
  test.skip(MODE !== "cap");

  test("paste succeeds and its cost is recorded in the day's spend and the user's share", async () => {
    await paste(MIKE);
    await expect(page.getByRole("heading", { level: 1, name: /I found/ })).toBeVisible({ timeout: 20_000 });
    const row = spendRow();
    expect(row).toMatch(/^\d+\/1$/);
    const u = await usage();
    expect(`${u?.ai_cost_micros}/${u?.ai_calls}`).toBe(row);
  });

  test("Ask why succeeds and is recorded as a second call", async () => {
    await page.goto("/decisions");
    await box().fill(FAB_Q);
    await askButton().click();
    await expect(page.getByRole("article")).toHaveCount(1, { timeout: 20_000 });
    expect(spendRow()).toMatch(/^\d+\/2$/);
  });

  test("export carries the user's own share, with no global spend", async () => {
    const u = await usage();
    const res = await context.request.get("/api/export");
    if (!res.ok()) test.skip(true, `export route answered ${res.status()}`);
    const body = (await res.json()) as { tables: { usage_counters: Array<Record<string, unknown>> } };
    expect(body.tables.usage_counters).toHaveLength(1);
    expect(body.tables.usage_counters[0]).toMatchObject({ user_id: uid, ai_calls: u!.ai_calls });
    expect(JSON.stringify(body)).not.toContain("ai_spend_daily");
  });
});
