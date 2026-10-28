import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";
import { localSupabase } from "./localSupabase";

/**
 * Lead-tester rule-9 capture check (feat/analytics-on, D46). Runs only when the E2E server was started
 * with LE_E2E_POSTHOG_HOST pointing at this spec's LOCAL catcher (never PostHog itself):
 *
 *   LE_E2E_POSTHOG_HOST=http://127.0.0.1:55499 pnpm exec playwright test tests/e2e/tester-analytics-capture.spec.ts
 *
 * It drives the real UI (onboarding, paste, review, accept, Done, Undo, the Settings opt-out) and
 * inspects every byte the server tried to send: only allow-listed events; no title, quote, pasted text,
 * name or email in any body, header or URL; no person profile. Opting out stops the very next event,
 * and the browser never loads PostHog or talks to any third-party host. Synthetic text only (the
 * recorded mike-email fixture, so no live model).
 */

const CATCHER_PORT = 55499;
const ACTIVE = process.env.LE_E2E_POSTHOG_HOST === `http://127.0.0.1:${CATCHER_PORT}`;
test.skip(!ACTIVE, "start the E2E server with LE_E2E_POSTHOG_HOST=http://127.0.0.1:55499 to run the capture check");
test.describe.configure({ mode: "serial" });

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const TITLE = "Send revised proposal to Mike";
const QUOTE = "I'll send you the revised proposal Friday";
const ALLOWED = new Set(["source_submitted", "extraction_completed", "proposals_shown", "proposal_reviewed", "thread_action", "undo_used"]);

const email = testEmail();
let context: BrowserContext;
let page: Page;
let uid = "";
let threadId = "";
let server: Server;
type Hit = { method: string; url: string; headers: Record<string, unknown>; body: string };
type Ev = { event: string; distinct_id: string; properties: Record<string, unknown> };
const hits: Hit[] = [];
const browserHosts = new Set<string>();

const admin = () => {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
};

function events(): Ev[] {
  const out: Ev[] = [];
  for (const h of hits) {
    if (!h.body) continue;
    try {
      const j = JSON.parse(h.body) as { batch?: Ev[] } & Ev;
      out.push(...(Array.isArray(j.batch) ? j.batch : [j]));
    } catch {
      out.push({ event: "(unparsed)", distinct_id: "", properties: { raw: h.body.slice(0, 200) } });
    }
  }
  return out;
}

test.beforeAll(async ({ browser }) => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let raw = Buffer.concat(chunks);
      if (String(req.headers["content-encoding"] ?? "").includes("gzip") || (raw[0] === 0x1f && raw[1] === 0x8b)) raw = gunzipSync(raw);
      hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw.toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":1}');
    });
  });
  await new Promise<void>((r) => server.listen(CATCHER_PORT, "127.0.0.1", () => r()));

  context = await browser.newContext();
  page = await context.newPage();
  page.on("request", (r) => browserHosts.add(new URL(r.url()).host));
  await page.goto("/sign-in?next=%2Fadd");
  const since = await requestLink(page, email);
  await page.goto(await magicLinkFor(email, since));
  await expect(page).toHaveURL(/\/onboarding/);
  uid = (await admin().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)!.id;
});

test.afterAll(async () => {
  await context?.close();
  await deleteUsers([email]);
  await new Promise<void>((r) => server.close(() => r()));
});

test("onboarding: the D46 notice and link; the link is a 44 px target at 375 px; no PostHog in the browser", async () => {
  await expect(page.getByText("Loose Ends counts which features you use. Analytics never include what you paste.")).toBeVisible();
  const link = page.getByRole("link", { name: "Turn off analytics" });
  await expect(link).toHaveAttribute("href", "/settings#profile");
  await page.setViewportSize({ width: 375, height: 800 });
  const box = (await link.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 1280, height: 720 });
  const ph = await page.evaluate(() => ({
    global: typeof (window as unknown as { posthog?: unknown }).posthog,
    scripts: [...document.scripts].map((s) => s.src).filter((s) => /posthog/i.test(s)),
    html: /posthog|phc_/i.test(document.documentElement.outerHTML),
  }));
  expect(ph).toEqual({ global: "undefined", scripts: [], html: false });
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page).toHaveURL(/\/add$/);
});

