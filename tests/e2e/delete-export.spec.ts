import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * S11 (F13, F9 Forget, D14; rule 8) end to end against local Supabase and recorded LLM fixtures:
 * Settings → Data (sources list, both delete options, Export data, Delete account) and Forget
 * permanently on Thread detail. Irreversible actions confirm first and have no undo (D8); nothing
 * claims success before the server confirms (rule 10). Axe and 375 px. Synthetic text only.
 */

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";

test.describe.configure({ mode: "serial" });

const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";
let pasteThreadId = "";

const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};

async function axe() {
  // Only after finite animations end (a half-faded dialog is not a contrast failure).
  await page.evaluate(() =>
    Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => undefined))),
  );
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });
const fileExists = async (path: string) => {
  const slash = path.lastIndexOf("/");
  const { data } = await admin().storage.from("sources").list(path.slice(0, slash), { search: path.slice(slash + 1) });
  return (data ?? []).some((o) => o.name === path.slice(slash + 1));
};

/** An uploaded source (with its file) and a thread from it, seeded directly (no upload UI needed here). */
async function seedUpload(title: string) {
  const db = admin();
  const path = `${uid}/${randomUUID()}`;
  const up = await db.storage.from("sources").upload(path, new Blob(["Synthetic fence notes: order cedar posts Monday."]), { contentType: "text/plain" });
  expect(up.error).toBeNull();
  const src = await db
    .from("sources")
    .insert({ user_id: uid, kind: "upload", title, text_content: "Order cedar posts Monday.", storage_path: path, reference_date: "2026-10-20", reference_date_source: "user" })
    .select("id")
    .single();
  const thr = await db.from("threads").insert({ user_id: uid, title: "Order cedar posts", kind: "commitment", status: "open", primary_source_id: src.data!.id }).select("id").single();
  return { sourceId: src.data!.id as string, threadId: thr.data!.id as string, path };
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ acceptDownloads: true });
  page = await context.newPage();
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add$/);
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "I found 2 things in this" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();
  uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  pasteThreadId = (await admin().from("threads").select("id").eq("user_id", uid).single()).data!.id as string;
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
});

test("Settings is reachable from the header; Data lists the sources with both delete options, Export and Delete account; axe passes", async () => {
  await page.goto("/today");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { level: 2, name: "Data" })).toBeVisible();
  await expect(page.getByText("Pasted text", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete source only: Pasted text" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete source and everything from it: Pasted text" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export data (JSON)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete account…" })).toBeVisible();
  await axe();
});

test("Delete source only: the dialog lists what goes and what stays; Cancel deletes nothing and returns focus", async () => {
  const trigger = page.getByRole("button", { name: "Delete source only: Pasted text" });
  await trigger.click();
  const d = dialog("Delete source only?");
  await expect(d).toBeVisible();
  await expect(d.getByText("This deletes:")).toBeVisible();
  await expect(d.getByText("This stays:")).toBeVisible();
  await expect(d.getByText("You can't undo this.")).toBeVisible();
  await expect(d.getByRole("button", { name: "Cancel" })).toBeFocused();
  await axe();
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toBeHidden();
  await expect(trigger).toBeFocused();
  expect((await admin().from("sources").select("id").eq("user_id", uid)).data).toHaveLength(1);
});

