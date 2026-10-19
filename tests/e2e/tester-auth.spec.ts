/**
 * Lead-tester: independent F1 checks against local Supabase + Mailpit (synthetic addresses only).
 * Rule 10 failure paths, the email-holding cookie, Host spoofing on the magic link, cross-user
 * tampering through onboarding, sign-out, keyboard-only flow, reduced motion and extra axe states.
 */
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, profileFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

const created: string[] = [];
test.afterAll(async () => deleteUsers(created));

const fresh = () => {
  const e = testEmail();
  created.push(e);
  return e;
};
const SEND = "Email me a sign-in link";
const sentHeading = (page: Page) => page.getByRole("heading", { name: "Check your email" });
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function smallTargets(page: Page) {
  return page.$$eval("main a, main button, main input:not([type=hidden]), main textarea, header a, header button", (els) =>
    els
      .map((el) => ({ el: el.outerHTML.slice(0, 60), r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.height < 44 || r.width < 44))
      .map(({ el, r }) => `${el} (${Math.round(r.width)}x${Math.round(r.height)})`),
  );
}

async function signInFresh(page: Page, path = "/sign-in") {
  const email = fresh();
  await page.goto(path);
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  return email;
}

test.describe("rule 10: check-your-email only after Supabase confirms", () => {
  test("a failed send (server action 500) keeps the form and shows the send-failed copy", async ({ page }) => {
    await page.route("**/sign-in**", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 500, body: "boom" }) : r.continue()));
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(fresh());
    await page.getByRole("button", { name: SEND }).click();
    await expect(page.locator("main").getByRole("alert")).toHaveText("I couldn't send the link. Try again.");
    await expect(sentHeading(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/sign-in$/);
    await axe(page);
  });

  test("a rate-limited send (real GoTrue 429) keeps the form and shows the rate-limit copy", async ({ page }) => {
    const email = fresh();
    const sb = localSupabase();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    // Burn the per-address window directly at GoTrue, then send through the UI inside it.
    const first = await fetch(`${sb.url}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: sb.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: true }),
    });
    expect(first.status).toBe(200);
    await page.getByRole("button", { name: SEND }).click();
    await expect(page.locator("main").getByRole("alert")).toHaveText(
      "Too many sign-in links were requested. Wait a few minutes, then try again.",
    );
    await expect(sentHeading(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/sign-in$/);
    expect((await page.context().cookies()).find((c) => c.name === "le_sign_in_email")).toBeUndefined();
    await axe(page);
    await page.setViewportSize({ width: 375, height: 800 });
    expect(await smallTargets(page)).toEqual([]);
  });

  test("the email cookie is httpOnly, SameSite=Lax, scoped to /sign-in, 15 min, and never in a URL", async ({ page }) => {
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    const email = fresh();
    await page.goto("/sign-in?next=%2Fthreads");
    await requestLink(page, email);
    await expect(page).toHaveURL(/\/sign-in\?(?=.*sent=1)(?=.*next=%2Fthreads)/);

    const c = (await page.context().cookies()).find((x) => x.name === "le_sign_in_email");
    expect(c).toBeDefined();
    expect(c!.httpOnly).toBe(true);
    expect(c!.sameSite).toBe("Lax");
    expect(c!.path).toBe("/sign-in");
    const ttl = c!.expires - Date.now() / 1000;
    // B3: 15 minutes (was about 1 h), shorter than the 3600 s magic-link expiry.
    expect(ttl).toBeGreaterThan(850);
    expect(ttl).toBeLessThanOrEqual(900);
    expect(await page.evaluate(() => document.cookie)).not.toContain("le_sign_in_email");

    // The magic link itself carries no address either.
    const link = await magicLinkFor(email, new Date(Date.now() - 30_000));
    expect(decodeURIComponent(link)).not.toContain(email);
    expect(urls.filter((u) => decodeURIComponent(u).includes(email))).toEqual([]);

    // "Use a different email" keeps next and returns to the form.
    await page.getByRole("link", { name: "Use a different email" }).click();
    await expect(page).toHaveURL("/sign-in?next=%2Fthreads");
    await expect(page.getByRole("button", { name: SEND })).toBeVisible();
  });

  // Defect: the cookie outlives the flow. After a full sign-in and sign-out on the same browser,
  // /sign-in?sent=1 still says "I sent a sign-in link to <previous address>" for up to an hour:
  // a stale success claim, and the previous user's address on a shared device.
  test("after sign-in and sign-out, ?sent=1 does not show the previous address", async ({ page }) => {
    const email = await signInFresh(page);
    await expect(page).toHaveURL(/\/onboarding$/);
    await page.getByRole("button", { name: "Skip" }).click();
    await expect(page).toHaveURL(/\/today$/);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto("/sign-in?sent=1");
    await expect(page.getByText(email)).toHaveCount(0);
    await expect(sentHeading(page)).toHaveCount(0);
  });
});

/**
 * Replays the real sign-in server action from Node with a consistent forged Origin / Host /
 * X-Forwarded-Host (a browser cannot forge Origin, and Next aborts the action when they disagree).
 * Returns the redirect_to origin GoTrue put in the emailed link.
 */
async function spoofedLinkOrigin(page: Page): Promise<string> {
  const probe = fresh();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(probe);
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/sign-in")),
    page.getByRole("button", { name: SEND }).click(),
  ]);
  await expect(sentHeading(page)).toBeVisible();
  const target = fresh();
  const headers = { ...(await req.allHeaders()) };
  for (const h of ["host", "content-length", "cookie", "connection"]) delete headers[h];
  const body = req.postDataBuffer()!.toString("latin1").replace(probe, target);
  const since = new Date();
  const res = await fetch(req.url(), {
    method: "POST",
    headers: { ...headers, origin: "http://evil.example", "x-forwarded-host": "evil.example", host: "evil.example", "x-forwarded-proto": "http" },
    body: Buffer.from(body, "latin1"),
  });
  expect(res.status).toBe(200);
  const link = new URL(await magicLinkFor(target, since));
  return new URL(link.searchParams.get("redirect_to")!).origin;
}

test("magic-link origin: SITE_URL wins over a forged Origin / Host / X-Forwarded-Host", async ({ page }) => {
  const origin = await spoofedLinkOrigin(page);
  test.info().annotations.push({ type: "redirect_to origin", description: origin });
  expect(origin).toBe("http://127.0.0.1:3000");
});

test("a bogus code in the browser that requested the link shows the expired notice", async ({ page }) => {
  await page.goto("/sign-in");
  await requestLink(page, fresh()); // sets the PKCE verifier cookie in this browser
  await page.goto("/auth/callback?code=00000000-0000-4000-8000-000000000000&next=%2Fthreads");
  await expect(page).toHaveURL(/\/sign-in\?error=/);
  const text = await page.locator("main").getByRole("alert").innerText();
  test.info().annotations.push({ type: "notice", description: `${page.url()} :: ${text}` });
  expect(text).toMatch(/expired or was already used|different browser/);
  await axe(page);
});

test("onboarding cannot write another user's profile, and RLS refuses direct writes", async ({ page }) => {
  const sb = localSupabase();
  const admin = createClient(sb.url, sb.serviceRoleKey, opts);
  const victimEmail = fresh();
  const pw = `pw-${crypto.randomUUID()}`;
  const { data: v } = await admin.auth.admin.createUser({ email: victimEmail, password: pw, email_confirm: true });
  const victimId = v.user!.id;
  const before = await profileFor(victimEmail);

  // Tamper with the onboarding form: extra id fields and a forged next.
  await signInFresh(page);
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.evaluate((id) => {
    const f = document.querySelector("form")!;
    for (const name of ["id", "user_id", "userId", "email"]) {
      const i = document.createElement("input");
      i.type = "hidden";
      i.name = name;
      i.value = name === "email" ? "victim@example.com" : id;
      f.appendChild(i);
    }
    (document.querySelector('input[name="next"]') as HTMLInputElement).value = "//evil.com";
  }, victimId);
  await page.getByLabel("Names and emails").fill("Mallory");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3000/today");
  expect(await profileFor(victimEmail)).toEqual(before);

  // Direct PostgREST writes with an attacker session.
  const attackerEmail = fresh();
  await admin.auth.admin.createUser({ email: attackerEmail, password: pw, email_confirm: true });
  const attacker = createClient(sb.url, sb.anonKey, opts);
  expect((await attacker.auth.signInWithPassword({ email: attackerEmail, password: pw })).error).toBeNull();
  const upd = await attacker.from("profiles").update({ onboarded_at: null, aliases: ["pwned"], display_name: "pwned" }).eq("id", victimId).select();
  expect(upd.data ?? []).toEqual([]);
  const read = await attacker.from("profiles").select("*").eq("id", victimId);
  expect(read.data ?? []).toEqual([]);
  const { data: me } = await attacker.auth.getUser();
  const move = await attacker.from("profiles").update({ id: victimId }).eq("id", me.user!.id).select();
  expect(move.data ?? []).toEqual([]);
  expect(await profileFor(victimEmail)).toEqual(before);
});

test("sign-out removes this browser's session cookies", async ({ page }) => {
  await signInFresh(page);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today$/);
  expect((await page.context().cookies()).filter((c) => c.name.includes("auth-token")).length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect((await page.context().cookies()).filter((c) => c.name.includes("auth-token"))).toEqual([]);
  await page.goto("/today");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Ftoday/);
});

// Regression guard for B1 (fixed). Sign out is scope "local" now, so it no longer revokes the other
// browser; this test revokes every session server-side instead (a global sign-out elsewhere, a
// password reset or an admin action). The other browser still holds an unexpired JWT that getClaims()
// accepts, while getUser() says session_not_found. Before the fix the proxy and requireUser()
// disagreed and bounced between /today and /sign-in (ERR_TOO_MANY_REDIRECTS). Account deletion is
// covered in sign-in.spec.ts.
test("signing out in one browser leaves the other browser at sign-in, not in a redirect loop", async ({ browser }) => {
  const email = fresh();
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  for (const p of [pa, pb]) {
    await p.goto("/sign-in");
    const since = await requestLink(p, email);
    await p.goto(await magicLinkFor(email, since));
    if (p.url().includes("/onboarding")) await p.getByRole("button", { name: "Skip" }).click();
    await expect(p).toHaveURL(/\/today$/);
    await p.waitForTimeout(1500); // GoTrue per-address send window
  }
  // Developer (B1b): Sign out is now scope "local", so it no longer revokes B. Keep the scenario the
  // defect described: after A signs out locally, revoke every session server-side (what a global
  // sign-out on another device, a password reset or an admin action does) while B keeps its JWT.
  const sb = localSupabase();
  await pa.getByRole("button", { name: "Sign out" }).click();
  await expect(pa).toHaveURL(/\/sign-in$/);
  await pb.goto("/today");
  await expect(pb).toHaveURL(/\/today$/); // local sign-out leaves the other browser signed in
  const accessToken = await accessTokenFrom(b);
  const revoke = await fetch(`${sb.url}/auth/v1/logout?scope=global`, {
    method: "POST",
    headers: { apikey: sb.anonKey, Authorization: `Bearer ${accessToken}` },
  });
  expect(revoke.status).toBe(204);
  await pb.goto("/today");
  await expect(pb).toHaveURL(/\/sign-in\?next=%2Ftoday/);
  await a.close();
  await b.close();
});

/** The access token from a context's @supabase/ssr session cookie (possibly chunked, base64-prefixed). */
async function accessTokenFrom(ctx: import("@playwright/test").BrowserContext): Promise<string> {
  const parts = (await ctx.cookies())
    .filter((c) => /-auth-token(\.\d+)?$/.test(c.name))
    .sort((x, y) => x.name.localeCompare(y.name, "en", { numeric: true }));
  let raw = parts.map((c) => c.value).join("");
  if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice(7), "base64url").toString("utf8");
  return (JSON.parse(raw) as { access_token: string }).access_token;
}

test("keyboard only: sign in → onboarding → skip → Today → sign out, with a visible focus ring", async ({ page }) => {
  const email = fresh();
  await page.goto("/sign-in");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  const inputFocus = await page.getByLabel("Email").evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopColor, shadow: s.boxShadow };
  });
  expect(inputFocus.shadow).not.toBe("none");
  await page.keyboard.type(email);
  await page.keyboard.press("Tab");
  const send = page.getByRole("button", { name: SEND });
  await expect(send).toBeFocused();
  const ring = await send.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
  expect(ring).toEqual({ style: "solid", width: "2px" });
  const since = new Date();
  await page.keyboard.press("Enter");
  await expect(sentHeading(page)).toBeVisible();
  // The confirmation is reachable by keyboard.
  let reached = false;
  for (let i = 0; i < 6 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.getByRole("link", { name: "Use a different email" }).evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);

  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Names and emails")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Save" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Skip" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/today$/);
  await page.keyboard.press("Tab");
  // `next dev` injects the Next.js dev-tools button (NEXTJS-PORTAL) as a tab stop; it is not in production.
  if (await page.evaluate(() => document.activeElement?.tagName === "NEXTJS-PORTAL")) await page.keyboard.press("Tab");
  const out = page.getByRole("button", { name: "Sign out" });
  await expect(out).toBeFocused();
  expect(await out.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
  await axe(page);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("reduced motion: transitions collapse; the status spinner keeps turning", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/sign-in**", async (r) => {
    if (r.request().method() !== "POST") return r.continue();
    await new Promise((res) => setTimeout(res, 1500));
    return r.fulfill({ status: 500, body: "slow" });
  });
  await page.goto("/sign-in");
  const send = page.getByRole("button", { name: SEND });
  expect(await send.evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^(0\.01ms|1e-05s|0s)/);
  await page.getByLabel("Email").fill(fresh());
  await send.click();
  await expect(send).toBeDisabled();
  const spin = page.locator("svg.animate-spin-status");
  await expect(spin).toBeVisible();
  expect(await spin.evaluate((el) => getComputedStyle(el).animationDuration)).toBe("0.9s");
  // The label stays visible next to the spinner (DESIGN_STANDARD Reduced motion / Product moments).
  await expect(send).toHaveText(SEND);
});

test("onboarding error states pass axe: too many entries, and a failed save", async ({ page }) => {
  await signInFresh(page);
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel("Names and emails").fill(Array.from({ length: 21 }, (_, i) => `n${i}`).join(", "));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("That's more than 20 names and emails. Keep the ones people use most.");
  await expect(page.getByLabel("Names and emails")).toHaveAttribute("aria-invalid", "true");
  await axe(page);

  await page.route("**/onboarding**", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 500, body: "x" }) : r.continue()));
  await page.getByLabel("Names and emails").fill("Sam");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("main").getByRole("alert").first()).toHaveText("That didn't save. Try again.");
  await expect(page).toHaveURL(/\/onboarding$/);
  await axe(page);
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await smallTargets(page)).toEqual([]);
});

test("375 px: sent state and Today header meet 44 px targets and pass axe", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const email = fresh();
  await page.goto("/sign-in");
  const since = await requestLink(page, email);
  expect(await smallTargets(page)).toEqual([]);
  await axe(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.goto(await magicLinkFor(email, since));
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today$/);
  expect(await smallTargets(page)).toEqual([]);
  await axe(page);
});

test("every sign-in state has exactly one h1, the pitch, and no heading for the wordmark", async ({ page }) => {
  for (const url of ["/sign-in", "/sign-in?error=link_expired", "/sign-in?error=link_other_browser", "/sign-in?error=bogus", "/sign-in?sent=1"]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tie up your loose ends.");
    await expect(page.getByRole("heading", { name: "Loose Ends", exact: true })).toHaveCount(0);
    await expect(page.getByText(/analytics/i)).toHaveCount(0);
  }
  await page.goto("/sign-in?error=bogus");
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
});

// Defect (medium): React 19 resets uncontrolled form fields after a form action resolves, and these
// actions resolve (with a failure code) on validation errors. The typed value is wiped, so the user
// must retype it after being told what to fix.
test("sign-in: an invalid email stays in the field after the error", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("name@example");
  await page.getByRole("button", { name: SEND }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Enter an email address");
  await expect(page.getByLabel("Email")).toHaveValue("name@example");
});

test("onboarding: the answer stays in the field after a too-many error", async ({ page }) => {
  await signInFresh(page);
  await expect(page).toHaveURL(/\/onboarding$/);
  const answer = Array.from({ length: 21 }, (_, i) => `n${i}`).join(", ");
  await page.getByLabel("Names and emails").fill(answer);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("more than 20");
  await expect(page.getByLabel("Names and emails")).toHaveValue(answer);
});

// Defect (medium, F1 "timezone detected from browser"): the hidden timezone input is filled once in
// useEffect; the post-action form reset empties it, so a save after any failed attempt stores no timezone.
test("onboarding: the browser timezone is still saved after a failed first attempt", async ({ browser }) => {
  const ctx = await browser.newContext({ timezoneId: "Asia/Tokyo" });
  const page = await ctx.newPage();
  const email = await signInFresh(page);
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.locator('input[name="timezone"]')).toHaveValue("Asia/Tokyo");
  await page.getByLabel("Names and emails").fill(Array.from({ length: 21 }, (_, i) => `n${i}`).join(", "));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("more than 20");
  await page.getByLabel("Names and emails").fill("Sam");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/today$/);
  expect((await profileFor(email))?.timezone).toBe("Asia/Tokyo");
  await ctx.close();
});

// ---- Re-verification (B1 paths, no-JS) ----

const authCookieNames = async (ctx: import("@playwright/test").BrowserContext) =>
  (await ctx.cookies()).filter((c) => /-auth-token(\.\d+)?$/.test(c.name)).map((c) => c.name);

/** Rewrites the @supabase/ssr session cookie so the stored session looks expired (forces a refresh). */
async function expireStoredSession(ctx: import("@playwright/test").BrowserContext) {
  const parts = (await ctx.cookies())
    .filter((c) => /-auth-token(\.\d+)?$/.test(c.name))
    .sort((x, y) => x.name.localeCompare(y.name, "en", { numeric: true }));
  const base = parts[0]!.name.replace(/\.\d+$/, "");
  let raw = parts.map((c) => c.value).join("");
  const b64 = raw.startsWith("base64-");
  if (b64) raw = Buffer.from(raw.slice(7), "base64url").toString("utf8");
  const s = JSON.parse(raw) as { expires_at: number };
  s.expires_at = 1;
  let value = JSON.stringify(s);
  if (b64) value = `base64-${Buffer.from(value, "utf8").toString("base64url")}`;
  const proto = parts[0]!;
  await ctx.clearCookies({ name: new RegExp(`^${base}(\\.\\d+)?$`) });
  const chunks = value.match(/.{1,3180}/g)!;
  await ctx.addCookies(
    chunks.map((v, i) => ({ ...proto, name: chunks.length === 1 ? base : `${base}.${i}`, value: v })),
  );
}

/** Records 5xx responses and page errors, so a dead-session path cannot hide a server error. */
function trackErrors(page: Page) {
  const errs: string[] = [];
  page.on("response", (r) => { if (r.status() >= 500) errs.push(`${r.status()} ${r.url()}`); });
  page.on("pageerror", (e) => errs.push(`pageerror ${e.message}`));
  return errs;
}

async function signedInContext(browser: import("@playwright/test").Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = await signInFresh(page);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/today$/);
  return { ctx, page, email };
}

test("B1: account deleted while signed in → sign-in, cookies cleared, no loop on any entry route", async ({ browser }) => {
  const { ctx, page, email } = await signedInContext(browser);
  const errs = trackErrors(page);
  const sb = localSupabase();
  const admin = createClient(sb.url, sb.serviceRoleKey, opts);
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const id = data.users.find((u) => u.email === email)!.id;
  expect((await admin.auth.admin.deleteUser(id)).error).toBeNull();

  await page.goto("/today");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Ftoday$/);
  expect(await authCookieNames(ctx)).toEqual([]);
  for (const [path, want] of [["/", /\/sign-in$/], ["/onboarding", /\/sign-in$/], ["/sign-in?next=%2Fthreads", /\/sign-in\?next=%2Fthreads$/], ["/threads?filter=closed", /\/sign-in\?next=%2Fthreads%3Ffilter%3Dclosed$/]] as const) {
    await page.goto(path);
    await expect(page).toHaveURL(want);
  }
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  expect(errs).toEqual([]);
  await ctx.close();
});

test("B1: global revoke → first request to / or /sign-in also lands on sign-in and clears cookies", async ({ browser }) => {
  const sb = localSupabase();
  for (const entry of ["/", "/sign-in?next=%2Ftoday"]) {
    const { ctx, page } = await signedInContext(browser);
    const errs = trackErrors(page);
    const token = await accessTokenFrom(ctx);
    const r = await fetch(`${sb.url}/auth/v1/logout?scope=global`, { method: "POST", headers: { apikey: sb.anonKey, Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(204);
    await page.goto(entry);
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByRole("button", { name: SEND })).toBeVisible();
    expect(await authCookieNames(ctx)).toEqual([]);
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
    expect(errs).toEqual([]);
    await ctx.close();
  }
});

test("B1: expired access token with a revoked refresh token → sign-in, no loop, cookies cleared", async ({ browser }) => {
  const sb = localSupabase();
  const { ctx, page } = await signedInContext(browser);
  const errs = trackErrors(page);
  const token = await accessTokenFrom(ctx);
  expect((await fetch(`${sb.url}/auth/v1/logout?scope=global`, { method: "POST", headers: { apikey: sb.anonKey, Authorization: `Bearer ${token}` } })).status).toBe(204);
  await expireStoredSession(ctx);
  for (const path of ["/today", "/", "/sign-in?next=%2Ftoday"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sign-in/);
  }
  expect(await authCookieNames(ctx)).toEqual([]);
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  expect(errs).toEqual([]);
  await ctx.close();
});

test("control: expired access token with a valid refresh token refreshes and stays on Today", async ({ browser }) => {
  const { ctx, page } = await signedInContext(browser);
  await expireStoredSession(ctx);
  await page.goto("/today");
  await expect(page).toHaveURL(/\/today$/);
  await page.goto("/sign-in");
  await expect(page).toHaveURL(/\/today$/);
  await ctx.close();
});

test("no JavaScript: the sign-in page renders the pitch and form; record what the button does", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tie up your loose ends.");
  const send = page.getByRole("button", { name: SEND });
  const state = {
    disabled: await send.isDisabled(),
    ariaDisabled: await send.getAttribute("aria-disabled"),
    noscript: await page.locator("noscript").count(),
  };
  test.info().annotations.push({ type: "no-js", description: JSON.stringify(state) });
  // R3: the disabled button has its reason next to it (DESIGN_STANDARD "Disabled").
  expect(state.disabled).toBe(true);
  expect(await page.locator("body").innerText()).toContain("Signing in needs JavaScript. Turn it on in your browser, then reload this page.");
  await ctx.close();
});

test("hydrated: buttons become enabled and focusable after hydration", async ({ page }) => {
  await page.goto("/sign-in");
  const send = page.getByRole("button", { name: SEND });
  await expect(send).toBeEnabled();
  await page.getByLabel("Email").focus();
  await page.keyboard.press("Tab");
  await expect(send).toBeFocused();
});

// Defect (low-medium, introduced by the B2 fix): the email input is now controlled with
// useState(""), so on a slow connection anything typed (or autofilled) before React hydrates is
// wiped when hydration sets the value back to "". JS is held back here to make it deterministic.
// Suggested fix: seed the state from the DOM on mount (ref.current.value), or keep the input
// uncontrolled and preserve the value another way.
test("an email typed before hydration survives hydration", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/_next/static/**/*.js", async (r) => {
    await gate;
    await r.continue();
  });
  await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill("early@example.com");
  release();
  await expect(page.getByRole("button", { name: SEND })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByLabel("Email")).toHaveValue("early@example.com");
});