test("paste → review → accept → Done → Undo sends only allow-listed events of IDs, enums, counts and booleans", async () => {
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /I found/ })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept selected" }).click();
  await expect(page.getByText("1 thread added")).toBeVisible();
  threadId = (await admin().from("threads").select("id").eq("user_id", uid).single()).data!.id as string;
  await page.goto(`/threads/${threadId}`);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("#thread-status")).toHaveText("Resolved");
  await page.getByRole("button", { name: `Undo done: ${TITLE}` }).click();
  await expect(page.locator("#thread-status")).toHaveText("Open");

  await expect
    .poll(() => [...new Set(events().map((e) => e.event))].sort(), { timeout: 15_000 })
    .toEqual([...ALLOWED].sort());

  const everything = JSON.stringify(hits);
  if (process.env.LE_E2E_CAPTURE_DUMP) writeFileSync(process.env.LE_E2E_CAPTURE_DUMP, JSON.stringify(hits, null, 2));
  for (const secret of [email, TITLE, QUOTE, MIKE, "revised proposal", "grab lunch", "Mike", "Friday"]) {
    expect(everything.includes(secret), `"${secret}" reached the analytics endpoint`).toBe(false);
  }
  for (const e of events()) {
    expect(ALLOWED.has(e.event), e.event).toBe(true);
    expect(e.distinct_id).toBe(uid);
    expect(e.properties.$process_person_profile).toBe(false);
    for (const [k, v] of Object.entries(e.properties)) {
      if (k.startsWith("$")) continue; // SDK metadata: $lib, $lib_version, $is_server, $process_person_profile, $geoip_disable
      const ok =
        typeof v === "number" ||
        typeof v === "boolean" ||
        v === null ||
        (typeof v === "string" && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) || /^[a-z0-9_]{1,24}$/.test(v))) ||
        (Array.isArray(v) && v.every((x) => typeof x === "string" && /^[a-z_]{1,24}$/.test(x))) ||
        (typeof v === "object" && Object.values(v as object).every((x) => typeof x === "number"));
      expect(ok, `${e.event}.${k} = ${JSON.stringify(v)}`).toBe(true);
    }
    // Only SDK-reserved $ keys; never a person property.
    for (const k of Object.keys(e.properties).filter((x) => x.startsWith("$"))) {
      expect(k, `${e.event}.${k}`).toMatch(/^\$(lib|lib_version|is_server|process_person_profile|geoip_disable)$/);
    }
  }
  expect(everything).not.toMatch(/"\$set"|"\$set_once"|"\$identify"|"\$email"|"\$ip"/);
  // The catcher saw nothing but capture/batch posts (no flag or decide calls carrying person data).
  for (const h of hits) expect(`${h.method} ${h.url.split("?")[0]}`).toMatch(/^POST \/(batch|capture|i\/v0\/e)\/?$/);
});

test("opting out in Settings stops the very next event; opting back in resumes", async () => {
  await page.goto("/settings#profile");
  const sw = page.getByRole("switch", { name: "Analytics" });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  const { data } = await admin().from("user_settings").select("analytics_enabled").eq("user_id", uid).single();
  expect(data!.analytics_enabled).toBe(false);

  const before = events().length;
  await page.goto(`/threads/${threadId}`);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("#thread-status")).toHaveText("Resolved");
  await page.getByRole("button", { name: `Undo done: ${TITLE}` }).click();
  await expect(page.locator("#thread-status")).toHaveText("Open");
  await page.goto("/add?mode=paste");
  await page.getByLabel("Paste a message or document").fill(MIKE);
  await page.getByRole("button", { name: "Review source" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(4_000); // longer than the 2.5 s capture timeout
  expect(events().slice(before).map((e) => e.event)).toEqual([]);

  await page.goto("/settings#profile");
  const sw2 = page.getByRole("switch", { name: "Analytics" });
  await sw2.click();
  await expect(sw2).toHaveAttribute("aria-checked", "true");
  await page.goto(`/threads/${threadId}`);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("#thread-status")).toHaveText("Resolved");
  await expect.poll(() => events().slice(before).map((e) => e.event), { timeout: 15_000 }).toEqual(["thread_action"]);
});

test("the browser never loaded PostHog or contacted a third-party host", async () => {
  const sb = new URL(localSupabase().url).host;
  const base = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:3000").host;
  expect([...browserHosts].filter((h) => h !== base && h !== sb)).toEqual([]);
});