test("Delete source only: confirmed, the row goes after the server confirms; the thread keeps its quote with `Source deleted`", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/settings", async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Delete source only: Pasted text" }).click();
  const d = dialog("Delete source only?");
  await d.getByRole("button", { name: "Delete source only" }).click();
  // Rule 10: while the server works, the dialog stays, Escape does nothing, and no success shows.
  await expect(d.getByRole("button", { name: "Delete source only" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(d).toBeVisible();
  await expect(page.getByText("Source deleted.")).toHaveCount(0);
  release();
  await expect(d).toBeHidden({ timeout: 10_000 });
  await page.unrouteAll();
  await expect(page.getByRole("status").filter({ hasText: "Source deleted." })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Your sources" })).toBeFocused();
  await expect(page.getByText("You haven't added anything yet.")).toBeVisible();
  expect((await admin().from("sources").select("id").eq("user_id", uid)).data).toEqual([]);

  await page.goto(`/threads/${pasteThreadId}`);
  await expect(page.getByRole("region", { name: "Evidence" }).getByText("Source deleted")).toBeVisible();
  await expect(page.getByRole("region", { name: "Evidence" }).locator("blockquote")).toHaveText("I'll send you the revised proposal Friday");
});

test("Delete source and everything from it: the source, its file and its thread are gone", async () => {
  const s = await seedUpload("Fence notes");
  expect(await fileExists(s.path)).toBe(true);
  await page.goto("/settings");
  await expect(page.getByText("Fence notes")).toBeVisible();
  await page.getByRole("button", { name: "Delete source and everything from it: Fence notes" }).click();
  const d = dialog("Delete source and everything from it?");
  await expect(d.getByText("Every thread that came from it, with its quotes, history, decision and reason")).toBeVisible();
  await d.getByRole("button", { name: "Delete source and everything from it" }).click();
  await expect(d).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole("status").filter({ hasText: "Source and 1 thread deleted." })).toBeVisible();
  expect((await admin().from("threads").select("id").eq("id", s.threadId)).data).toEqual([]);
  expect((await admin().from("sources").select("id").eq("id", s.sourceId)).data).toEqual([]);
  expect(await fileExists(s.path)).toBe(false);
});

test("a failed delete keeps the dialog open with the error inside it; nothing claims success", async () => {
  const s = await seedUpload("Gate notes");
  await page.goto("/settings");
  await page.route("**/settings", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ status: 500, body: "" });
    return route.continue();
  });
  await page.getByRole("button", { name: "Delete source only: Gate notes" }).click();
  const d = dialog("Delete source only?");
  await d.getByRole("button", { name: "Delete source only" }).click();
  await expect(d.getByText("That didn't save. Try again.")).toBeVisible();
  await expect(page.getByText("Source deleted.")).toHaveCount(0);
  await page.unrouteAll();
  await d.getByRole("button", { name: "Delete source only" }).click();
  await expect(d).toBeHidden({ timeout: 10_000 });
  expect(await fileExists(s.path)).toBe(false);
});

test("a failed delete moves focus to the error inside the dialog, never <body>", async () => {
  await seedUpload("Focus notes");
  await page.goto("/settings");
  // Held, so the destructive button is disabled (and drops focus) before the failure comes back.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/settings", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await gate;
    return route.fulfill({ status: 500, body: "" });
  });
  await page.getByRole("button", { name: "Delete source only: Focus notes" }).click();
  const d = dialog("Delete source only?");
  await d.getByRole("button", { name: "Delete source only" }).click();
  await expect(d.getByRole("button", { name: "Cancel" })).toBeDisabled();
  release();
  await expect(d.getByText("That didn't save. Try again.")).toBeVisible();
  // The focused element is the wrapper holding the error, inside the open dialog.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const a = document.activeElement;
        return { tag: a?.tagName, inDialog: !!a?.closest("dialog[open]"), hasError: !!a?.textContent?.includes("That didn't save. Try again.") };
      }),
    )
    .toEqual({ tag: "DIV", inDialog: true, hasError: true });
  await page.unrouteAll();
  // Tab from the error reaches the dialog's own controls: focus stays trapped inside it.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("dialog[open]"))).toBe(true);
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toBeHidden();
});

test("rule 10: Escape twice while a delete is in flight keeps the dialog open; the failure shows in it", async () => {
  await seedUpload("Escape notes");
  await page.goto("/settings");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/settings", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await gate;
    return route.fulfill({ status: 500, body: "" });
  });
  await page.getByRole("button", { name: "Delete source only: Escape notes" }).click();
  const d = dialog("Delete source only?");
  await d.getByRole("button", { name: "Delete source only" }).click();
  await expect(d.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await expect(d).toBeVisible();
  release();
  await expect(d.getByText("That didn't save. Try again.")).toBeVisible();
  await page.unrouteAll();
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toBeHidden();
  // The dialog opens again from the same row.
  await page.getByRole("button", { name: "Delete source only: Escape notes" }).click();
  await expect(dialog("Delete source only?")).toBeVisible();
  await dialog("Delete source only?").getByRole("button", { name: "Cancel" }).click();
});

