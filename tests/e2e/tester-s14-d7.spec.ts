import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester S14 D7: A's quick-add page is still open in tab 1 when B signs in from tab 2 of the same
 * browser. Whatever the old tab does, nothing of A's reaches B's rows, counts or the model, and B is
 * not shown A's text afterwards, also through Back and Forward. Recorded model only.
 */
const PLUMBER = "Call the plumber about the leaking tap";
const MIXED = "Call the bank about the card, and maybe book a dentist visit";
const TWO = "Water the ferns and email the landlord about the boiler";
const FERNS = "Water the ferns";
const UNKNOWN = "I can't tell if this line was added. Try again: it won't be added twice.";
const DB = process.env.LE_S11_DB_CONTAINER ?? "";
const isolated = DB !== "" && DB !== "supabase_db_loose-ends";
const sql = (q: string) => execFileSync("docker", ["exec", DB, "psql", "-U", "postgres", "-d", "postgres", "-tAc", q]).toString().trim();

const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};
async function signIn(p: Page, address: string) {
  await p.goto("/sign-in?next=%2Fadd%3Fmode%3Dquick");
  const since = await requestLink(p, address);
  await p.goto(await magicLinkFor(address, since));
  await p.getByRole("button", { name: "Skip" }).click();
  await expect(p).toHaveURL(/\/add\?mode=quick$/);
}
const idOf = async (address: string) => (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === address)!.id;
const TABLES = ["sources", "extractions", "extraction_items", "threads", "thread_events", "evidence", "decisions", "suppressions", "usage_counters"];
/** Every row of the user, in full: an update is seen too. */
async function rows(u: string) {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) {
    const { data, error } = await admin().from(t).select("*").eq("user_id", u);
    if (error) throw new Error(`${t}: ${error.message}`);
    out[t] = data!.map((r) => JSON.stringify(r)).sort();
  }
  if (isolated) out.submissions = sql(`select count(*) from private.quick_add_submissions where user_id = '${u}'`);
  return out;
}
const NOTHING = { ...Object.fromEntries(TABLES.map((t) => [t, []])), ...(isolated ? { submissions: "0" } : {}) };

let c: BrowserContext;
let p: Page;
let own: Browser | null = null;
let eA = "";
let eB = "";
let a = "";
// LE_D7_BFCACHE=1: a browser with the back/forward cache on, which Playwright turns off.
const BFCACHE = process.env.LE_D7_BFCACHE === "1";
test.beforeEach(async ({ browser, baseURL }) => {
  [eA, eB] = [testEmail(), testEmail()];
  if (BFCACHE) own = await chromium.launch({ ignoreDefaultArgs: ["--disable-back-forward-cache"] });
  c = await (own ?? browser).newContext({ baseURL });
  p = await c.newPage();
  await signIn(p, eA);
  a = await idOf(eA);
});
test.afterEach(async () => {
  await c?.close();
  await own?.close();
  own = null;
  await deleteUsers([eA, eB]);
});

