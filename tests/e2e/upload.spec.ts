import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { renewalPdf, scannedPdf } from "../fixtures/documents";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * S6 / S7 core-loop checkpoint: "Text-layer PDF → Explain card; scanned PDF shows the unsupported
 * message." Local Supabase (Auth, Storage with RLS) and recorded LLM fixtures (AI_PROVIDER=fake;
 * tests/fixtures/llm/renewal-pdf.extract.json). The PDFs are generated in code (synthetic).
 */

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function storedFiles(): Promise<string[]> {
  const { data } = await admin().storage.from("sources").list(uid, { limit: 100 });
  return (data ?? []).map((o) => o.name);
}

async function expectNoViolations() {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const pdfFile = (name: string, buffer: Uint8Array) => ({ name, mimeType: "application/pdf", buffer: Buffer.from(buffer) });

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
  // Storage objects are not cascaded by deleting the auth user (account deletion removes them first).
  if (uid) {
    const names = await storedFiles();
    if (names.length > 0) await admin().storage.from("sources").remove(names.map((n) => `${uid}/${n}`));
  }
  await context?.close();
  await deleteUsers([email]);
});

test("Upload mode: tab selected, picker focused, drop zone copy; axe passes", async () => {
  await page.goto("/add?mode=upload");
  const tabs = page.getByRole("navigation", { name: "Add mode" });
  await expect(tabs.getByRole("link", { name: "Upload" })).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link", { name: "Paste" })).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator("#file")).toBeFocused();
  await expect(page.getByText("Drop a file or choose one")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review source" })).toBeDisabled();
  await expectNoViolations();
});

test("a scanned (image-only) PDF shows the unsupported message and keeps nothing", async () => {
  await page.goto("/add?mode=upload");
  await page.locator("#file").setInputFiles(pdfFile("scan.pdf", scannedPdf()));
  await expect(page.getByText("scan.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This looks like a scan. I can't read scans yet." })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "Paste the text instead" })).toHaveAttribute("href", "/add?mode=paste");
  await expect(page).toHaveURL(/\/add\?mode=upload$/);
  await expectNoViolations();
  // Nothing guessed, nothing kept: no source row and the uploaded file was removed again.
  const { data: sources } = await admin().from("sources").select("id").eq("user_id", uid);
  expect(sources).toHaveLength(0);
  expect(await storedFiles()).toEqual([]);
});

test("a file that is not a PDF, TXT or MD is refused from its bytes, whatever its name", async () => {
  await page.goto("/add?mode=upload");
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await page.locator("#file").setInputFiles(pdfFile("looks-like.pdf", png));
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Loose Ends can read PDF, TXT and MD files." })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Choose another file" })).toBeVisible();
  expect(await storedFiles()).toEqual([]);
});

test("over 10 MB is refused before anything is sent", async () => {
  await page.goto("/add?mode=upload");
  await page.locator("#file").setInputFiles(pdfFile("big.pdf", new Uint8Array(10 * 1024 * 1024 + 200_000)));
  await expect(page.getByRole("alert").filter({ hasText: "This file is 10.2 MB. The limit is 10 MB." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review source" })).toBeDisabled();
  expect(await storedFiles()).toEqual([]);
});

test("text-layer PDF → review (quote with its page) → accept → thread with the Explain card", async () => {
  await page.goto("/add?mode=upload");
  await page.locator("#file").setInputFiles(pdfFile("Renewal notice.pdf", renewalPdf()));
  await page.getByText("When was this written?").click();
  await page.getByLabel("I assumed this was written today. Change it if it wasn't.").fill("2026-10-05");
  await page.getByRole("button", { name: "Review source" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "I found 1 thing in this" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Renewal notice · p. 2")).toBeVisible();
  await expect(page.getByText("To cancel or change your cover, call us before October 31, 2026.")).toBeVisible();

  // The source keeps its file in the private bucket at {uid}/{source_id}, with the page map.
  const { data: sources } = await admin().from("sources").select("id, kind, title, storage_path, mime_type, page_offsets").eq("user_id", uid);
  expect(sources).toHaveLength(1);
  const src = sources![0]!;
  expect(src).toMatchObject({ kind: "upload", title: "Renewal notice", mime_type: "application/pdf", storage_path: `${uid}/${src.id}` });
  expect((src.page_offsets as number[]).length).toBe(2);
  expect(await storedFiles()).toEqual([src.id]);

  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();

  const { data: threads } = await admin().from("threads").select("id").eq("user_id", uid);
  expect(threads).toHaveLength(1);
  await page.goto(`/threads/${threads![0]!.id}`);

  const card = page.getByRole("region", { name: "About this document" });
  await expect(card).toBeVisible();
  for (const h of ["What this is", "What you need to do", "By when", "If you don't", "Not sure about"]) {
    await expect(card.getByRole("heading", { name: h })).toBeVisible();
  }
  await expect(card.getByRole("heading", { name: "Worth considering" })).toHaveCount(0);
  // Source lines are the verbatim quotes, labelled with the source and page; the paraphrase is not shown.
  await expect(card.locator("blockquote").filter({ hasText: "Policy renewal notice for policy HM-000-TEST" })).toBeVisible();
  await expect(card.getByText("Renewal notice · p. 1").first()).toBeVisible();
  await expect(card.getByText("A renewal notice for your home policy")).toHaveCount(0);
  await expect(card.getByText("Interpretation")).toBeVisible();
  await expect(card.getByText("If the new price is fine, you don't need to do anything.")).toBeVisible();
  await expect(card.getByText("Whether the premium can be paid monthly")).toBeVisible();
  // The thread's own evidence also names its page.
  await expect(page.getByRole("region", { name: "Evidence" }).getByText("Renewal notice · p. 2")).toBeVisible();
  await expectNoViolations();
});
