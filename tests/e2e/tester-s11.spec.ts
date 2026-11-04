import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester, S11 (F13, F9 Forget, D8, D14; rules 8, 9, 10), independent of the developer's
 * delete-export.spec.ts. Adds: Forget and Delete account dialogs can't close while pending (closedby,
 * Escape twice, backdrop); no undo anywhere; Enter in the typed-word field; the one-time notice;
 * another signed-in browser after account deletion; two users' exports; every dialog under axe at
 * desktop and 375 px with focus return; a real Storage outage (LE_S11_STORAGE_CONTAINER set: the
 * stack's storage container is stopped and restarted, so only set it for an isolated stack).
 * Synthetic text only; recorded LLM fixtures, none used here.
 */

const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};

type Session = { email: string; uid: string; context: BrowserContext; page: Page };
const created: Session[] = [];

async function signIn(browser: Browser, email = testEmail(), options: Parameters<Browser["newContext"]>[0] = {}): Promise<Session> {
  const context = await browser.newContext({ acceptDownloads: true, ...options });
  const page = await context.newPage();
  await page.goto("/sign-in?next=%2Ftoday");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  if (/\/onboarding/.test(page.url())) {
    await page.getByRole("button", { name: "Skip" }).click();
  }
  await expect(page).toHaveURL(/\/today/);
  const uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
  const s = { email, uid, context, page };
  created.push(s);
  return s;
}

/** An uploaded source with its file, one thread with a quote and a decision. */
async function seed(uid: string, title: string) {
  const db = admin();
  const path = `${uid}/${randomUUID()}`;
  const up = await db.storage.from("sources").upload(path, new Blob([`${title}: order cedar posts Monday.`]), { contentType: "text/plain" });
  expect(up.error).toBeNull();
  const text = `${title}: order cedar posts Monday.`;
  const src = await db
    .from("sources")
    .insert({ user_id: uid, kind: "upload", title, text_content: text, storage_path: path, reference_date: "2026-10-20", reference_date_source: "user" })
    .select("id")
    .single();
  expect(src.error).toBeNull();
  const thr = await db.from("threads").insert({ user_id: uid, title: `Thread of ${title}`, kind: "commitment", status: "open", primary_source_id: src.data!.id }).select("id").single();
  expect(thr.error).toBeNull();
  const quote = "order cedar posts Monday";
  const ev = await db.from("evidence").insert({ user_id: uid, source_id: src.data!.id, thread_id: thr.data!.id, quote, start_offset: text.indexOf(quote), end_offset: text.indexOf(quote) + quote.length, match_kind: "exact" });
  expect(ev.error).toBeNull();
  const dec = await db.from("decisions").insert({ user_id: uid, thread_id: thr.data!.id, choice: `Decision of ${title}`, reason_user: "Synthetic reason" });
  expect(dec.error).toBeNull();
  return { sourceId: src.data!.id as string, threadId: thr.data!.id as string, path };
}

const fileExists = async (path: string) => {
  const slash = path.lastIndexOf("/");
  const { data } = await admin().storage.from("sources").list(path.slice(0, slash), { search: path.slice(slash + 1) });
  return (data ?? []).some((o) => o.name === path.slice(slash + 1));
};

async function axe(page: Page, label: string) {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => undefined))),
  );
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}

