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
const SAVE_FAILED = "That didn't save. Try again.";
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
async function usage() {
  const { data } = await admin().from("usage_counters").select("extractions, asks").eq("user_id", uid).maybeSingle();
  return data ? (data as { extractions: number; asks: number }) : { extractions: 0, asks: 0 };
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

  test("paste with a recording: save_failed, never rate_limited, no model call, nothing saved or counted, text kept", async () => {
    await paste(MIKE);
    await expect(page.getByText(SAVE_FAILED)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/reached today's limit/)).toHaveCount(0);
    await expect(page.getByText(/budget|spend|cap\b/i)).toHaveCount(0);
    await expect(page.getByLabel("Paste a message or document")).toHaveValue(MIKE);
    await expect(page).toHaveURL(/\/add/);
    expect((await admin().from("sources").select("id").eq("user_id", uid)).data).toEqual([]);
    expect(spendRow()).toBe("");
    expect(await usage()).toMatchObject({ extractions: 0 });
  });

  test("Try again on a failed source is refused, starts no attempt and uses none of the 3", async () => {
    const db = admin();
    const s = await db.from("sources").insert({ user_id: uid, kind: "paste", text_content: MIKE, reference_date: "2026-11-04", reference_date_source: "user", pipeline_attempts: 1 }).select("id").single();
    expect(s.error).toBeNull();
    const e = await db.from("extractions").insert({ user_id: uid, source_id: s.data!.id, status: "failed", error: "ai_budget", model: "recorded", prompt_version: "t", schema_version: "t" }).select("id").single();
    expect(e.error).toBeNull();
    await page.goto(`/review/${e.data!.id}`);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText(SAVE_FAILED)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/reached today's limit/)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(e.data!.id));
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    expect((await db.from("extractions").select("id").eq("source_id", s.data!.id)).data).toHaveLength(1);
    expect((await db.from("sources").select("pipeline_attempts").eq("id", s.data!.id).single()).data?.pipeline_attempts).toBe(1);
    expect(spendRow()).toBe("");
    await db.from("sources").delete().eq("id", s.data!.id);
  });

  test("upload with a recording: save_failed, never rate_limited, no model call, nothing kept or counted", async () => {
    await page.goto("/add?mode=upload");
    await page.locator("#file").setInputFiles({ name: "Mike email.txt", mimeType: "text/plain", buffer: Buffer.from(MIKE) });
    await page.getByRole("button", { name: "Review source" }).click();
    await expect(page.getByText(SAVE_FAILED)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/reached today's limit/)).toHaveCount(0);
    expect((await admin().from("sources").select("id").eq("user_id", uid)).data).toEqual([]);
    await expect.poll(async () => (await admin().storage.from("sources").list(uid)).data?.length ?? 0).toBe(0);
    expect(spendRow()).toBe("");
    expect(await usage()).toMatchObject({ extractions: 0 });
  });

  test("Ask why with a recording: ask_failed, never rate_limited, no model call", async () => {
    await page.goto("/decisions");
    await box().fill(FAB_Q);
    await askButton().click();
    await expect(page.getByText(ASK_FAILED)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/reached today's limit/)).toHaveCount(0);
    await expect(page.getByRole("article")).toHaveCount(0);
    expect(spendRow()).toBe("");
    expect(await usage()).toMatchObject({ asks: 0 });
  });

  test("zero-match Ask why still answers, with no model call", async () => {
    await page.goto("/decisions");
    await box().fill(ZERO_Q);
    await askButton().click();
    await expect(page.getByText(NO_RECORD)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(ASK_FAILED)).toHaveCount(0);
    expect(spendRow()).toBe("");
    expect(await usage()).toMatchObject({ asks: 1 });
  });
});

test.describe("a valid cap on the fake provider", () => {
  test.skip(MODE !== "cap");

  test("paste succeeds and its cost is recorded in the day's spend", async () => {
    await paste(MIKE);
    await expect(page.getByRole("heading", { level: 1, name: /I found/ })).toBeVisible({ timeout: 20_000 });
    expect(spendRow()).toMatch(/^\d+\/1$/);
    expect(await usage()).toMatchObject({ extractions: 1 });
  });

  test("Ask why succeeds and is recorded as a second call", async () => {
    await page.goto("/decisions");
    await box().fill(FAB_Q);
    await askButton().click();
    await expect(page.getByRole("article")).toHaveCount(1, { timeout: 20_000 });
    expect(spendRow()).toMatch(/^\d+\/2$/);
  });

  test("export carries no global spend", async () => {
    const res = await context.request.get("/api/export");
    if (!res.ok()) test.skip(true, `export route answered ${res.status()}`);
    const body = (await res.json()) as { tables: { usage_counters: Array<Record<string, unknown>> } };
    expect(body.tables.usage_counters).toHaveLength(1);
    expect(body.tables.usage_counters[0]).toMatchObject({ user_id: uid, extractions: 1, asks: 1 });
    expect(JSON.stringify(body)).not.toContain("ai_spend_daily");
  });
});
