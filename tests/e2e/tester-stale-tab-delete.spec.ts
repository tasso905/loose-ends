import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, profileFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester: Delete account and onboarding in a tab rendered for A after B signed in from another
 * tab of the same browser (rules 8, 10). Synthetic users only. Checks that need the database
 * container run only when LE_S11_DB_CONTAINER names an isolated stack.
 */
const DB = process.env.LE_S11_DB_CONTAINER ?? "";
const isolated = DB !== "" && DB !== "supabase_db_loose-ends";
const DELETED = "Your account and your data in Loose Ends were deleted.";
const SECRET = "Avery fence notes";
const TABLES = ["sources", "extractions", "extraction_items", "threads", "thread_events", "evidence", "decisions", "suppressions", "usage_counters", "user_settings"];

const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};
const idOf = async (address: string) => (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === address)!.id;
const exists = async (id: string) => Boolean((await admin().auth.admin.getUserById(id)).data.user);

async function signIn(p: Page, address: string, onboard = true) {
  await p.goto("/sign-in?next=%2Fsettings");
  const since = await requestLink(p, address);
  await p.goto(await magicLinkFor(address, since));
  await expect(p).toHaveURL(/\/onboarding/);
  if (!onboard) return;
  await p.getByRole("button", { name: "Skip" }).click();
  await expect(p).toHaveURL(/\/settings/);
}
async function seed(uid: string, title: string) {
  const path = `${uid}/${randomUUID()}`;
  expect((await admin().storage.from("sources").upload(path, new Blob(["Synthetic notes."]), { contentType: "text/plain" })).error).toBeNull();
  const { data, error } = await admin()
    .from("sources")
    .insert({ user_id: uid, kind: "upload", title, text_content: "Synthetic notes.", storage_path: path, reference_date: "2026-10-20", reference_date_source: "user" })
    .select("id")
    .single();
  expect(error).toBeNull();
  const t = await admin().from("threads").insert({ user_id: uid, title: `${title} thread`, kind: "commitment", status: "open", primary_source_id: data!.id }).select("id").single();
  expect(t.error).toBeNull();
  return { source: data!.id as string, thread: t.data!.id as string };
}
/** Auth user, profile, every row in full, and the stored files. */
async function state(uid: string) {
  const out: Record<string, unknown> = {
    email: (await admin().auth.admin.getUserById(uid)).data.user?.email ?? null,
    profile: (await admin().from("profiles").select("*").eq("id", uid)).data,
    files: ((await admin().storage.from("sources").list(uid)).data ?? []).map((o) => o.name),
  };
  for (const t of TABLES) out[t] = (await admin().from(t).select("*").eq("user_id", uid).throwOnError()).data!.map((r) => JSON.stringify(r)).sort();
  return out;
}

let own: Browser | null = null;
let c: BrowserContext;
let p: Page;
let eA = "";
let eB = "";
test.beforeEach(async ({ browser, baseURL }) => {
  [eA, eB] = [testEmail(), testEmail()];
  if (process.env.LE_D7_BFCACHE === "1") own = await chromium.launch({ ignoreDefaultArgs: ["--disable-back-forward-cache"] });
  c = await (own ?? browser).newContext({ baseURL });
  p = await c.newPage();
});
test.afterEach(async () => {
  await c?.close();
  await own?.close();
  own = null;
  await deleteUsers([eA, eB]);
});

const dialog = () => p.getByRole("dialog", { name: "Delete your account?" });
async function typeDelete() {
  await p.getByRole("button", { name: "Delete account…" }).click();
  await dialog().getByLabel("Type delete to confirm").fill("delete");
}
async function bSignsIn(onboard = true) {
  await c.clearCookies();
  const other = await c.newPage();
  await signIn(other, eB, onboard);
  return { b: await idOf(eB), other };
}
/** Hashed: a failure must not print a token. */
const sessionCookies = async () =>
  (await c.cookies())
    .filter((k) => /^sb-.*-auth-token(\.\d+)?$/.test(k.name))
    .map((k) => `${k.name}=${createHash("sha256").update(k.value).digest("hex").slice(0, 12)}`)
    .sort();
