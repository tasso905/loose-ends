import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { clinicPdf, encryptedPdf } from "../fixtures/tester-documents";
import { renewalPdf } from "../fixtures/documents";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester S6/S7 E2E: rules 1, 3, 5 and 10 on the real UI, orphan files, keyboard-only upload,
 * focus, axe and 375 px. Local Supabase + recorded LLM fixtures (AI_PROVIDER=fake); the clinic PDF's
 * adversarial recording is tests/fixtures/llm/tester-clinic-pdf.extract.json. Synthetic files only.
 *
 * `test.fail` pins a defect: it asserts the SAFE behaviour and currently fails.
 */

test.describe.configure({ mode: "serial" });

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";

const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};
const storedFiles = async () => ((await admin().storage.from("sources").list(uid, { limit: 1000 })).data ?? []).map((o) => o.name);
const sourceIds = async () => ((await admin().from("sources").select("id").eq("user_id", uid)).data ?? []).map((r) => r.id as string);
const file = (name: string, bytes: Uint8Array | string, mimeType = "application/pdf") => ({
  name,
  mimeType,
  buffer: Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes),
});
async function axe() {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
const isServerAction = (method: string, headers: Record<string, string>) => method === "POST" && "next-action" in headers;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add$/);
  uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
});

test.afterAll(async () => {
  if (uid) {
    const names = await storedFiles();
    if (names.length > 0) await admin().storage.from("sources").remove(names.map((n) => `${uid}/${n}`));
  }
  await context?.close();
  await deleteUsers([email]);
});

test.beforeEach(async () => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("rules 1, 3, 5: the adversarial clinic PDF shows only verified quotes, no invented dates/amounts, interpretation labelled", async () => {
  await page.goto("/add?mode=upload");
  await page.locator("#file").setInputFiles(file("Clinic reminder.pdf", clinicPdf()));
  await page.getByText("When was this written?").click();
  await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill("2026-10-05");
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 1 thing in this" })).toBeVisible({ timeout: 20_000 });
  // The kept quote is on page 3 (page 2 has no text layer); the item with the invented quote is gone.
  await expect(page.getByText("Clinic reminder · p. 3")).toBeVisible();
  await expect(page.getByText("Pay the missed-appointment fee")).toHaveCount(0);
  await expect(page.getByText(/\$50/)).toHaveCount(0);

  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();
  const { data: threads } = await admin().from("threads").select("id").eq("user_id", uid);
  await page.goto(`/threads/${threads![0]!.id}`);

  const card = page.getByRole("region", { name: "About this document" });
  await expect(card).toBeVisible();
  // Rule 1: fabricated source line absent; the fuzzy one shows the source's own words.
  await expect(card.getByText("This is your final notice before cancellation.")).toHaveCount(0);
  await expect(card.locator("blockquote").filter({ hasText: "A missed appointment fee of $45 applies without 24 hours notice." })).toBeVisible();
  await expect(card.getByText("24 hours' notice")).toHaveCount(0);
  for (const q of await card.locator("blockquote").allInnerTexts()) {
    expect(
      [
        "Appointment reminder for patient TEST-0042",
        "Your cleaning is booked for November 12, 2026 at 3:30 PM.",
        "A missed appointment fee of $45 applies without 24 hours notice.",
      ],
    ).toContain(q.trim());
  }
  await expect(card.getByText("Clinic reminder · p. 3")).toBeVisible();
  // Rule 3: no invented date or amount anywhere on the page.
  for (const invented of ["November 5", "$90", "May 2027", "December 1", "$50"]) {
    await expect(page.getByText(invented, { exact: false })).toHaveCount(0);
  }
  // Rule 5: the kept interpretation line carries the Interpretation label; Worth considering hidden.
  const interp = card.locator("li").filter({ hasText: "Call the clinic to confirm." });
  await expect(interp.getByText("Interpretation", { exact: true })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Worth considering" })).toHaveCount(0);
  await expect(card.getByText("Whether the clinic accepts email confirmations")).toBeVisible();
  await axe();
});

test("rule 10: while the server action is in flight nothing claims success; the page moves only after the server confirms", async () => {
  await page.goto("/add?mode=upload");
  await page.locator("#file").setInputFiles(file("Renewal notice.pdf", renewalPdf()));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/add**", async (route) => {
    if (isServerAction(route.request().method(), route.request().headers())) await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Review source" }).click();
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/add\?mode=upload$/);
  await expect(page.locator("form[aria-busy=true]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Review source" })).toBeDisabled();
  await expect(page.getByRole("heading", { level: 1, name: /I found/ })).toHaveCount(0);
  release();
  await expect(page).toHaveURL(/\/review\//, { timeout: 20_000 });
});

// DEFECT (orphan file): the browser uploads the file to storage first, then calls submitUpload. If
// that call never reaches the server (network drop, tab closed, server error before the action
// runs) the user sees "That didn't save. Try again." but the file stays in the private bucket with no
// source row: it is not listed anywhere, not exported, and only account deletion removes it. Try
// again uploads a second copy under a new id. Safe behaviour: a failed submit leaves no file behind
// (e.g. the client removes its own upload on failure, and/or a sweep deletes unclaimed objects).
test.fail("a submit that fails after the storage upload leaves no orphan file", async () => {
  const before = await storedFiles();
  const sourcesBefore = await sourceIds();
  await page.goto("/add?mode=upload");
  await page.locator("#file").setInputFiles(file("Renewal notice.pdf", renewalPdf()));
  await page.route("**/add**", (route) =>
    isServerAction(route.request().method(), route.request().headers()) ? route.abort("connectionreset") : route.continue(),
  );
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByText("That didn't save. Try again.")).toBeVisible({ timeout: 15_000 });
  expect(await sourceIds()).toEqual(sourcesBefore);
  expect((await storedFiles()).filter((n) => !before.includes(n))).toEqual([]);
});