const field = () => p.getByRole("textbox", { name: "Quick add" });
const addButton = () => p.getByRole("button", { name: "Add", exact: true });
const unknown = () => p.getByRole("alert").filter({ hasText: UNKNOWN });
const added = (t: string) => p.getByRole("status").filter({ hasText: `Added "${t}"` });
async function fill(text: string) {
  await field().fill(text);
  await expect(addButton()).toBeEnabled();
}
async function bSignsIn() {
  await c.clearCookies();
  const other = await c.newPage();
  await signIn(other, eB);
  await other.close();
  return idOf(eB);
}
async function bodyText() {
  return p.evaluate(() => document.documentElement.innerText + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join("\n") + document.documentElement.innerHTML);
}
/** B sees nothing of A's here, nor anywhere Back and Forward lead. */
async function nothingOfA(texts: string[]) {
  const check = async (where: string) => {
    await p.waitForLoadState("load");
    await p.waitForTimeout(700);
    const body = await bodyText().catch(() => "");
    for (const t of texts) expect(body, `${where} (${p.url()})`).not.toContain(t);
  };
  await check("after the action");
  for (let i = 0; i < 4; i++) {
    await p.goBack({ timeout: 5_000 }).catch(() => null);
    await check(`Back ${i + 1}`);
    if (p.url() === "about:blank") break;
  }
  for (let i = 0; i < 4; i++) {
    await p.goForward({ timeout: 5_000 }).catch(() => null);
    await check(`Forward ${i + 1}`);
  }
}
/** A's own history in the tab: a thread on Today, then /add by in-app links. */
async function aHistory() {
  await fill(FERNS + " and email the landlord about the boiler");
  await field().press("Enter");
  await expect(p.getByRole("status").filter({ hasText: "Added" })).toBeVisible();
  await p.getByRole("link", { name: "Today", exact: true }).first().click();
  await expect(p).toHaveURL(/\/today/);
  await p.getByRole("link", { name: "Add", exact: true }).first().click();
  await p.getByRole("link", { name: "Quick add" }).click();
  await expect(field()).toBeVisible();
}
async function lose(reachServer: boolean) {
  let once = true;
  await p.route("**/add?mode=quick", async (route) => {
    if (route.request().method() !== "POST" || !once) return route.continue();
    once = false;
    if (reachServer) await route.fetch();
    await route.abort("connectionreset");
  });
}

for (const how of ["Try again (first request saved)", "Try again (first request lost)", "Add button", "Enter", "Undo"] as const) {
  test(`stale tab, ${how}: refused, nothing stored or changed for either user, B sees nothing of A's`, async () => {
    await aHistory();
    if (how.startsWith("Try")) {
      await lose(how.includes("saved"));
      await fill(PLUMBER);
      await field().press("Enter");
      await expect(unknown()).toContainText(PLUMBER);
    } else {
      await fill(PLUMBER);
      if (how === "Undo") {
        await field().press("Enter");
        await expect(added(PLUMBER)).toBeVisible();
        await p.getByRole("button", { name: `Undo add: ${PLUMBER}` }).focus();
      }
    }
    const b = await bSignsIn();
    const [beforeA, beforeB] = [await rows(a), await rows(b)];
    expect(beforeB).toEqual(NOTHING);
    const posts: string[] = [];
    p.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/add")) posts.push(r.postData() ?? "");
    });
    if (how.startsWith("Try")) await p.getByRole("button", { name: "Try again" }).click();
    else if (how === "Add button") await addButton().click();
    else if (how === "Enter") await field().press("Enter");
    else await p.getByRole("button", { name: `Undo add: ${PLUMBER}` }).click();
    await expect(addButton()).toBeDisabled();
    await expect(p).toHaveURL(/\/add\?mode=quick$/);
    await expect(field()).toHaveValue("");
    await nothingOfA([PLUMBER, FERNS]);
    expect(posts).toHaveLength(1);
    expect(await rows(b)).toEqual(beforeB);
    expect(await rows(a)).toEqual(beforeA);
    // B's own add works, and is B's.
    await p.goto("/add?mode=quick");
    await fill(PLUMBER);
    await field().press("Enter");
    await expect(added(PLUMBER)).toBeVisible();
    expect((await rows(b)).threads).toHaveLength(1);
    expect(await rows(a)).toEqual(beforeA);
  });
}

