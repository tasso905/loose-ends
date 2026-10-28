import { requireUser } from "@/lib/auth/session";

/**
 * Auth for /settings, outside the segment's loading boundary (a signed-out visit redirects to
 * sign-in with `next`). S11 adds the Data section (F13, D14), so the page is no longer a 404 while
 * analytics is off: only the analytics toggle stays hidden until it can take effect (D40, D57's
 * reason: never show a toggle with no effect). See page.tsx.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireUser("/settings");
  return children;
}