test("refusal states: encrypted PDF copy, Choose another file, Remove returns focus to the picker; axe passes", async () => {
  await page.goto("/add?mode=upload");
  await page.locator("#file").setInputFiles(file("locked.pdf", encryptedPdf()));
  await expect(page.getByRole("button", { name: "Remove locked.pdf" })).toBeVisible();
  await axe(); // chosen-file row
  await page.getByRole("button", { name: "Remove locked.pdf" }).click();
  await expect(page.locator("#file")).toBeFocused();

  await page.locator("#file").setInputFiles(file("locked.pdf", encryptedPdf()));
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByText("I couldn't open this PDF. It may be damaged or locked with a password.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Choose another file" })).toBeVisible();
  await axe(); // field error state
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose another file" }).click();
  await (await chooser).setFiles(file("Renewal notice.pdf", renewalPdf()));
  await expect(page.getByText("Renewal notice.pdf")).toBeVisible();
  await expect(page.getByText("I couldn't open this PDF.", { exact: false })).toHaveCount(0);
});

test("keyboard only: Upload tab → picker (Enter opens the chooser) → Review source → review with the source caption", async () => {
  await page.goto("/add?mode=paste");
  const uploadTab = page.getByRole("navigation", { name: "Add mode" }).getByRole("link", { name: "Upload" });
  const focusable = await page.evaluate(
    () => document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea, summary').length,
  );
  for (let i = 0; i <= focusable && !(await uploadTab.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Shift+Tab");
  }
  await expect(uploadTab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/mode=upload/);
  // Switching mode keeps focus on the tab (client navigation); the picker is the next stop(s).
  const picker = page.locator("#file");
  for (let i = 0; i < 6 && !(await picker.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(picker).toBeFocused();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles(file("Mike email.txt", MIKE, "text/plain"));
  await expect(page.getByText("Mike email.txt")).toBeVisible();
  const submit = page.getByRole("button", { name: "Review source" });
  for (let i = 0; i < 12 && !(await submit.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: /I found 2 things in this/ })).toBeVisible({ timeout: 20_000 });
  // A text upload has no pages: the caption is title + written-on date.
  await expect(page.getByText(/^Mike email · [A-Z][a-z]{2} \d{1,2}$/).first()).toBeVisible();
  const { data } = await admin().from("sources").select("mime_type, page_offsets, title").eq("user_id", uid).order("created_at", { ascending: false }).limit(1);
  expect(data?.[0]).toEqual({ mime_type: "text/plain", page_offsets: null, title: "Mike email" });
});

test("375 px: Upload mode has no horizontal scroll; tabs and Remove are at least 44 px tall; axe passes", async () => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/add?mode=upload");
  await page.locator("#file").setInputFiles(file("A rather long synthetic file name for the layout check.pdf", renewalPdf()));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const loc of [
    page.getByRole("navigation", { name: "Add mode" }).getByRole("link", { name: "Upload" }),
    page.getByRole("navigation", { name: "Add mode" }).getByRole("link", { name: "Paste" }),
    page.getByRole("button", { name: /^Remove / }),
    page.getByRole("button", { name: "Review source" }),
  ]) {
    const box = await loc.boundingBox();
    expect(box?.height ?? 0, await loc.innerText()).toBeGreaterThanOrEqual(44);
  }
  await axe();
});

test("compact Explain card for a paste thread with no brief: no empty sections; axe passes", async () => {
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByText("When was this written?").click();
  await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill("2026-10-05");
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /I found 2 things in this/ })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText(/thread(s)? added/)).toBeVisible();
  const { data: t } = await admin().from("threads").select("id, title").eq("user_id", uid).ilike("title", "%proposal%").limit(1);
  await page.goto(`/threads/${t![0]!.id}`);
  // No brief for a short paste: the compact card (F7: no empty sections), with the thread's own fields.
  const card = page.getByRole("region", { name: "About this", exact: true });
  await expect(card).toBeVisible();
  await expect(page.getByRole("region", { name: "About this document" })).toHaveCount(0);
  await expect(card.getByRole("heading", { name: "What you need to do" })).toBeVisible();
  await expect(card.getByRole("heading", { name: "By when" })).toBeVisible();
  for (const h of await card.getByRole("heading", { level: 3 }).all()) {
    // Every shown heading has content after it.
    const section = h.locator("xpath=..");
    expect((await section.innerText()).trim().length).toBeGreaterThan((await h.innerText()).trim().length);
  }
  for (const h of ["What this is", "If you don't", "Worth considering"]) await expect(card.getByRole("heading", { name: h })).toHaveCount(0);
  await axe();
});