async function bodyText() {
  return p.evaluate(() => document.documentElement.innerHTML + [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value).join("\n"));
}
async function nothingOf(texts: string[]) {
  const check = async (where: string) => {
    await p.waitForLoadState("load");
    await p.waitForTimeout(600);
    const body = await bodyText().catch(() => "");
    for (const t of texts) expect(body, `${where} ${p.url()}`).not.toContain(t);
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
/** A on /settings with a source, having visited Today and Threads in this tab. */
async function aOnSettings() {
  await signIn(p, eA);
  const a = await idOf(eA);
  const seeded = await seed(a, SECRET);
  await p.goto("/today");
  await p.getByRole("link", { name: "Threads", exact: true }).first().click();
  await expect(p).toHaveURL(/\/threads/);
  await p.goto("/settings");
  await expect(p.getByText(SECRET, { exact: true })).toBeVisible();
  return { a, ...seeded };
}

test("original repro: B survives, A survives, B stays signed in, nothing of A's shows to B after the reload, Back or Forward", async () => {
  const { a } = await aOnSettings();
  await typeDelete();
  const { b, other } = await bSignsIn();
  await seed(b, "Blake gate notes");
  await other.close();
  const before = [await state(a), await state(b)];
  const cookies = await sessionCookies();
  await dialog().getByRole("button", { name: "Delete account" }).click();
  await expect(dialog()).toBeHidden({ timeout: 20_000 });
  expect([await exists(a), await exists(b)], "[A exists, B exists]").toEqual([true, true]);
  await expect(p.getByText("Blake gate notes", { exact: true })).toBeVisible({ timeout: 20_000 });
  expect([await state(a), await state(b)]).toEqual(before);
  expect(await sessionCookies()).toEqual(cookies);
  await expect(p.getByText(DELETED)).toHaveCount(0);
  await nothingOf([SECRET, eA]);
  // An email user's own deletion still works, and A is untouched by it.
  await p.goto("/settings");
  await typeDelete();
  await dialog().getByRole("button", { name: "Delete account" }).click();
  await expect(p).toHaveURL(/\/sign-in$/, { timeout: 20_000 });
  await expect(p.getByRole("status").filter({ hasText: DELETED })).toBeVisible();
  expect([await exists(a), await exists(b)]).toEqual([true, false]);
  expect((await state(b)).files).toEqual([]);
  expect(await state(a)).toEqual(before[0]);
});

test("forged requests to the action: only the confirm word with the session's own id deletes, and only the session's user", async () => {
  const { a } = await aOnSettings();
  // The action's id and headers, captured from a request that never leaves the browser.
  let headers: Record<string, string> | null = null;
  await p.route("**/settings", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    headers = route.request().headers();
    await route.abort();
  });
  await typeDelete();
  await dialog().getByRole("button", { name: "Delete account" }).click();
  await expect.poll(() => headers).not.toBeNull();
  await p.unrouteAll({ behavior: "ignoreErrors" });
  const { b, other } = await bSignsIn();
  const before = [await state(a), await state(b)];
  const post = async (body: string) => {
    const res = await c.request.post("/settings", {
      headers: { "next-action": headers!["next-action"]!, "next-router-state-tree": headers!["next-router-state-tree"] ?? "", accept: "text/x-component", "content-type": "text/plain;charset=UTF-8", origin: new URL(p.url()).origin },
      data: body,
      maxRedirects: 0,
    });
    return { status: res.status(), text: await res.text() };
  };
  const refused: string[] = [
    "[]",
    '["delete"]',
    '["delete",null]',
    '["delete",""]',
    '["delete","junk"]',
    '["delete",true]',
    '["delete",{}]',
    JSON.stringify(["delete", a]),
    JSON.stringify(["delete", a, b]),
    JSON.stringify(["delete", [b]]),
    JSON.stringify(["delete", { id: b }]),
    JSON.stringify(["delete", { toString: b }]),
    JSON.stringify(["delete", ` ${b}`]),
    JSON.stringify(["delete", b.toUpperCase()]),
    JSON.stringify(["", b]),
    JSON.stringify([null, b]),
    JSON.stringify(["delet", b]),
    JSON.stringify(["deleted", b]),
    JSON.stringify([["delete"], b]),
    JSON.stringify([b, "delete"]),
  ];
  for (const body of refused) {
    const r = await post(body);
    expect(r.text, body).not.toContain('"ok":true');
    if (r.status === 200) expect(r.text, body).toMatch(/unauthenticated|invalid_input/);
    expect([await exists(a), await exists(b)], body).toEqual([true, true]);
  }
  expect([await state(a), await state(b)]).toEqual(before);
  // The endpoint is the real one: the right request deletes B, and only B.
  const ok = await post(JSON.stringify(["delete", b]));
  expect(ok.text).toContain('"ok":true');
  expect([await exists(a), await exists(b)]).toEqual([true, false]);
  expect(await state(a)).toEqual(before[0]);
  await other.close();
});

test("no session: the right id and word delete nothing", async () => {
  const { a } = await aOnSettings();
  await typeDelete();
  await c.clearCookies();
  const before = await state(a);
  await dialog().getByRole("button", { name: "Delete account" }).click();
  await p.waitForTimeout(3_000);
  console.log(`SIGNED OUT delete: ${p.url()} "${await dialog().getByRole("alert").allInnerTexts().catch(() => [])}"`);
  await expect(p.getByText(DELETED)).toHaveCount(0);
  expect(await state(a)).toEqual(before);
});

test("a dead session (revoked): nothing deleted, to sign-in, no claim", async () => {
  test.skip(!isolated, "needs the isolated stack's database");
  const { a } = await aOnSettings();
  await typeDelete();
  execFileSync("docker", ["exec", DB, "psql", "-U", "postgres", "-d", "postgres", "-tAc", `delete from auth.sessions where user_id = '${a}'`]);
  const before = await state(a);
  await dialog().getByRole("button", { name: "Delete account" }).click();
  await expect(p).toHaveURL(/\/sign-in\?next=%2Fsettings/, { timeout: 20_000 });
  await expect(p.getByText(DELETED)).toHaveCount(0);
  expect(await state(a)).toEqual(before);
});

/**
 * A's deletion passed its check and is waiting for a row lock when B signs in. It is A's own
 * confirmed deletion, so A goes; B must keep the account, the session and an honest page.
 */
for (const check of ["only A is deleted", "B stays signed in and is not told of a deletion"] as const)
test(`B signs in while A's own deletion runs: ${check}`, async () => {
  // Open defect (also on e17b246): A's response clears the browser's session cookie, now B's, and
  // opens the deletion notice. Remove this line when it is fixed. The data half must always pass.
  test.fail(check.startsWith("B stays"));
  test.skip(!isolated, "needs the isolated stack's database");
  const { a } = await aOnSettings();
  await typeDelete();
  const lock = spawn("docker", ["exec", DB, "psql", "-U", "postgres", "-d", "postgres", "-c", `begin; select 1 from public.profiles where id='${a}' for update; select pg_sleep(6); commit;`]);
  await p.waitForTimeout(700);
  const done = new Promise((r) => lock.on("exit", r));
  await dialog().getByRole("button", { name: "Delete account" }).click();
  await p.waitForTimeout(800);
  expect(await exists(a)).toBe(true);
  const { b, other } = await bSignsIn();
  await seed(b, "Blake gate notes");
  const before = await state(b);
  const cookies = await sessionCookies();
  expect(cookies.length).toBeGreaterThan(0);
  expect(await exists(a)).toBe(true); // still running
  await done;
  await expect.poll(() => exists(a), { timeout: 20_000 }).toBe(false);
  await p.waitForTimeout(4_000);
  const now = await sessionCookies();
  await other.goto("/settings");
  await other.waitForTimeout(500);
  console.log(
    `INFLIGHT DELETE: tab 1 ${new URL(p.url()).pathname}, says deleted: ${await p.getByText(DELETED).isVisible().catch(() => false)}; session cookies before ${cookies.length} after ${now.length}; B's tab ${other.url()}`,
  );
  expect(await exists(b)).toBe(true);
  expect(await state(b)).toEqual(before);
  if (check.startsWith("only")) return;
  expect.soft(now, "B's session cookies").toEqual(cookies);
  expect.soft(new URL(other.url()).pathname, "B's tab").toBe("/settings");
  await expect.soft(p.getByText(DELETED), "B is not told B's account was deleted").toHaveCount(0);
});

for (const button of ["Save", "Skip"] as const) {
  for (const bOnboarded of [false, true]) {
    test(`onboarding ${button} in A's tab, B ${bOnboarded ? "already onboarded" : "new"}: stored for no one, nothing of A's shows to B`, async () => {
      await signIn(p, eA, false);
      await p.getByLabel("Names and emails").fill("Avery Synthetic");
      const { other } = await bSignsIn(bOnboarded);
      await other.close();
      const before = [await profileFor(eA), await profileFor(eB)];
      await p.getByRole("button", { name: button }).click();
      await expect(p).toHaveURL(bOnboarded ? /\/settings$/ : /\/onboarding/);
      if (!bOnboarded) await expect(p.getByText(eB)).toBeVisible({ timeout: 20_000 });
      await expect(p.getByText(eA)).toHaveCount(0);
      expect([await profileFor(eA), await profileFor(eB)]).toEqual(before);
      await nothingOf(["Avery Synthetic", eA]);
      expect([await profileFor(eA), await profileFor(eB)]).toEqual(before);
    });
  }
}

test("onboarding with the id removed, emptied, junk or A's is refused; B's own saves, A's profile untouched", async () => {
  await signIn(p, eA, false);
  const a = await idOf(eA);
  const { other } = await bSignsIn(false);
  const before = [await profileFor(eA), await profileFor(eB)];
  for (const v of [null, "", "junk", a]) {
    await other.goto("/onboarding?next=%2Fsettings");
    await other.getByLabel("Names and emails").fill("Avery Synthetic");
    await other.evaluate((x) => {
      const i = document.querySelector<HTMLInputElement>('input[name="user_id"]')!;
      if (x === null) i.remove();
      else i.setAttribute("value", x);
    }, v);
    await other.getByRole("button", { name: "Save" }).click();
    await expect(other.getByLabel("Names and emails")).toHaveValue("", { timeout: 20_000 });
    expect([await profileFor(eA), await profileFor(eB)], String(v)).toEqual(before);
  }
  await other.getByLabel("Names and emails").fill("Blake Synthetic");
  await other.getByRole("button", { name: "Save" }).click();
  await expect(other).toHaveURL(/\/settings/);
  expect((await profileFor(eB))!.aliases).toContain("Blake Synthetic");
  expect(await profileFor(eA)).toEqual(before[0]);
});

test("the wider issue, measured: delete source and Forget in A's tab after B signed in", async () => {
  test.skip(process.env.LE_STALE_MEASURE !== "1", "run on request");
  const { a, source, thread } = await aOnSettings();
  const t2 = await c.newPage();
  await t2.goto(`/threads/${thread}`);
  await p.getByRole("button", { name: /^Delete source only/ }).click();
  const { other } = await bSignsIn();
  await other.close();
  await p.getByRole("dialog").getByRole("button", { name: /Delete source/ }).last().click();
  await p.waitForTimeout(3_000);
  console.log(`STALE source: says ${JSON.stringify(await p.getByRole("status").allInnerTexts())}; source still exists ${(await admin().from("sources").select("id").eq("id", source)).data!.length === 1}`);
  await t2.getByRole("button", { name: /More actions/ }).click();
  await t2.getByRole("menuitem", { name: "Forget permanently…" }).click();
  await t2.getByRole("dialog").getByRole("button", { name: "Forget permanently" }).click();
  await t2.waitForTimeout(3_000);
  console.log(`STALE forget: url ${new URL(t2.url()).pathname} status ${JSON.stringify(await t2.getByRole("status").allInnerTexts())} alerts ${JSON.stringify(await t2.getByRole("alert").allInnerTexts())}; thread still exists ${(await admin().from("threads").select("id").eq("id", thread)).data!.length === 1}, A exists ${await exists(a)}`);
});
