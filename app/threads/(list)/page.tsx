import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { ErrorBanner } from "@/components/Notice";
import { FilterTabs } from "@/components/threads/FilterTabs";
import { ThreadRow } from "@/components/threads/ThreadBits";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { listThreads, userTimezone } from "@/lib/threads/read";
import { parseFilter, THREADS_COPY as C } from "@/lib/threads/view";
import { getNow } from "@/lib/time";

export const metadata: Metadata = { title: "Threads" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** /threads (SITE_CONTRACT §2.6, CONTENT_MODEL §5): Active / Closed, sorted per the contract. */
export default async function ThreadsPage({ searchParams }: { searchParams: SearchParams }) {
  const filter = parseFilter((await searchParams).filter);
  const user = await requireUser(filter === "closed" ? "/threads?filter=closed" : "/threads");
  const supabase = await createClient();
  const [rows, timezone] = await Promise.all([listThreads(supabase, filter), userTimezone(supabase, user.id)]);
  const now = getNow();
  const here = filter === "closed" ? "/threads?filter=closed" : "/threads";

  return (
    <>
      <AppHeader current="threads" />
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        <h1 className="text-display-sm text-le-text sm:text-display">{C.heading}</h1>
        <div className="mt-6">
          <FilterTabs current={filter} panelId="threads-panel" />
        </div>
        <div id="threads-panel" role="tabpanel" aria-labelledby={`tab-${filter}`} className="mt-6">
          {rows === null ? (
            <ErrorBanner
              action={
                <Link href={here} className={buttonVariants({ variant: "secondary", size: "small" })}>
                  {C.tryAgain}
                </Link>
              }
            >
              {C.loadFailed}
            </ErrorBanner>
          ) : rows.length === 0 ? (
            <div className="pt-10 text-center">
              <p className="text-h3 text-le-text">{filter === "active" ? C.emptyActive : C.emptyClosed}</p>
              {filter === "active" ? (
                <>
                  <p className="mt-2 text-small text-le-text-secondary">{C.emptyActiveLine}</p>
                  <Link href="/add" className={buttonVariants({ variant: "secondary", className: "mt-6" })}>
                    {C.addSomething}
                  </Link>
                </>
              ) : null}
            </div>
          ) : (
            <ul className="space-y-2">
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