test.describe("Storage down, so the rows go and the file doesn't: Cancel can't return to what's gone", () => {
  const STORAGE = process.env.LE_S11_STORAGE_CONTAINER;
  test.skip(!STORAGE, "set LE_S11_STORAGE_CONTAINER on an isolated stack");
  test.setTimeout(240_000);
  const stop = () => execFileSync("docker", ["stop", "-t", "1", STORAGE!], { encoding: "utf8" });
  const start = async () => {
    execFileSync("docker", ["start", STORAGE!], { encoding: "utf8" });
    await expect.poll(() => admin().storage.from("sources").list("x").then((r) => r.error === null), { timeout: 60_000 }).toBe(true);
  };

  test("Forget: the message says the thread went, and Cancel goes to Threads", async () => {
    const s = await seedUpload("Outage forget cancel");
    await page.goto(`/threads/${s.threadId}`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Forget permanently…" }).click();
    const d = dialog("Forget this thread permanently?");
    await d.getByRole("checkbox", { name: "Also delete source" }).check();
    stop();
    try {
      await d.getByRole("button", { name: "Forget permanently" }).click();
      await expect(d.getByText("This thread was forgotten, but a file hasn't been removed yet.")).toBeVisible({ timeout: 120_000 });
      await d.getByRole("button", { name: "Cancel" }).click();
      await expect(page).toHaveURL(/\/threads$/, { timeout: 15_000 });
    } finally {
      await start();
    }
    expect((await admin().from("threads").select("id").eq("id", s.threadId)).data).toEqual([]);
  });

  test("Delete source: the message says the source went, and Cancel takes its row off the list and keeps the message", async () => {
    await seedUpload("Outage source cancel");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete source only: Outage source cancel" }).click();
    const d = dialog("Delete source only?");
    stop();
    try {
      await d.getByRole("button", { name: "Delete source only" }).click();
      await expect(d.getByText("Your source was deleted, but its file hasn't been removed yet.")).toBeVisible({ timeout: 120_000 });
      await d.getByRole("button", { name: "Cancel" }).click();
      await expect(d).toBeHidden();
      await expect(page.getByRole("button", { name: "Delete source only: Outage source cancel" })).toHaveCount(0);
      await expect(page.getByRole("status").filter({ hasText: "Your source was deleted, but its file hasn't been removed yet." })).toBeVisible();
    } finally {
      await start();
    }
  });
});

test("Export data (JSON): the file arrives first, then the status says so; it holds the user's rows", async () => {
  await page.goto("/settings");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export data (JSON)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^loose-ends-export-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(page.getByRole("status").filter({ hasText: "Your export has downloaded." })).toBeVisible();
  const body = JSON.parse(await readFile((await file.path())!, "utf8")) as { user_id: string; tables: Record<string, Array<{ id?: string }>> };
  expect(body.user_id).toBe(uid);
  expect(body.tables.threads!.map((t) => t.id)).toContain(pasteThreadId);
});

test("Forget permanently: More actions → confirm (no source left, so no Also delete source) → Threads; the thread is gone", async () => {
  await page.goto(`/threads/${pasteThreadId}`);
  const more = page.getByRole("button", { name: "More actions" });
  await more.click();
  // S12: the menu opens on its first item; Forget permanently… is last, after the divider.
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await expect(page.getByRole("menuitem").last()).toHaveText("Forget permanently…");
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole("menuitem", { name: "Forget permanently…" }).click();
  const d = dialog("Forget this thread permanently?");
  await expect(d).toBeVisible();
  // Cancel: nothing forgotten, and focus returns to More actions (the menu item that opened it is gone).
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toBeHidden();
  await expect(more).toBeFocused();
  expect((await admin().from("threads").select("id").eq("id", pasteThreadId)).data).toHaveLength(1);
  await more.click();
  await page.getByRole("menuitem", { name: "Forget permanently…" }).click();
  await expect(d).toBeVisible();
  await expect(d.getByText("A one-way fingerprint, so the same item isn't suggested again")).toBeVisible();
  await expect(d.getByRole("checkbox", { name: "Also delete source" })).toHaveCount(0);
  await axe();
  await d.getByRole("button", { name: "Forget permanently" }).click();
  await expect(page).toHaveURL(/\/threads$/, { timeout: 10_000 });
  expect((await admin().from("threads").select("id").eq("id", pasteThreadId)).data).toEqual([]);
});

test("Forget with Also delete source removes the source and its file too", async () => {
  const s = await seedUpload("Shed notes");
  await page.goto(`/threads/${s.threadId}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Forget permanently…" }).click();
  const d = dialog("Forget this thread permanently?");
  await d.getByRole("checkbox", { name: "Also delete source" }).check();
  await expect(d.getByText(/^The source it came from:/)).toBeVisible();
  await d.getByRole("button", { name: "Forget permanently" }).click();
  await expect(page).toHaveURL(/\/threads$/, { timeout: 10_000 });
  expect((await admin().from("sources").select("id").eq("id", s.sourceId)).data).toEqual([]);
  expect(await fileExists(s.path)).toBe(false);
});

test("375 px: Settings and the dialogs fit, 44 px targets, no horizontal scroll; axe passes", async () => {
  await seedUpload("Mobile notes");
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/settings");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const name of ["Delete source only: Mobile notes", "Delete source and everything from it: Mobile notes", "Export data (JSON)", "Delete account…"]) {
    expect((await page.getByRole("button", { name }).boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
  }
  await axe();
  await page.getByRole("button", { name: "Delete account…" }).click();
  const d = dialog("Delete your account?");
  const box = (await d.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(740);
  for (const name of ["Cancel", "Delete account"]) {
    expect((await d.getByRole("button", { name }).boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
  }
  await axe();
  await d.getByRole("button", { name: "Cancel" }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("Delete account: disabled until `delete` is typed; then every row and file is gone and sign-in says so", async () => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Delete account…" }).click();
  const d = dialog("Delete your account?");
  await expect(d.getByText("Backups held by our hosting platform expire on its own schedule.")).toBeVisible();
  const confirm = d.getByRole("button", { name: "Delete account" });
  await expect(confirm).toBeDisabled();
  await d.getByLabel("Type delete to confirm").fill("delet");
  await expect(confirm).toBeDisabled();
  await d.getByLabel("Type delete to confirm").fill("delete");
  await confirm.click();
  await expect(page).toHaveURL(/\/sign-in$/, { timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: "Your account and your data in Loose Ends were deleted." })).toBeVisible();
  expect((await admin().auth.admin.getUserById(uid)).data.user).toBeNull();
  expect((await admin().from("sources").select("id").eq("user_id", uid)).data).toEqual([]);
  expect((await admin().from("threads").select("id").eq("user_id", uid)).data).toEqual([]);
  expect((await admin().storage.from("sources").list(uid)).data ?? []).toEqual([]);
  // The session is gone: a signed-in page sends the browser to sign-in.
  await page.goto("/today");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("a notice cookie on path / shows once and is cleared too", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "le_account_deleted", value: "1", domain: new URL(baseURL!).hostname, path: "/" }]);
  const p = await ctx.newPage();
  await p.goto("/sign-in");
  await expect(p.getByRole("status").filter({ hasText: "Your account and your data in Loose Ends were deleted." })).toBeVisible();
  expect((await ctx.cookies()).filter((c) => c.name === "le_account_deleted")).toEqual([]);
  await p.reload();
  await expect(p.getByText("Your account and your data in Loose Ends were deleted.")).toHaveCount(0);
  await ctx.close();
});

for (const [value, text] of [
  ["2", "Sign-in records with your email address are still stored and will be removed automatically."],
  ["3", "Some of your files are still stored and will be removed automatically."],
  ["4", "Some of your files and sign-in records with your email address are still stored and will be removed automatically."],
]) {
  test(`when something remains after deletion, the sign-in notice says what, once (cookie ${value})`, async ({ browser, baseURL }) => {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "le_account_deleted", value: value!, domain: new URL(baseURL!).hostname, path: "/sign-in" }]);
    const p = await ctx.newPage();
    await p.goto("/sign-in");
    await expect(p.getByRole("status").filter({ hasText: text! })).toBeVisible();
    await expect(p.getByText("Your account and your data in Loose Ends were deleted.")).toHaveCount(0);
    await p.reload();
    await expect(p.getByText("Your account was deleted.")).toHaveCount(0);
    await ctx.close();
  });
}
