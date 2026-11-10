import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { deleteUsers, magicLinkFor, requestLink, testEmail } from "./helpers";

/**
 * Lead-tester: /privacy while Supabase is really stopped (SITE_CONTRACT §2.15), not simulated.
 * Stops the isolated stack's Kong, Auth, REST, Storage and Postgres containers, loads the page
 * signed out and signed in, checks a signed-in route really fails as a control, then starts them
 * again. Opt-in only (LE_PRIVACY_OUTAGE=1) and never on the shared `loose-ends` stack.
 */

const db = process.env.LE_S11_DB_CONTAINER ?? "";
const projectId = db.replace(/^supabase_db_/, "");
test.skip(process.env.LE_PRIVACY_OUTAGE !== "1" || !db.startsWith("supabase_db_") || projectId === "loose-ends", "needs LE_PRIVACY_OUTAGE=1 and an isolated stack");

const STOP = ["kong", "auth", "rest", "storage", "db"].map((s) => `supabase_${s}_${projectId}`);
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

for (const blockSignIn of [true, false]) {
test(`Supabase stopped: /privacy still renders, signed out and signed in, and doesn't sign anyone out (${blockSignIn ? "/sign-in prefetch blocked" : "as shipped"})`, async ({ browser }) => {
  // FIXED (lead-developer, Nov 10): the wordmark <Link href="/sign-in"> was prefetched, and the
  // proxy treated the failed Auth check on that prefetch as a dead session and cleared the Supabase
  // cookies. The link now has prefetch={false}. The proxy's sign-out on a transient Auth failure
  // (the tester-s11.spec.ts:957 pin) is still open and separate. Assertions unchanged.
  test.setTimeout(240_000);
  const email = testEmail();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto("/sign-in?next=%2Ftoday");
    const since = await requestLink(page, email);
    await page.goto(await magicLinkFor(email, since));
    await page.getByRole("button", { name: "Skip" }).click();
    await expect(page).toHaveURL(/\/today/);
    // Compared by name and length only: session values are never printed.
    const jar = async () => (await context.cookies()).map((c) => `${c.name}(${c.value.length})`).sort();
    const before = await jar();
    await page.goto("about:blank"); // nothing from /today keeps running during the outage

    docker("stop", "-t", "1", ...STOP);
    const running = docker("ps", "--format", "{{.Names}}").split("\n").filter((n) => STOP.includes(n));
    expect(running).toEqual([]);

    // Optionally block /sign-in (the wordmark link's prefetch) to tell the page from its prefetch.
    if (blockSignIn) await page.route(/\/sign-in/, (r) => r.abort());
    const seen: string[] = [];
    page.on("response", async (r) => {
      const set = (await r.headersArray().catch(() => [])).filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value.split(/[=;]/)[0]! + (/Max-Age=0/i.test(h.value) ? "(cleared)" : "(set)"));
      seen.push(`${r.request().method()} ${new URL(r.url()).pathname}${new URL(r.url()).search} ${r.status()} ${set.join(",")}`);
    });
    const res = await page.goto("/privacy");
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/privacy");
    await expect(page.locator("main [data-privacy-id]")).toHaveCount(33);
    await expect(page.getByRole("link", { name: "info@piscesparadigm.ca" })).toHaveAttribute("href", "mailto:info@piscesparadigm.ca");
    await page.waitForTimeout(3000); // let any prefetch finish
    console.log(`EVIDENCE outage responses (block sign-in=${blockSignIn}): ${JSON.stringify(seen.filter((s) => !/\/_next\/static\//.test(s)))}`);
    console.log(`EVIDENCE outage cookies before ${JSON.stringify(before)} after ${JSON.stringify(await jar())}`);
    // The session cookies are untouched by visiting /privacy during the outage.
    expect(await jar()).toEqual(before);
    // As shipped, it passes for the right reason: nothing on /privacy fetches /sign-in (no prefetch),
    // and no response during the visit clears or sets a cookie.
    if (!blockSignIn) expect(seen.filter((s) => /\/sign-in/.test(s))).toEqual([]);
    expect(seen.filter((s) => /\((set|cleared)\)/.test(s))).toEqual([]);

    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    const r2 = await anonPage.goto("/privacy?next=%2Ftoday");
    expect(r2?.status()).toBe(200);
    await expect(anonPage.locator("main [data-privacy-id]")).toHaveCount(33);
    await anon.close();

    // Control: a page that needs Supabase does not render its content.
    await page.goto("/threads").catch(() => null);
    await expect(page.getByRole("heading", { level: 1, name: "Threads" })).toHaveCount(0);
    console.log(`EVIDENCE outage control: /threads -> ${page.url()}`);
  } finally {
    docker("start", `supabase_db_${projectId}`);
    docker("start", ...STOP.filter((n) => !n.startsWith("supabase_db_")));
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${process.env.LE_SUPABASE_URL}/auth/v1/health`, { headers: { apikey: process.env.LE_SUPABASE_ANON_KEY ?? "" } });
        if (r.ok) break;
      } catch {
        // still starting
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    await context.close();
    await deleteUsers([email]).catch(() => undefined);
  }
});
}
