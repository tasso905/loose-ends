import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { AskBox } from "@/components/decisions/AskBox";
import { ErrorBanner } from "@/components/Notice";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { DECISIONS_COPY as D } from "@/lib/decisions/copy";
import { listDecisions } from "@/lib/decisions/read";
import { createClient } from "@/lib/supabase/server";
import { userTimezone } from "@/lib/threads/read";
import { formatDecisionDate } from "@/lib/threads/view";
import { parseInstant } from "@/lib/time";

export const metadata: Metadata = { title: "Decisions" };
// An ask makes one model call (askWhy() retries once at most); keep the action within the page limit.
export const maxDuration = 60;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * /decisions (SITE_CONTRACT §2.11, CONTENT_MODEL §10): the Ask box (F12) and the user's recorded
 * decisions, newest first, each linking to its thread. `?q=` prefills the box with the last question.
 */
export default async function DecisionsPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).q;
  const q = typeof raw === "string" ? raw : "";
  const user = await requireUser(q ? `/decisions?q=${encodeURIComponent(q)}` : "/decisions");
  const supabase = await createClient();
  const [rows, timezone] = await Promise.all([listDecisions(supabase), userTimezone(supabase, user.id)]);

  return (
    <>
      <AppHeader current="decisions" />
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        <h1 className="text-display-sm text-le-text sm:text-display">{D.heading}</h1>
        <div className="mt-6">
          <AskBox initialQuestion={q} timezone={timezone} />
        </div>

        <section aria-labelledby="recorded" className="mt-10">
          <h2 id="recorded" className="text-h3 text-le-text">
            {D.listHeading}
          </h2>
          <div className="mt-3">
            {rows === null ? (
              <ErrorBanner
                action={
                  <Link href={q ? `/decisions?q=${encodeURIComponent(q)}` : "/decisions"} className={buttonVariants({ variant: "secondary", size: "small" })}>
                    {D.tryAgain}
                  </Link>
                }
              >
                {D.loadFailed}
              </ErrorBanner>
            ) : rows.length === 0 ? (
              <p className="pt-6 text-center text-body text-le-text-secondary">{D.empty}</p>
            ) : (
              <ul className="space-y-2">
                {rows.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/threads/${d.thread_id}`}
                      className="focus-ring block rounded-card border border-le-border bg-le-surface px-4 py-3 transition-colors duration-(--le-dur-fast) ease-(--le-ease-out) hover:bg-le-surface-sunken"
                    >
                      <span className="block text-body-strong whitespace-pre-wrap text-le-text">{d.choice}</span>
                      <span className="mt-1 block text-small text-le-text-secondary">
                        {d.thread_title} ·{" "}
                        <time dateTime={parseInstant(d.decided_at).toISOString()} className="tabular-nums">
                          {formatDecisionDate(d.decided_at, timezone)}
                        </time>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
