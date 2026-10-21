import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { ErrorBanner } from "@/components/Notice";
import { ThreadRow } from "@/components/threads/ThreadBits";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listThreads, userTimezone } from "@/lib/threads/read";
import { THREADS_COPY as C } from "@/lib/threads/view";
import { getNow } from "@/lib/time";

export const metadata: Metadata = { title: "Today" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Interim Today (S4): the user's Active threads as a plain list linking to Thread detail, in the
 * Threads index order. No ranking, reason line, count line or cap: F10 replaces this page (Oct 24)
 * with the SITE_CONTRACT §2.5 layout.
 */
export default async function TodayPage({ searchParams }: { searchParams: SearchParams }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const x of [v].flat()) if (x !== undefined) params.append(k, x);
  const qs = params.toString();
  const user = await requireUser(qs ? `/today?${qs}` : "/today");

  const supabase = await createClient();
  const [rows, timezone] = await Promise.all([listThreads(supabase, "active"), userTimezone(supabase, user.id)]);
  const now = getNow();

  return (
    <>
      <AppHeader current="today" />
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        <h1 className="text-display-sm text-le-text sm:text-display">Today</h1>
        <div className="mt-6">
          {rows === null ? (
            <ErrorBanner
              action={
                <Link href="/today" className={buttonVariants({ variant: "secondary", size: "small" })}>
                  {C.tryAgain}
                </Link>
              }
            >
              {C.loadFailed}
            </ErrorBanner>
          ) : rows.length === 0 ? (
            <div className="pt-10 text-center">
              <p className="text-h3 text-le-text">{C.todayEmpty}</p>
              <Link href="/add" className={buttonVariants({ variant: "secondary", className: "mt-6" })}>
                {C.addSomething}
              </Link>
            </div>
          ) : (
            <ul className="space-y-2" aria-label={C.todayListLabel}>
              {rows.map((t) => (
                <ThreadRow key={t.id} t={t} timezone={timezone} now={now} />
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