/** Holds server-action POSTs to `glob` until released. */
async function holdPosts(page: Page, glob: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(glob, async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  return release;
}

const openForget = async (page: Page) => {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Forget permanently…" }).click();
  const d = page.getByRole("dialog", { name: "Forget this thread permanently?" });
  await expect(d).toBeVisible();
  return d;
};

/** After a failed action: focus is inside the open dialog, on the error, never on <body>. */
async function expectFocusOnError(page: Page, dialogName: string) {
  await expect
    .poll(() =>
      page.evaluate((name) => {
        const a = document.activeElement;
        const d = [...document.querySelectorAll("dialog")].find((x) => x.open);
        return {
          body: a === document.body,
          inDialog: !!d && !!a && d.contains(a),
          holdsError: !!a?.textContent?.includes("didn't save") || !!a?.textContent?.includes("offline") || !!a?.textContent?.includes("hasn't been removed"),
          dialog: name,
        };
      }, dialogName),
    )
    .toEqual({ body: false, inDialog: true, holdsError: true, dialog: dialogName });
}

const failPosts = (page: Page, glob: string) => page.route(glob, (route) => (route.request().method() === "POST" ? route.fulfill({ status: 500, body: "" }) : route.continue()));

test.afterAll(async () => {
  for (const s of created) await s.context.close().catch(() => undefined);
  await deleteUsers(created.map((s) => s.email));
});

test.describe("a failed action keeps focus in the dialog (ae9b60f; rule 10)", () => {
  test("failed Forget: focus on the error, twice in a row; no success, nothing deleted; Tab stays in the dialog; a retry works", async ({ browser }) => {
    const { page, uid } = await signIn(browser);
    const s = await seed(uid, "Focus forget");
    await page.goto(`/threads/${s.threadId}`);
    const d = await openForget(page);
    await failPosts(page, "**/threads/*");
    const confirm = d.getByRole("button", { name: "Forget permanently" });
    await confirm.click();
    await expect(d.getByText("That didn't save. Try again.")).toBeVisible();
    await expectFocusOnError(page, "forget");
    expect(page.url()).toContain(s.threadId);
    expect((await admin().from("threads").select("id").eq("id", s.threadId)).data).toHaveLength(1);

    // The same message again must still move focus (the effect depends on the error text).
    await confirm.click();
    await expect(confirm).toBeEnabled();
    await expect(d.getByText("That didn't save. Try again.")).toBeVisible();
    await expectFocusOnError(page, "forget, second failure");

    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.querySelector("dialog[open]")?.contains(document.activeElement))).toBe(true);
    await axe(page, "forget dialog with the error");

    await page.unrouteAll();
    await confirm.click();
    await expect(page).toHaveURL(/\/threads$/, { timeout: 15_000 });
    expect((await admin().from("threads").select("id").eq("id", s.threadId)).data).toEqual([]);
  });

  test("failed Delete account: focus on the error, twice in a row; no success or notice; the account stays; the typed word stays", async ({ browser }) => {
    const { page, uid } = await signIn(browser);
    await seed(uid, "Focus account");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete account…" }).click();
    const d = page.getByRole("dialog", { name: "Delete your account?" });
    await d.getByLabel("Type delete to confirm").fill("delete");
    await failPosts(page, "**/settings");
    const confirm = d.getByRole("button", { name: "Delete account" });
    await confirm.click();
    await expect(d.getByText("That didn't save. Try again.")).toBeVisible();
    await expectFocusOnError(page, "account");
    await expect(page.getByText("Your account and everything in it were deleted.")).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings$/);
    expect((await admin().auth.admin.getUserById(uid)).data.user).not.toBeNull();
    await expect(d.getByLabel("Type delete to confirm")).toHaveValue("delete");

    await confirm.click();
    await expect(confirm).toBeEnabled();
    await expectFocusOnError(page, "account, second failure");
    await axe(page, "account dialog with the error");

    await page.unrouteAll();
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await expect(page.getByRole("button", { name: "Delete account…" })).toBeFocused();
    expect((await admin().auth.admin.getUserById(uid)).data.user).not.toBeNull();
  });

  test("375 px: failed Forget and failed Delete account keep focus on the error, and the error is on screen", async ({ browser }) => {
    const { page, uid } = await signIn(browser, undefined, { viewport: { width: 375, height: 740 } });
    const s = await seed(uid, "Focus mobile");
    await page.goto(`/threads/${s.threadId}`);
    const f = await openForget(page);
    await failPosts(page, "**/threads/*");
    await f.getByRole("button", { name: "Forget permanently" }).click();
    await expect(f.getByText("That didn't save. Try again.")).toBeInViewport();
    await expectFocusOnError(page, "forget 375");
    await page.unrouteAll();

    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete account…" }).click();
    const d = page.getByRole("dialog", { name: "Delete your account?" });
    await d.getByLabel("Type delete to confirm").fill("delete");
    await failPosts(page, "**/settings");
    await d.getByRole("button", { name: "Delete account" }).click();
    await expect(d.getByText("That didn't save. Try again.")).toBeInViewport();
    await expectFocusOnError(page, "account 375");
    await page.unrouteAll();
  });
});