for (const [name, line, upDelayed] of [
  ["all High, answer late", PLUMBER, false],
  ["some for review, answer late", MIXED, false],
  ["answer lost", PLUMBER, false],
  ["request not yet sent", PLUMBER, true],
] as const) {
  for (const nav of [false, true]) {
    test(`in flight when B signs in (${name})${nav ? ", B has navigated and typed" : ""}: the line stays A's, B sees nothing of it`, async () => {
      let release = () => {};
      const gate = new Promise<void>((r) => (release = r));
      let sent = () => {};
      const reached = new Promise<void>((r) => (sent = r));
      let first = true;
      await p.route("**/add?mode=quick", async (route) => {
        if (route.request().method() !== "POST" || !first) return route.continue();
        first = false;
        if (upDelayed) {
          // Held before it leaves the browser: it goes out in B's session, so it is the stale-tab case.
          sent();
          await gate;
          return route.continue().catch(() => null);
        }
        const response = await route.fetch();
        sent();
        await gate;
        if (name === "answer lost") return route.abort("connectionreset").catch(() => null);
        await route.fulfill({ response }).catch(() => null);
      });
      await fill(line);
      await field().press("Enter");
      await reached;
      const b = await bSignsIn();
      if (nav) {
        await p.getByRole("link", { name: "Today", exact: true }).first().click();
        await expect(p).toHaveURL(/\/today/, { timeout: 10_000 }).catch(() => console.log("INFLIGHT navigation waits for the action"));
        await p.getByRole("link", { name: "Add", exact: true }).first().click();
        await p.getByRole("link", { name: "Quick add" }).click();
        await expect(p.getByRole("heading").first()).toBeVisible();
        await p.waitForTimeout(1_500);
        if (await field().isVisible()) await field().fill("B's own words");
      }
      const beforeB = await rows(b);
      release();
      await p.waitForTimeout(4_000);
      const val = (await field().isVisible().catch(() => false)) ? await field().inputValue() : "-";
      const text = await bodyText();
      console.log(`INFLIGHT ${name} nav=${nav}: url ${p.url().replace(/[0-9a-f-]{36}/, "ID")} field "${val}" shows A's line: ${text.includes(line)} bank: ${text.includes("Call the bank")} A threads ${((await rows(a)).threads as unknown[]).length}`);
      if (nav) for (const t of [line, "Call the bank", "dentist"]) expect(text).not.toContain(t);
      expect(await rows(b)).toEqual(beforeB);
      expect(beforeB).toEqual(NOTHING);
      // Try again, if offered in the stale page, is refused too.
      const again = p.getByRole("button", { name: "Try again" });
      if (!nav && (await again.isVisible().catch(() => false)) && (await unknown().isVisible())) {
        await again.click();
        await expect(addButton()).toBeDisabled();
        await expect(unknown()).toHaveCount(0);
      }
      // From wherever the old tab is, going on in the app shows B nothing of A's.
      await p.goto("/add?mode=quick");
      await nothingOfA([line, "Call the bank", "dentist"]);
      expect(await rows(b)).toEqual(beforeB);
    });
  }
}

test("Undo of the handed-off toast on the review page: refused, A's thread stays, B sees neither the tray nor the toast", async () => {
  await fill(MIXED);
  await field().press("Enter");
  await expect(p).toHaveURL(/\/review\//);
  const undo = p.getByRole("button", { name: /^Undo add/ });
  await undo.focus();
  const b = await bSignsIn();
  const before = await rows(a);
  await undo.click();
  await expect(addButton()).toBeDisabled();
  await expect(p).toHaveURL(/\/add\?mode=quick$/);
  await nothingOfA(["Call the bank", "dentist"]);
  expect(await rows(a)).toEqual(before);
  expect(await rows(b)).toEqual(NOTHING);
});

test("B navigates in the app with A's toast open: the same document, and the toast is gone", async () => {
  await fill(PLUMBER);
  await field().press("Enter");
  await p.getByRole("button", { name: `Undo add: ${PLUMBER}` }).focus();
  await p.evaluate(() => ((window as unknown as { sameDocument: boolean }).sameDocument = true));
  await bSignsIn();
  await p.getByRole("link", { name: "Quick add" }).click();
  await p.getByRole("link", { name: "Today", exact: true }).first().click();
  await expect(p).toHaveURL(/\/today/);
  await p.getByRole("link", { name: "Add", exact: true }).first().click();
  await p.getByRole("link", { name: "Quick add" }).click();
  await expect(field()).toBeVisible();
  expect(await p.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument ?? false)).toBe(true);
  await expect(p.getByText(PLUMBER)).toHaveCount(0);
});

