import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * S9 F12 Ask why and the Decisions page against local Supabase and recorded LLM fixtures
 * (AI_PROVIDER=fake). The decision is seeded with a fixed ID so the recording
 * (tests/fixtures/llm/e2e-proposal.ask-why.json) can cite it; the recording also cites a decision
 * that was not retrieved and a fragment of the reason, which must not reach the page (rule 7, D33).
 * A question with no recording would fail in the fake provider, so the no-record answer also shows
 * that the model was not called.
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const TITLE = "Send revised proposal to Mike";
const DEC = "e2e5a9a0-0000-4000-8000-000000000001";
const EV = "e2e5a9a0-0000-4000-8000-0000000000e1";
const CHOICE = "Send the corrected proposal Friday";
const REASON = "  Mike asked for it twice,\nand the old draft had the wrong price.  ";
const FACT = "I'll send you the revised proposal Friday.";
const ASK = "Why did I send the revised proposal to Mike?";
const NO_MATCH = "Why did I sell the piano?";
const FAILS = "Why did I pick Mike's proposal?"; // retrieves the decision; no recording, so the model call fails

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let threadId = "";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function expectNoViolations() {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const isServerAction = (method: string, headers: Record<string, string>) => method === "POST" && "next-action" in headers;
const box = () => page.getByRole("textbox", { name: "Ask about a past decision" });
const askButton = () => page.getByRole("button", { name: "Ask", exact: true });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add$/);
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("Decisions with nothing recorded: nav item, heading, Ask box, empty state; axe passes", async () => {
  await page.goto("/today");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Decisions" }).click();
  await expect(page).toHaveURL(/\/decisions$/);
  await expect(page.getByRole("link", { name: "Decisions" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "Decisions" })).toBeVisible();
  await expect(box()).toHaveAttribute("placeholder", "Ask about a past decision");
  await expect(box()).toHaveAttribute("maxlength", "300");
  await expect(askButton()).toBeDisabled();
  await expect(page.getByText("Decisions you record when resolving threads will appear here.")).toBeVisible();
  await expectNoViolations();
});

test("a decision appears in the list, newest first, linking to its thread", async () => {
  await page.goto("/add");
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();

  const db = admin();
  const uid = (await db.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  threadId = (await db.from("threads").select("id").eq("user_id", uid).single()).data!.id as string;
  await db.from("decisions").delete().eq("id", DEC); // a leftover from an aborted run
  await db.from("threads").update({ status: "resolved", resolution: "decided", resolved_at: "2026-10-18T14:05:00Z" }).eq("id", threadId);
  const ins = await db.from("decisions").insert({
    id: DEC,
    user_id: uid,
    thread_id: threadId,
    choice: CHOICE,
    reason_user: REASON,
    context_facts: [{ text: FACT, evidence_id: EV }],
    decided_at: "2026-10-18T14:05:00Z",
  });
  expect(ins.error).toBeNull();

  await page.goto("/decisions");
  const row = page.getByRole("link", { name: new RegExp(CHOICE) });
  await expect(row).toContainText(TITLE);
  await expect(row).toContainText("Oct 18, 2026");
  await expect(row).toHaveAttribute("href", `/threads/${threadId}`);
});

test("rule 10: while the ask is in flight nothing is shown as an answer", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/decisions*", async (route) => {
    if (isServerAction(route.request().method(), route.request().headers())) await gate;
    await route.continue();
  });
  await box().fill(ASK);
  await askButton().click();
  await expect(askButton()).toBeDisabled();
  await expect(page.getByText("You decided ·")).toHaveCount(0);
  release();
  await expect(page.getByText(/^You decided · /)).toBeVisible({ timeout: 10_000 });
  await page.unrouteAll();
});