test.describe("Forget permanently", () => {
  test("pending: closedby none, Escape twice and the backdrop don't close it; afterwards thread, quote and decision are gone, no Undo", async ({ browser }) => {
    const { page, uid } = await signIn(browser);
    const s = await seed(uid, "Pending notes");
    await page.goto("/decisions");
    await expect(page.getByText("Decision of Pending notes")).toBeVisible();
    await page.goto(`/threads/${s.threadId}`);

    const d = await openForget(page);
    await expect(d.locator("xpath=self::dialog")).toHaveAttribute("closedby", "closerequest");
    await expect(d.getByText("You can't undo this.")).toBeVisible();
    await expect(d.getByRole("checkbox", { name: "Also delete source" })).not.toBeChecked();

    const release = await holdPosts(page, "**/threads/*");
    await d.getByRole("button", { name: "Forget permanently" }).click();
    await expect(d.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(d.locator("xpath=self::dialog")).toHaveAttribute("closedby", "none");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.mouse.click(3, 3);
    await page.waitForTimeout(300);
    await expect(d).toBeVisible();
    expect(await d.evaluate((el) => (el as HTMLDialogElement).open)).toBe(true);
    expect(page.url()).toContain(s.threadId);

    release();
    await expect(page).toHaveURL(/\/threads$/, { timeout: 15_000 });
    await page.unrouteAll();
    await expect(page.getByRole("button", { name: /^Undo/ })).toHaveCount(0);
    await expect(page.getByText("Thread of Pending notes")).toHaveCount(0);

    const db = admin();
    expect((await db.from("threads").select("id").eq("id", s.threadId)).data).toEqual([]);
    expect((await db.from("evidence").select("id").eq("thread_id", s.threadId)).data).toEqual([]);
    expect((await db.from("thread_events").select("id").eq("thread_id", s.threadId)).data).toEqual([]);
    expect((await db.from("decisions").select("id").eq("thread_id", s.threadId)).data).toEqual([]);
    expect(await fileExists(s.path)).toBe(true);

    const res = await page.goto(`/threads/${s.threadId}`);
    expect(res?.status()).toBe(404);
    await page.goto("/decisions");
    await expect(page.getByText("Decision of Pending notes")).toHaveCount(0);
    await page.goto("/today");
    await expect(page.getByText("Thread of Pending notes")).toHaveCount(0);
  });

  test("keyboard only: menu, Tab to the checkbox, Enter on Cancel deletes nothing, Escape returns focus; a server failure stays in the dialog", async ({ browser }) => {
    const { page, uid } = await signIn(browser);
    const s = await seed(uid, "Keyboard notes");
    await page.goto(`/threads/${s.threadId}`);
    const more = page.getByRole("button", { name: "More actions" });
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Forget permanently…" })).toBeFocused();
    await page.keyboard.press("Enter");
    const d = page.getByRole("dialog", { name: "Forget this thread permanently?" });
    await expect(d.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(d).toBeHidden();
    await expect(more).toBeFocused();
    expect((await admin().from("threads").select("id").eq("id", s.threadId)).data).toHaveLength(1);

    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(d).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
    await expect(more).toBeFocused();

    await page.route("**/threads/*", (route) => (route.request().method() === "POST" ? route.fulfill({ status: 500, body: "" }) : route.continue()));
    const again = await openForget(page);
    await again.getByRole("button", { name: "Forget permanently" }).click();
    await expect(again.getByText("That didn't save. Try again.")).toBeVisible();
    await page.unrouteAll();
    await page.keyboard.press("Escape");
    await expect(again).toBeHidden();
    expect((await admin().from("threads").select("id").eq("id", s.threadId)).data).toHaveLength(1);
  });

  test("another user's thread is a 404 with no actions", async ({ browser }) => {
    const A = await signIn(browser);
    const B = await signIn(browser);
    const s = await seed(A.uid, "Private notes");
    const res = await B.page.goto(`/threads/${s.threadId}`);
    expect(res?.status()).toBe(404);
    await expect(B.page.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await expect(B.page.getByText("Thread of Private notes")).toHaveCount(0);
  });
});

test.describe("Settings → Data", () => {
  test("source lists and exports stay per-user: B sees and downloads none of A's rows", async ({ browser }) => {
    const A = await signIn(browser);
    const B = await signIn(browser);
    const sa = await seed(A.uid, "Alpha notes");
    await seed(B.uid, "Bravo notes");
    await B.page.goto("/settings");
    await expect(B.page.getByText("Bravo notes", { exact: true })).toBeVisible();
    await expect(B.page.getByText("Alpha notes", { exact: true })).toHaveCount(0);

    const dl = B.page.waitForEvent("download");
    await B.page.getByRole("button", { name: "Export data (JSON)" }).click();
    const text = await readFile((await (await dl).path())!, "utf8");
    const body = JSON.parse(text) as { user_id: string; tables: Record<string, unknown[]> };
    expect(body.user_id).toBe(B.uid);
    expect(Object.keys(body.tables).sort()).toEqual(
      ["decisions", "evidence", "extraction_items", "extractions", "profiles", "sources", "suppressions", "thread_events", "threads", "usage_counters", "user_settings"].sort(),
    );
    expect(text).toContain("Bravo notes");
    expect(text).not.toContain("Alpha notes");
    expect(text).not.toContain(A.uid);
    expect(text).not.toContain(A.email);
    expect(text).not.toContain(sa.sourceId);
  });

  test("export failure shows the error, no success; signed-out API is 401", async ({ browser }) => {
    const { page } = await signIn(browser);
    await page.goto("/settings");
    await page.route("**/api/export", (route) => route.fulfill({ status: 500, body: "{}" }));
    await page.getByRole("button", { name: "Export data (JSON)" }).click();
    await expect(page.getByText("I couldn't prepare your export. Try again.")).toBeVisible();
    await expect(page.getByText("Your export has downloaded.")).toHaveCount(0);
    await page.unrouteAll();
    const anon = await browser.newContext();
    const res = await anon.request.get("/api/export");
    expect(res.status()).toBe(401);
    await anon.close();
  });

  test("the two delete dialogs state what goes and what stays; no Undo after either", async ({ browser }) => {
    const { page, uid } = await signIn(browser);
    const a = await seed(uid, "Only notes");
    await seed(uid, "All notes");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete source only: Only notes" }).click();
    let d = page.getByRole("dialog", { name: "Delete source only?" });
    await expect(d.getByText("Threads you accepted from it, with their quotes.", { exact: false })).toBeVisible();
    await d.getByRole("button", { name: "Delete source only" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Source deleted." })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Undo/ })).toHaveCount(0);
    expect(await fileExists(a.path)).toBe(false);

    await page.getByRole("button", { name: "Delete source and everything from it: All notes" }).click();
    d = page.getByRole("dialog", { name: "Delete source and everything from it?" });
    await expect(d.getByText("A one-way fingerprint of each thread", { exact: false })).toBeVisible();
    await d.getByRole("button", { name: "Delete source and everything from it" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Source and 1 thread deleted." })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Undo/ })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("You haven't added anything yet.")).toBeVisible();
  });

  for (const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "375 px", width: 375, height: 740 },
  ]) {
    test(`axe, focus return and targets on every dialog at ${viewport.name}`, async ({ browser }) => {
      const { page, uid } = await signIn(browser, undefined, { viewport: { width: viewport.width, height: viewport.height } });
      const s = await seed(uid, "Axe notes");
      const small = viewport.width < 768;
      const checkTargets = async (scope: ReturnType<Page["getByRole"]>, names: string[]) => {
        if (!small) return;
        for (const name of names) expect((await scope.getByRole("button", { name }).boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
      };

      await page.goto("/settings");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "settings overflow").toBe(true);
      await axe(page, "settings");
      for (const [trigger, title, confirm] of [
        ["Delete source only: Axe notes", "Delete source only?", "Delete source only"],
        ["Delete source and everything from it: Axe notes", "Delete source and everything from it?", "Delete source and everything from it"],
        ["Delete account…", "Delete your account?", "Delete account"],
      ] as const) {
        const t = page.getByRole("button", { name: trigger });
        await t.click();
        const d = page.getByRole("dialog", { name: title });
        await expect(d).toBeVisible();
        await axe(page, title);
        await checkTargets(d, ["Cancel", confirm]);
        await page.keyboard.press("Escape");
        await expect(d).toBeHidden();
        await expect(t).toBeFocused();
      }

      await page.goto(`/threads/${s.threadId}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "thread overflow").toBe(true);
      await axe(page, "thread detail");
      const more = page.getByRole("button", { name: "More actions" });
      if (small) expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await more.click();
      const item = page.getByRole("menuitem", { name: "Forget permanently…" });
      if (small) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await axe(page, "menu open");
      await item.click();
      const f = page.getByRole("dialog", { name: "Forget this thread permanently?" });
      await expect(f).toBeVisible();
      await f.getByRole("checkbox", { name: "Also delete source" }).check();
      await axe(page, "forget dialog");
      await checkTargets(f, ["Cancel", "Forget permanently"]);
      if (small) {
        const label = f.locator("label").filter({ hasText: "Also delete source" });
        expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await page.keyboard.press("Escape");
      await expect(f).toBeHidden();
      await expect(more).toBeFocused();

      await page.goto("/today");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "today overflow").toBe(true);
      await axe(page, "today with the Settings link");
    });
  }
});

test.describe("Delete account", () => {
  test("Enter with a wrong word does nothing; pending can't close; everything goes; the other browser is signed out; a link can't produce the notice", async ({ browser }) => {
    const A = await signIn(browser);
    const { page, uid, email } = A;
    const s = await seed(uid, "Account notes");
    const second = await browser.newContext();
    const other = await second.newPage();
    await other.goto("/sign-in?next=%2Ftoday");
    const since = await requestLink(other, email);
    await other.goto(await magicLinkFor(email, since));
    await expect(other).toHaveURL(/\/today/);

    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete account…" }).click();
    const d = page.getByRole("dialog", { name: "Delete your account?" });
    await expect(d.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(d.getByText("Backups held by our hosting platform expire on its own schedule.")).toBeVisible();
    const field = d.getByLabel("Type delete to confirm");
    await field.fill("delet");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await expect(d).toBeVisible();
    expect((await admin().auth.admin.getUserById(uid)).data.user).not.toBeNull();

    await field.fill("delete");
    const release = await holdPosts(page, "**/settings");
    await page.keyboard.press("Enter");
    await expect(d.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(d.locator("xpath=self::dialog")).toHaveAttribute("closedby", "none");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await expect(d).toBeVisible();
    await expect(page.getByText("Your account and everything in it were deleted.")).toHaveCount(0);
    release();
    await expect(page).toHaveURL(/\/sign-in$/, { timeout: 20_000 });
    await page.unrouteAll();
    await expect(page.getByRole("status").filter({ hasText: "Your account and everything in it were deleted." })).toBeVisible();

    expect((await admin().auth.admin.getUserById(uid)).data.user).toBeNull();
    expect((await admin().from("profiles").select("id").eq("id", uid)).data).toEqual([]);
    expect(await fileExists(s.path)).toBe(false);

    await page.goto("/today");
    await expect(page).toHaveURL(/\/sign-in/);
    await other.goto("/today");
    await expect(other).toHaveURL(/\/sign-in/);
    await second.close();

    // A fresh browser, or a link, can't produce the claim (rule 10).
    const fresh = await browser.newContext();
    const fp = await fresh.newPage();
    await fp.goto("/sign-in?deleted=1&account_deleted=1");
    await expect(fp.getByText("Your account and everything in it were deleted.")).toHaveCount(0);
    await fresh.close();
  });

  // FIXED S11-D4 (low): the proxy clears the cookie on the document load that shows the notice.
  test("the deletion notice shows once: a reload of sign-in no longer claims it", async ({ browser }) => {
    const { page } = await signIn(browser);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete account…" }).click();
    const d = page.getByRole("dialog", { name: "Delete your account?" });
    await d.getByLabel("Type delete to confirm").fill("delete");
    await d.getByRole("button", { name: "Delete account" }).click();
    await expect(page).toHaveURL(/\/sign-in$/, { timeout: 20_000 });
    await expect(page.getByText("Your account and everything in it were deleted.")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Your account and everything in it were deleted.")).toHaveCount(0);
  });
});

const CRON_SECRET = process.env.CRON_SECRET;
const DB = process.env.LE_S11_DB_CONTAINER;
const psql = (sql: string) => execFileSync("docker", ["exec", DB!, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql], { encoding: "utf8" }).trim();

test.describe("cron over HTTP, through the proxy", () => {
  test.skip(!CRON_SECRET, "start the server with CRON_SECRET set");
  test("no credential or a wrong one is a JSON 401, never a redirect to sign-in; the right one answers counts", async ({ browser }) => {
    const ctx = await browser.newContext();
    const attempts: Array<Record<string, string>> = [{}, { authorization: "Bearer wrong" }, { authorization: "" }];
    for (const headers of attempts) {
      for (const res of [await ctx.request.get("/api/cron/daily", { headers, maxRedirects: 0 }), await ctx.request.post("/api/cron/daily", { headers, maxRedirects: 0 })]) {
        expect(res.status()).toBe(401);
        expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue.", retryable: false } });
      }
    }
    const res = await ctx.request.get("/api/cron/daily", { headers: { authorization: `Bearer ${CRON_SECRET}` }, maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, files_remaining: 0, audit_pending: 0, accounts_pending: 0 });
    await ctx.close();
  });

  test("a signed-in user's cookies are not a cron credential", async ({ browser }) => {
    const { context } = await signIn(browser);
    expect((await context.request.get("/api/cron/daily", { maxRedirects: 0 })).status()).toBe(401);
    expect((await context.request.post("/api/cron/daily", { maxRedirects: 0 })).status()).toBe(401);
  });
});

test.describe("the deletion notice", () => {
  const NOTICES = {
    "1": "Your account and everything in it were deleted.",
    "2": "Your account was deleted. Sign-in records with your email address are still stored and will be removed automatically.",
    "3": "Your account was deleted. Some of your files are still stored and will be removed automatically.",
    "4": "Your account was deleted. Some of your files and sign-in records with your email address are still stored and will be removed automatically.",
  } as const;
  const cookie = (value: string) => ({ name: "le_account_deleted", value, domain: "127.0.0.1", path: "/sign-in", httpOnly: true, sameSite: "Lax" as const });

  for (const [value, text] of Object.entries(NOTICES)) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 740 }]) {
      test(`value ${value} at ${viewport.width} px: its own text once, axe clean, gone on reload, cookie cleared`, async ({ browser }) => {
        const ctx = await browser.newContext({ viewport });
        const page = await ctx.newPage();
        await ctx.addCookies([cookie(value)]);
        await page.goto("/sign-in");
        await expect(page.getByRole("status").filter({ hasText: text })).toBeVisible();
        for (const [other, otherText] of Object.entries(NOTICES)) if (other !== value) await expect(page.getByText(otherText, { exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await axe(page, `notice ${value}`);
        expect((await ctx.cookies()).filter((c) => c.name === "le_account_deleted")).toEqual([]);
        await page.reload();
        await expect(page.getByText(text, { exact: true })).toHaveCount(0);
        await ctx.close();
      });
    }
  }

  test("a cookie on `/` and on /sign-in: shown once, both cleared, on a production response", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await ctx.addCookies([{ ...cookie("1"), path: "/" }, cookie("1")]);
    const res = await page.goto("/sign-in");
    await expect(page.getByRole("status").filter({ hasText: NOTICES["1"] })).toBeVisible();
    const setCookie = (await res!.headerValue("set-cookie")) ?? "";
    expect(setCookie).toMatch(/le_account_deleted=;[^\n]*Path=\/sign-in/i);
    expect(setCookie).toMatch(/le_account_deleted=;[^\n]*Path=\/(;|\s|$)/im);
    expect((await ctx.cookies()).filter((c) => c.name === "le_account_deleted")).toEqual([]);
    await page.reload();
    await expect(page.getByText(NOTICES["1"], { exact: true })).toHaveCount(0);
    await ctx.close();
  });

  test("a cookie on `/` alone: shown once and cleared", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await ctx.addCookies([{ ...cookie("3"), path: "/" }]);
    await page.goto("/sign-in");
    await expect(page.getByRole("status").filter({ hasText: NOTICES["3"] })).toBeVisible();
    expect((await ctx.cookies()).filter((c) => c.name === "le_account_deleted")).toEqual([]);
    await page.reload();
    await expect(page.getByText(NOTICES["3"], { exact: true })).toHaveCount(0);
    await ctx.close();
  });

  test("anything else shows nothing and isn't reflected; a client header or a link can't produce it", async ({ browser }) => {
    for (const value of ["0", "5", "11", "true", "%3Cscript%3Ealert(1)%3C/script%3E", ""]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await ctx.addCookies([cookie(value)]);
      await page.goto("/sign-in");
      await expect(page.getByText("Your account", { exact: false })).toHaveCount(0);
      expect(await page.content()).not.toContain("alert(1)");
      await ctx.close();
    }
    const forged = await browser.newContext({ extraHTTPHeaders: { "x-le-account-deleted": "1" } });
    const fp = await forged.newPage();
    await fp.goto("/sign-in?account_deleted=1&x-le-account-deleted=1&notice=1");
    await expect(fp.getByText("Your account", { exact: false })).toHaveCount(0);
    await forged.close();
  });

  test("a prefetch or client-side request doesn't use it up", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await ctx.addCookies([cookie("1")]);
    const rsc = await ctx.request.get("/sign-in", { headers: { accept: "*/*", rsc: "1", "next-router-prefetch": "1" } });
    expect(rsc.ok()).toBe(true);
    expect(await rsc.text()).not.toContain(NOTICES["1"]);
    await page.goto("/sign-in");
    await expect(page.getByRole("status").filter({ hasText: NOTICES["1"] })).toBeVisible();
    await ctx.close();
  });

  test("a signed-in user with the cookie goes to the app without the claim", async ({ browser }) => {
    const { context, page } = await signIn(browser);
    await context.addCookies([cookie("1")]);
    await page.goto("/sign-in");
    await expect(page).toHaveURL(/\/today/);
    await expect(page.getByText(NOTICES["1"], { exact: true })).toHaveCount(0);
  });

  test("real deletion through the UI with a magic link: nothing with the id or email in any auth table; notice 1", async ({ browser }) => {
    test.skip(!DB, "set LE_S11_DB_CONTAINER");
    const { page, uid, email } = await signIn(browser);
    await seed(uid, "Audit notes");
    expect(Number(psql(`select count(*) from auth.audit_log_entries where payload::text ilike '%${email}%'`))).toBeGreaterThan(0);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete account…" }).click();
    const d = page.getByRole("dialog", { name: "Delete your account?" });
    await d.getByLabel("Type delete to confirm").fill("delete");
    await d.getByRole("button", { name: "Delete account" }).click();
    await expect(page).toHaveURL(/\/sign-in$/, { timeout: 20_000 });
    await expect(page.getByRole("status").filter({ hasText: NOTICES["1"] })).toBeVisible();
    await page.goto("/today");
    await expect(page).toHaveURL(/\/sign-in/);
    const dump = execFileSync("docker", ["exec", DB!, "pg_dump", "-U", "postgres", "-d", "postgres", "--data-only", "--inserts", "-n", "public", "-n", "private", "-n", "storage", "-n", "auth"], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
    expect(dump.split("\n").filter((l) => l.includes(uid)).map((l) => l.slice(0, 120))).toEqual([]);
    expect(dump.split("\n").filter((l) => l.toLowerCase().includes(email.toLowerCase())).map((l) => l.slice(0, 120))).toEqual([]);
  });
});

const STORAGE = process.env.LE_S11_STORAGE_CONTAINER;
test.describe("a real Storage outage", () => {
  test.skip(!STORAGE, "set LE_S11_STORAGE_CONTAINER on an isolated stack");
  test.setTimeout(300_000);
  const stop = () => execFileSync("docker", ["stop", "-t", "1", STORAGE!], { encoding: "utf8" });
  const start = async () => {
    execFileSync("docker", ["start", STORAGE!], { encoding: "utf8" });
    await expect
      .poll(() => admin().storage.from("sources").list("x").then((r) => r.error === null), { timeout: 60_000 })
      .toBe(true);
  };

  test("Delete account with Storage down deletes nothing and reports the failure", async ({ browser }) => {
    const { page, uid } = await signIn(browser);
    const s = await seed(uid, "Outage account");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete account…" }).click();
    const d = page.getByRole("dialog", { name: "Delete your account?" });
    await d.getByLabel("Type delete to confirm").fill("delete");
    stop();
    try {
      const t0 = Date.now();
      await d.getByRole("button", { name: "Delete account" }).click();
      await expect(d.getByText("That didn't save. Try again.")).toBeVisible({ timeout: 280_000 });
      console.log(`outage: account delete error after ${Date.now() - t0} ms`);
      await expectFocusOnError(page, "account outage");
      await expect(page.getByText("Your account and everything in it were deleted.")).toHaveCount(0);
      expect((await admin().auth.admin.getUserById(uid)).data.user).not.toBeNull();
      expect((await admin().from("sources").select("id").eq("id", s.sourceId)).data).toHaveLength(1);
    } finally {
      await start();
    }
    expect(await fileExists(s.path)).toBe(true);
  });

  test("Forget + Also delete source with Storage down: the real failure lands focus on the error and claims nothing", async ({ browser }) => {
    const { page, uid } = await signIn(browser);
    const s = await seed(uid, "Outage focus");
    await page.goto(`/threads/${s.threadId}`);
    const d = await openForget(page);
    await d.getByRole("checkbox", { name: "Also delete source" }).check();
    stop();
    try {
      await d.getByRole("button", { name: "Forget permanently" }).click();
      await expect(d.getByText("This thread was forgotten, but a file hasn't been removed yet.")).toBeVisible({ timeout: 280_000 });
      await expectFocusOnError(page, "forget outage");
      expect(page.url()).toContain(s.threadId);
    } finally {
      await start();
    }
  });

  // FIXED S11-D1 (rule 8, rule 10): the retry now finishes the queue before it answers not_found.
  test("Forget + Also delete source with Storage down reports failure; the retry reaches Threads with the file gone", async ({ browser }) => {
    const { page, uid } = await signIn(browser);
    const s = await seed(uid, "Outage forget");
    await page.goto(`/threads/${s.threadId}`);
    const d = await openForget(page);
    await d.getByRole("checkbox", { name: "Also delete source" }).check();
    stop();
    try {
      const t0 = Date.now();
      await d.getByRole("button", { name: "Forget permanently" }).click();
      await expect(d.getByText("This thread was forgotten, but a file hasn't been removed yet.")).toBeVisible({ timeout: 280_000 });
      console.log(`outage: forget error after ${Date.now() - t0} ms`);
    } finally {
      await start();
    }
    await d.getByRole("button", { name: "Forget permanently" }).click();
    await expect(page).toHaveURL(/\/threads$/, { timeout: 20_000 });
    expect(await fileExists(s.path)).toBe(false);
  });

  // FIXED S11-D2: SourcesList treats not_found as gone.
  test("Delete source with Storage down reports failure; Try again finishes and says so", async ({ browser }) => {
    const { page, uid } = await signIn(browser);
    const s = await seed(uid, "Outage source");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete source only: Outage source" }).click();
    const d = page.getByRole("dialog", { name: "Delete source only?" });
    stop();
    try {
      const t0 = Date.now();
      await d.getByRole("button", { name: "Delete source only" }).click();
      await expect(d.getByText("Your source was deleted, but its file hasn't been removed yet.")).toBeVisible({ timeout: 280_000 });
      console.log(`outage: source delete error after ${Date.now() - t0} ms`);
      await expect(page.getByText("Source deleted.")).toHaveCount(0);
    } finally {
      await start();
    }
    await d.getByRole("button", { name: "Delete source only" }).click();
    await expect.poll(() => fileExists(s.path), { timeout: 15_000 }).toBe(false);
    await expect(d).toBeHidden({ timeout: 10_000 });
    await expect(page.getByRole("status").filter({ hasText: "Source deleted." })).toBeVisible();
  });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 740 }]) {
    test(`rows gone, file stuck, at ${viewport.width} px (Source): truthful message, focus on it, axe, inside the time limit; Cancel can't relist it; cron finishes`, async ({ browser }) => {
      test.skip(!CRON_SECRET, "start the server with CRON_SECRET set");
      const { page, uid, context } = await signIn(browser, undefined, { viewport });
      const s = await seed(uid, "Stuck source");
      await page.goto("/settings");
      await page.getByRole("button", { name: "Delete source only: Stuck source" }).click();
      const d = page.getByRole("dialog", { name: "Delete source only?" });
      stop();
      try {
        const t0 = Date.now();
        await d.getByRole("button", { name: "Delete source only" }).click();
        const msg = d.getByText("Your source was deleted, but its file hasn't been removed yet.");
        await expect(msg).toBeVisible({ timeout: 40_000 });
        console.log(`outage ${viewport.width}: source message after ${Date.now() - t0} ms`);
        await expect(msg).toBeInViewport();
        await expectFocusOnError(page, "stuck source");
        await expect(d.getByText("That didn't save")).toHaveCount(0);
        await expect(page.getByText("Source deleted.", { exact: true })).toHaveCount(0);
        await axe(page, "source dialog, rows gone");
        await d.getByRole("button", { name: "Cancel" }).click();
        await expect(d).toBeHidden();
        await expect(page.getByRole("heading", { level: 3, name: "Your sources" })).toBeFocused();
        await expect(page.getByRole("status").filter({ hasText: "its file hasn't been removed yet" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Delete source only: Stuck source" })).toHaveCount(0);
        await axe(page, "settings after Cancel, rows gone");
        await page.reload();
        await expect(page.getByText("Stuck source", { exact: true })).toHaveCount(0);
      } finally {
        await start();
      }
      // Not asserted that the file is still there here: a remove the gateway held during the outage may
      // complete when Storage returns. Either way, after cron nothing may be left.
      const res = await context.request.get("/api/cron/daily", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, files_remaining: 0 });
      expect(await fileExists(s.path)).toBe(false);
    });

    test(`rows gone, file stuck, at ${viewport.width} px (Forget): truthful message, focus, axe; a second failure keeps focus; Cancel goes to Threads, never <body> on a dead page; cron finishes`, async ({ browser }) => {
      test.skip(!CRON_SECRET, "start the server with CRON_SECRET set");
      const { page, uid, context } = await signIn(browser, undefined, { viewport });
      const s = await seed(uid, "Stuck forget");
      await page.goto(`/threads/${s.threadId}`);
      const d = await openForget(page);
      await d.getByRole("checkbox", { name: "Also delete source" }).check();
      const confirm = d.getByRole("button", { name: "Forget permanently" });
      stop();
      try {
        const t0 = Date.now();
        await confirm.click();
        const msg = d.getByText("This thread was forgotten, but a file hasn't been removed yet.");
        await expect(msg).toBeVisible({ timeout: 40_000 });
        console.log(`outage ${viewport.width}: forget message after ${Date.now() - t0} ms`);
        await expect(msg).toBeInViewport();
        await expectFocusOnError(page, "stuck forget");
        await axe(page, "forget dialog, rows gone");

        await confirm.click();
        await expect(confirm).toBeEnabled({ timeout: 40_000 });
        await expect(msg).toBeVisible();
        await expectFocusOnError(page, "stuck forget, retry failed");

        await page.keyboard.press("Escape");
        await expect(page).toHaveURL(/\/threads$/, { timeout: 15_000 });
        await expect(page.getByText("Thread of Stuck forget")).toHaveCount(0);
      } finally {
        await start();
      }
      // Not asserted that the file is still there here: a remove the gateway held during the outage may
      // complete when Storage returns. Either way, after cron nothing may be left.
      const res = await context.request.get("/api/cron/daily", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, files_remaining: 0 });
      expect(await fileExists(s.path)).toBe(false);
    });
  }

  test("Delete account with Storage down at 375 px: focus on the error; the user keeps using the account; its files survive cron; a retry then succeeds", async ({ browser }) => {
    test.skip(!CRON_SECRET, "start the server with CRON_SECRET set");
    const { page, uid, context } = await signIn(browser, undefined, { viewport: { width: 375, height: 740 } });
    const s = await seed(uid, "Survivor notes");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete account…" }).click();
    const d = page.getByRole("dialog", { name: "Delete your account?" });
    await d.getByLabel("Type delete to confirm").fill("delete");
    const confirm = d.getByRole("button", { name: "Delete account" });
    stop();
    try {
      const t0 = Date.now();
      await confirm.click();
      await expect(d.getByText("That didn't save. Try again.")).toBeVisible({ timeout: 40_000 });
      console.log(`outage 375: account error after ${Date.now() - t0} ms`);
      await expectFocusOnError(page, "account outage 375");
      await axe(page, "account dialog, Storage down");
    } finally {
      await start();
    }
    expect((await context.request.get("/api/cron/daily", { headers: { authorization: `Bearer ${CRON_SECRET}` } })).status()).toBe(200);
    expect(await fileExists(s.path)).toBe(true);
    await page.goto(`/threads/${s.threadId}`);
    await expect(page.getByRole("heading", { name: "Thread of Survivor notes" })).toBeVisible();
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete account…" }).click();
    await d.getByLabel("Type delete to confirm").fill("delete");
    await confirm.click();
    await expect(page).toHaveURL(/\/sign-in$/, { timeout: 20_000 });
    await expect(page.getByRole("status").filter({ hasText: "Your account and everything in it were deleted." })).toBeVisible();
    expect(await fileExists(s.path)).toBe(false);
  });
});

const AUTH = process.env.LE_S11_AUTH_CONTAINER;
test.describe("the unconfirmed message, against a really stopped Auth", () => {
  test.skip(!AUTH, "set LE_S11_AUTH_CONTAINER on an isolated stack");
  test.setTimeout(300_000);

  // OPEN DEFECT S11-D7 (rule 10): accountDeleteUnconfirmed says "Reload this page. If you're signed out, it
  // was". That message appears when Auth isn't answering, and with Auth still down the reload lands a live
  // account on sign-in, so the user concludes it was deleted when it wasn't.
  test("Auth still down: reloading does not sign a live account out", async ({ browser }) => {
    test.fail();
    const { page, uid } = await signIn(browser);
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 2, name: "Data" })).toBeVisible();
    execFileSync("docker", ["stop", "-t", "1", AUTH!], { encoding: "utf8" });
    let url = "";
    try {
      await page.reload({ timeout: 120_000 }).catch(() => undefined);
      url = page.url();
    } finally {
      execFileSync("docker", ["start", AUTH!], { encoding: "utf8" });
      await expect.poll(() => admin().auth.admin.listUsers({ perPage: 1 }).then((r) => r.error === null), { timeout: 90_000 }).toBe(true);
    }
    console.log(`reload with Auth down landed on ${url}`);
    expect((await admin().auth.admin.getUserById(uid)).data.user).not.toBeNull();
    expect(url).not.toMatch(/\/sign-in/);
  });
});
