import { requireUser } from "@/lib/auth/session";

/**
 * Auth for /settings, outside the segment's loading boundary (a signed-out visit redirects to
 * sign-in with `next`). S11 adds the Data section (F13, D14), so the page is no longer a 404 while
 * analytics is off (D57(d) no longer applies now that analytics runs): only the analytics toggle
 * stays hidden where analytics is not configured, so it never implies collection that does not
 * happen (rule 9). See page.tsx.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireUser("/settings");
  return children;
}