test("the answer: You decided, You wrote (the whole stored reason, verbatim), From the source, Interpretation, Open thread; nothing from outside the retrieved set", async () => {
  const card = page.getByRole("article", { name: "You decided · Oct 18, 2026" });
  await expect(card).toHaveCount(1);
  await expect(card.getByText(CHOICE)).toBeVisible();
  await expect(card.getByText("You wrote:")).toBeVisible();
  expect(await card.getByTestId("reason").textContent()).toBe(REASON);
  await expect(card.getByText("From the source:")).toBeVisible();
  await expect(card.locator("blockquote.font-serif")).toHaveText(FACT);
  await expect(card.getByText("Interpretation:")).toBeVisible();
  await expect(card.getByText("Getting the price right seems to have mattered most.")).toBeVisible();
  // The recording's fragment of the reason, its paraphrased fact and the invented decision are not shown.
  await expect(page.getByText("Blue is calming.")).toHaveCount(0);
  await expect(page.getByText("send you the revised proposal", { exact: true })).toHaveCount(0);
  // Fixed order: You decided → You wrote → From the source → Interpretation → Open thread.
  const order = await card.evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " "));
  const at = (s: string) => order.indexOf(s);
  expect(at("You decided")).toBeLessThan(at("You wrote:"));
  expect(at("You wrote:")).toBeLessThan(at("From the source:"));
  expect(at("From the source:")).toBeLessThan(at("Interpretation:"));
  expect(at("Interpretation:")).toBeLessThan(at("Open thread"));
  await expect(card.getByRole("link", { name: `Open thread: ${TITLE}` })).toHaveAttribute("href", `/threads/${threadId}`);
  // ?q= holds the last question (SITE_CONTRACT §1.2).
  await expect(page).toHaveURL(`/decisions?q=${encodeURIComponent(ASK)}`);
  await expectNoViolations();
});

test("rule 7: no matching decision → the no-record message, with no model call (no recording exists for it)", async () => {
  await box().fill(NO_MATCH);
  await askButton().click();
  await expect(page.getByText("I don't have a recorded decision about that.")).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByText("I couldn't answer that just now. Try asking again.")).toHaveCount(0);
});

test("D54: a failed ask shows ask_failed inline under the box with Try again, keeps the question, and leaves no answer", async () => {
  // A previous answer on screen is cleared by the new ask.
  await box().fill(ASK);
  await askButton().click();
  await expect(page.getByRole("article")).toHaveCount(1);

  await box().fill(FAILS);
  await askButton().click();
  const msg = page.getByText("I couldn't answer that just now. Try asking again.");
  await expect(msg).toBeVisible();
  await expect(box()).toHaveValue(FAILS);
  await expect(box()).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByText(/^You decided · /)).toHaveCount(0);
  // Under the box, not a page banner or a toast.
  const boxBottom = (await box().boundingBox())!;
  expect((await msg.boundingBox())!.y).toBeGreaterThan(boxBottom.y + boxBottom.height - 1);
  await expectNoViolations();

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(msg).toBeVisible();
  await expect(box()).toHaveValue(FAILS);
});

test("?q= prefills the box without asking; thread detail links the decision to Ask Why", async () => {
  await page.goto(`/threads/${threadId}`);
  const link = page.getByRole("region", { name: "Decision" }).getByRole("link", { name: "Ask why" });
  await expect(link).toHaveAttribute("href", `/decisions?q=${encodeURIComponent(TITLE)}`);
  await link.click();
  await expect(page).toHaveURL(/\/decisions\?q=/);
  await expect(box()).toHaveValue(TITLE);
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByText("I don't have a recorded decision about that.")).toHaveCount(0);
});

test("375 px: no horizontal scroll, 44 px targets; axe passes", async () => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/decisions");
  await box().fill(ASK);
  await askButton().click();
  await expect(page.getByRole("article")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const el of [box(), askButton(), page.getByRole("link", { name: `Open thread: ${TITLE}` })]) {
    expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await expectNoViolations();
  await page.setViewportSize({ width: 1280, height: 800 });
});
