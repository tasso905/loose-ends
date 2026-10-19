import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { localSupabase } from "./localSupabase";

/** Synthetic, unique address per test run (example.com is reserved; nothing leaves Mailpit). */
export const testEmail = () => `le-e2e-${randomUUID().slice(0, 8)}@example.com`;

function admin() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Deletes the throwaway auth users (profiles cascade). */
export async function deleteUsers(emails: string[]) {
  if (emails.length === 0) return;
  const client = admin();
  const { data } = await client.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data?.users ?? []) if (u.email && emails.includes(u.email)) await client.auth.admin.deleteUser(u.id);
}

export async function profileFor(email: string) {
  const client = admin();
  const { data } = await client.auth.admin.listUsers({ perPage: 1000 });
  const user = data?.users.find((u) => u.email === email);
  if (!user) return null;
  const { data: profile } = await client.from("profiles").select("*").eq("id", user.id).single();
  return profile as { aliases: string[]; display_name: string; timezone: string; onboarded_at: string | null } | null;
}

interface MailpitSummary {
  ID: string;
  Created: string;
}

/** Waits for the newest Mailpit message to `email` created after `since` and returns its sign-in link. */
export async function magicLinkFor(email: string, since: Date): Promise<string> {
  const { mailpitUrl } = localSupabase();
  let link: string | null = null;
  await expect
    .poll(
      async () => {
        const res = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
        if (!res.ok) return null;
        const body = (await res.json()) as { messages?: MailpitSummary[] };
        const fresh = (body.messages ?? []).filter((m) => new Date(m.Created).getTime() >= since.getTime() - 1000);
        const latest = fresh.sort((a, b) => b.Created.localeCompare(a.Created))[0];
        if (!latest) return null;
        const msg = (await (await fetch(`${mailpitUrl}/api/v1/message/${latest.ID}`)).json()) as { HTML?: string; Text?: string };
        const source = `${msg.Text ?? ""}\n${msg.HTML ?? ""}`.replaceAll("&amp;", "&");
        link = source.match(/https?:\/\/[^\s"'<>)]+\/auth\/v1\/verify\?[^\s"'<>)]+/)?.[0] ?? null;
        return link;
      },
      { timeout: 20_000, message: `magic link email to ${email}` },
    )
    .not.toBeNull();
  return link!;
}

/** Requests a magic link from /sign-in (current page) and waits for the confirmed check-your-email state. */
export async function requestLink(page: Page, email: string): Promise<Date> {
  const since = new Date();
  await page.getByLabel("Email").fill(email);
  const send = page.getByRole("button", { name: "Email me a sign-in link" });
  const sent = page.getByRole("heading", { name: "Check your email" });
  const limited = page.locator("main").getByText("Too many sign-in links were requested.");
  // A second link to the same address inside GoTrue's per-address window (SMTP max frequency) is
  // refused, and the page says so (tester-auth.spec covers that path). Wait it out and resend. Only
  // a confirmed send navigates to `?sent=1`, so the URL decides, never a possibly stale notice.
  for (let attempt = 0; attempt < 10; attempt++) {
    await expect(send).toBeEnabled();
    await send.click();
    const ok = await page
      .waitForURL(/[?&]sent=1/, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) break;
    await expect(limited).toBeVisible();
  }
  await expect(sent).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  return since;
}