// Each prints what happens, so the same test describes the unfixed code.
for (const ended of ["cookies gone", "session revoked"] as const)
for (const how of ["Add", "Undo", "Undo on review", "unknown line then Add"] as const) {
  test(`${ended} (no other user), ${how}: nothing stored or changed`, async () => {
    test.skip(ended === "session revoked" && !isolated, "needs the isolated stack's database");
    if (how === "unknown line then Add") {
      await lose(false);
      await fill(PLUMBER);
      await field().press("Enter");
      await expect(unknown()).toBeVisible();
    }
    await fill(how === "Undo on review" ? MIXED : how === "unknown line then Add" ? TWO : PLUMBER);
    if (how.startsWith("Undo")) {
      await field().press("Enter");
      await p.getByRole("button", { name: /^Undo add/ }).focus();
    }
    const before = await rows(a);
    if (ended === "cookies gone") await c.clearCookies();
    else sql(`delete from auth.sessions where user_id = '${a}'`);
    if (how.startsWith("Undo")) await p.getByRole("button", { name: /^Undo add/ }).click();
    else await field().press("Enter");
    await p.waitForTimeout(3_000);
    const url = new URL(p.url());
    console.log(`ENDED ${ended}, ${how}: ${url.pathname}${url.search.replace(/[0-9a-f-]{36}/, "ID")} alert ${JSON.stringify(await p.getByRole("alert").allInnerTexts())}`);
    await p.goBack({ timeout: 5_000 }).catch(() => null);
    await p.waitForTimeout(1_000);
    const back = (await field().isVisible().catch(() => false)) ? await field().inputValue() : "no field";
    console.log(`ENDED ${ended}, ${how}: after Back ${new URL(p.url()).pathname} field "${back}" unknown banners ${await unknown().count()}`);
    expect(await rows(a)).toEqual(before);
  });
}

test("Auth does not answer while the session is fine: what Add does", async () => {
  test.skip(!isolated || process.env.LE_D7_AUTH_OUTAGE !== "1", "stops the isolated stack's Auth container");
  const auth = DB.replace("_db_", "_auth_");
  await lose(false);
  await fill(TWO);
  await field().press("Enter");
  await expect(unknown()).toBeVisible();
  await fill(PLUMBER);
  execFileSync("docker", ["stop", auth]);
  try {
    await field().press("Enter");
    await p.waitForTimeout(15_000);
    console.log(`OUTAGE during: ${p.url()} banners ${JSON.stringify(await p.getByRole("alert").allInnerTexts())}`);
  } finally {
    execFileSync("docker", ["start", auth]);
  }
  await p.waitForTimeout(12_000);
  const value = (await field().isVisible().catch(() => false)) ? await field().inputValue() : "no field";
  console.log(`OUTAGE after: ${p.url()} field "${value}" unknown banners ${await unknown().count()}`);
});

test("Delete account in a stale tab (measurement, wider issue)", async () => {
  test.skip(process.env.LE_D7_DELETE !== "1", "run on request");
  await p.goto("/settings");
  await p.getByRole("button", { name: "Delete account…" }).click();
  const d = p.getByRole("dialog");
  await d.getByLabel("Type delete to confirm").fill("delete");
  const b = await bSignsIn();
  await d.getByRole("button", { name: "Delete account" }).click();
  await p.waitForTimeout(5_000);
  const exists = async (id: string) => Boolean((await admin().auth.admin.getUserById(id)).data.user);
  console.log(`DELETE stale tab: A exists ${await exists(a)}, B exists ${await exists(b)}, url ${p.url()}`);
});
