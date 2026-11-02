import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { ErrorBanner } from "@/components/Notice";
import { ActionHostProvider } from "@/components/threads/ActionHost";
import { ThreadActions } from "@/components/threads/ThreadActions";
import { DueChip, ThreadRow } from "@/components/threads/ThreadBits";
import { WhyLink } from "@/components/threads/WhySheet";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { userTimezone } from "@/lib/threads/read";
import { getToday, type TodayThread } from "@/lib/threads/today";
import { greeting, THREADS_COPY as C, TODAY_COPY as T } from "@/lib/threads/view";
import { getNow } from "@/lib/time";

export const metadata: Metadata = { title: "Today" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * F10 Today (SITE_CONTRACT §2.5, CONTENT_MODEL §4): greeting with the user's local date and the
 * `N to review` chip; the count line; "Worth your attention" (at most 5, score ≥ 0.3, ranked by
 * attentionScore(), each row with its reason line and `Why?`); then the collapsed Waiting on others,
 * Coming up and Recently resolved sections, each hidden at 0. Everything is computed from stored
 * fields with getNow() and the user's timezone; nothing calls a model (rule 6). Only accepted
 * threads are read, so an unaccepted Low proposal never appears (rule 4).
 *
 * Not here yet: Snooze (F9, not built) and the "Still relevant?" prompt (D20(c), deferred).
 */
export default async function TodayPage({ searchParams }: { searchParams: SearchParams }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const x of [v].flat()) if (x !== undefined) params.append(k, x);
  const qs = params.toString();
  const user = await requireUser(qs ? `/today?${qs}` : "/today");

  const supabase = await createClient();
  const timezone = await userTimezone(supabase, user.id);
  const now = getNow();
  const data = await getToday(supabase, timezone, now);

  return (
    <>
      <AppHeader current="today" />
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        {/* Focus lands here when Done or Resolve takes a row away. */}
        <h1 id="today-heading" tabIndex={-1} className="focus-ring rounded-control text-display-sm text-le-text sm:text-display">
          {T.heading}
        </h1>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p className="text-body text-le-text-secondary">{greeting(now, timezone)}</p>
          {data?.review ? (
            <Link
              href={`/review/${data.review.extractionId}`}
              className="focus-ring inline-flex h-6 items-center rounded-control bg-le-accent-subtle px-2 text-label text-le-accent tabular-nums max-md:h-11"
            >
              {T.toReview(data.review.count)}
            </Link>
          ) : null}
        </div>

        <div className="mt-6">
          {data === null ? (
            <ErrorBanner
              action={
                <Link href="/today" className={buttonVariants({ variant: "secondary", size: "small" })}>
                  {C.tryAgain}
                </Link>
              }
            >
              {C.loadFailed}
            </ErrorBanner>
          ) : (
            <ActionHostProvider>
              <section aria-labelledby="attention-heading">
                <h2 id="attention-heading" className="sr-only">
                  {T.attention}
                </h2>
                {data.sections.attention.length === 0 ? (
                  <div className="pt-6 text-center">
                    <p className="text-h3 text-le-text">{C.todayEmpty}</p>
                    <Link href="/add" className={buttonVariants({ variant: "secondary", className: "mt-6" })}>
                      {C.addSomething}
                    </Link>
                  </div>
                ) : (
                  <>
                    <p data-testid="count-line" className="text-body-strong text-le-text">
                      {T.countLine(data.sections.attention.length)}
                    </p>
                    <ul className="mt-3 space-y-2">
                      {data.sections.attention.map((t) => (
                        <AttentionRow key={t.id} t={t} reason={data.reasons[t.id]} timezone={timezone} now={now} />
                      ))}
                    </ul>
                  </>
                )}
              </section>

              <div className="mt-8 space-y-3">
                <Collapsed id="waiting" title={T.waiting} rows={data.sections.waiting} timezone={timezone} now={now} />
                <Collapsed id="coming-up" title={T.comingUp} rows={data.sections.comingUp} timezone={timezone} now={now} />
                <Collapsed id="resolved" title={T.resolved} rows={data.sections.resolved} timezone={timezone} now={now} />
              </div>
            </ActionHostProvider>
          )}
        </div>
      </main>
    </>
  );
}

/**
 * Thread row (DESIGN_STANDARD "Thread row"): title and due chip, then the reason line ending in
 * `Why?`, then the quick actions (Done, or Resolve… for decision threads, D6).
 */
function AttentionRow({ t, reason, timezone, now }: { t: TodayThread; reason: string | undefined; timezone: string; now: Date }) {
  return (
    <li data-testid="attention-row" className="rounded-card border border-le-border bg-le-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link id={`title-${t.id}`} href={`/threads/${t.id}`} className="focus-ring min-w-0 flex-1 rounded-control text-body-strong text-le-text hover:underline max-md:min-h-11 max-md:content-center">
          {t.title}
        </Link>
        <DueChip dueAt={t.due_at} certainty={t.due_certainty} timeKnown={t.due_time_known} timezone={timezone} now={now} />
      </div>
      {/* A div, not a p: the Why sheet (a dialog) renders next to its link. */}
      <div className="mt-1 flex flex-wrap items-center gap-x-1 text-small text-le-text-secondary">
        {reason ? (
          <>
            <span data-testid="reason-line">{reason}</span>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <WhyLink threadId={t.id} surface="today" describedBy={`title-${t.id}`} />
      </div>
      <div className="mt-2">
        <ThreadActions threadId={t.id} title={t.title} status={t.status} kind={t.kind} compact surface="today" focusTargetId="today-heading" />
      </div>
    </li>
  );
}

/** A collapsed section with its count; hidden when the count is 0 (SITE_CONTRACT §2.5). */
function Collapsed({ id, title, rows, timezone, now }: { id: string; title: string; rows: TodayThread[]; timezone: string; now: Date }) {
  if (rows.length === 0) return null;
  return (
    <details data-testid={`section-${id}`} className="group rounded-card border border-le-border bg-le-surface">
      <summary className="focus-ring flex cursor-pointer items-center justify-between gap-3 rounded-card px-4 py-3 text-body-strong text-le-text max-md:min-h-11">
        <span>{title}</span>
        <span className="text-small text-le-text-secondary tabular-nums">{rows.length}</span>
      </summary>
      <ul className="space-y-2 px-2 pb-2">
        {rows.map((t) => (
          <ThreadRow key={t.id} t={t} timezone={timezone} now={now} showStatus={false} />
        ))}
      </ul>
    </details>
  );
}
