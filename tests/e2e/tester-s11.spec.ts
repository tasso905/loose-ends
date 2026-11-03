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

test.afterAll(async () => {
  for (const s of created) await s.context.close().catch(() => undefined);
  await deleteUsers(created.map((s) => s.email));
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

  // OPEN DEFECT S11-D4 (low): the cookie is never cleared, so the notice repeats for its 120 s lifetime.
  test("the deletion notice shows once: a reload of sign-in no longer claims it", async ({ browser }) => {
    test.fail();
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

const STORAGE = process.env.LE_S11_STORAGE_CONTAINER;
test.describe("a real Storage outage", () => {
  test.skip(!STORAGE, "set LE_S11_STORAGE_CONTAINER on an isolated stack");
  test.setTimeout(600_000);
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
      expect((await admin().auth.admin.getUserById(uid)).data.user).not.toBeNull();
      expect((await admin().from("sources").select("id").eq("id", s.sourceId)).data).toHaveLength(1);
    } finally {
      await start();
    }
    expect(await fileExists(s.path)).toBe(true);
  });

  // OPEN DEFECT S11-D1 (rule 8, rule 10): the retry reaches Threads with no error, but the file stays.
  test("Forget + Also delete source with Storage down reports failure; the retry reaches Threads with the file gone", async ({ browser }) => {
    test.fail();
    const { page, uid } = await signIn(browser);
    const s = await seed(uid, "Outage forget");
    await page.goto(`/threads/${s.threadId}`);
    const d = await openForget(page);
    await d.getByRole("checkbox", { name: "Also delete source" }).check();
    stop();
    try {
      const t0 = Date.now();
      await d.getByRole("button", { name: "Forget permanently" }).click();
      await expect(d.getByText("That didn't save. Try again.")).toBeVisible({ timeout: 280_000 });
      console.log(`outage: forget error after ${Date.now() - t0} ms`);
    } finally {
      await start();
    }
    await d.getByRole("button", { name: "Forget permanently" }).click();
    await expect(page).toHaveURL(/\/threads$/, { timeout: 20_000 });
    expect(await fileExists(s.path)).toBe(false);
  });

  // OPEN DEFECT S11-D2: the retry removes the file, but the dialog stays open with an error.
  test("Delete source with Storage down reports failure; Try again finishes and says so", async ({ browser }) => {
    test.fail();
    const { page, uid } = await signIn(browser);
    const s = await seed(uid, "Outage source");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete source only: Outage source" }).click();
    const d = page.getByRole("dialog", { name: "Delete source only?" });
    stop();
    try {
      const t0 = Date.now();
      await d.getByRole("button", { name: "Delete source only" }).click();
      await expect(d.getByText("That didn't save. Try again.")).toBeVisible({ timeout: 280_000 });
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
});
