import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Quote } from "lucide-react";
import { z } from "zod";
import { AppHeader } from "@/components/AppHeader";
import { ErrorBanner } from "@/components/Notice";
import { EXPLAIN_COPY, ExplainBrief, NotSureList, parseBrief } from "@/components/review/ExplainBrief";
import { ConfidenceLabel } from "@/components/review/ReviewTray";
import { ThreadActions } from "@/components/threads/ThreadActions";
import { DueChip, StatusChip } from "@/components/threads/ThreadBits";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getThreadDetail, userTimezone, type ThreadDetail } from "@/lib/threads/read";
import { formatHistoryTime, historyLine, KIND_LABEL, sourceCaption, THREADS_COPY as C } from "@/lib/threads/view";
import { getNow, parseInstant } from "@/lib/time";

type Params = Promise<{ id: string }>;

const isUuid = (s: string) => z.uuid().safeParse(s).success;

/** The browser tab shows the thread title (SITE_CONTRACT §1.1). RLS: another user's id has no title. */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  if (!isUuid(id)) return { title: "Thread" };
  const supabase = await createClient();
  const { data } = await supabase.from("threads").select("title").eq("id", id).maybeSingle();
  return { title: typeof data?.title === "string" ? { absolute: data.title } : "Thread" };
}

/**
 * /threads/[id] (SITE_CONTRACT §2.7, CONTENT_MODEL §6): header, Explain card (F7), evidence,
 * append-only history and Done (Resolve… disabled on decision threads until F11). The Why panel,
 * Source viewer link and the other actions arrive with F8, F9's remaining actions and F11.
 * Unknown and other users' ids render the not-found page (RLS; never reveals existence).
 */
export default async function ThreadPage({ params }: { params: Params }) {
  const { id } = await params;
  const user = await requireUser(`/threads/${encodeURIComponent(id)}`);
  if (!isUuid(id)) notFound();

  const supabase = await createClient();
  const [res, timezone] = await Promise.all([getThreadDetail(supabase, id), userTimezone(supabase, user.id)]);
  if (!res.ok && res.reason === "not_found") notFound();

  return (
    <>
      <AppHeader current={null} />
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-24 sm:px-6 lg:px-8">
        {res.ok ? (
          <Thread detail={res.detail} timezone={timezone} />
        ) : (
          <ErrorBanner
            action={
              <Link href={`/threads/${id}`} className={buttonVariants({ variant: "secondary", size: "small" })}>
                {C.tryAgain}
              </Link>
            }
          >
            {C.loadFailed}
          </ErrorBanner>
        )}
      </main>
    </>
  );
}

function Thread({ detail, timezone }: { detail: ThreadDetail; timezone: string }) {
  const { thread: t, evidence, events, origin, sources, brief, notSure } = detail;
  const now = getNow();

  return (
    <article aria-labelledby="thread-title">
      <h1 id="thread-title" className="text-display-sm text-le-text sm:text-display">
        {t.title}
      </h1>
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-small text-le-text-secondary">
        {/* Focus lands here after Done, when the Done button leaves the page. */}
        <span id="thread-status" tabIndex={-1} className="focus-ring rounded-control">
          <StatusChip status={t.status} />
        </span>
        <span>{KIND_LABEL[t.kind]}</span>
        {t.counterparty ? <span>· {t.counterparty}</span> : null}
        {t.status === "open" || t.status === "waiting" || t.status === "snoozed" ? (
          <DueChip dueAt={t.due_at} certainty={t.due_certainty} timeKnown={t.due_time_known} timezone={timezone} now={now} />
        ) : null}
      </p>
      {origin?.label && origin.band !== "ignore" ? (
        <div className="mt-2">
          <ConfidenceLabel band={origin.band} label={origin.label} />
        </div>
      ) : null}

      {t.next_action ? (
        <section aria-labelledby="next-action" className="mt-6">
          <h2 id="next-action" className="text-eyebrow text-le-text-tertiary uppercase">
            {C.nextAction}
          </h2>
          <p className="mt-1 text-body text-le-text">{t.next_action}</p>
        </section>
      ) : null}

      <div className="mt-6">
        <ThreadActions threadId={t.id} title={t.title} status={t.status} kind={t.kind} />
      </div>

      {brief && parseBrief(brief.brief) ? (
        <ExplainBrief brief={brief.brief} source={sources[brief.sourceId] ?? null} notSure={notSure} className="mt-10" />
      ) : (
        <CompactExplain thread={t} timezone={timezone} now={now} notSure={notSure} />
      )}

      {evidence.length > 0 ? (
        <section aria-labelledby="evidence" className="mt-10">
          <h2 id="evidence" className="text-h3 text-le-text">
            {C.evidence}
          </h2>
          <ul className="mt-3 space-y-3">
            {evidence.map((e) => {
              const source = e.source_id ? sources[e.source_id] : undefined;
              return (
                <li key={e.id}>
                  <figure className="rounded-r-control border-l-2 border-(--le-evidence-rule) bg-(--le-evidence-bg) px-4 py-3">
                    <figcaption className="flex items-center gap-1 text-label text-le-text-secondary">
                      <Quote aria-hidden strokeWidth={1.75} className="size-3.5" />
                      {sourceCaption(source, e.page)}
                    </figcaption>
                    <blockquote className="mt-1 font-serif text-body text-le-text">{e.quote}</blockquote>
                  </figure>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="history" className="mt-10">
        <h2 id="history" className="text-h3 text-le-text">
          {C.history}
        </h2>
        <ol className="mt-3 space-y-2 border-l border-le-border pl-4">
          {events.map((e) => (
            <li key={e.id} className="text-small">
              <time dateTime={parseInstant(e.created_at).toISOString()} className="text-le-text-tertiary tabular-nums">
                {formatHistoryTime(e.created_at, timezone)}
              </time>
              <span className="text-le-text"> · {historyLine(e)}</span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

/**
 * F7 compact Explain card for a thread whose source has no brief (paste, quick add): only What you
 * need to do and By when (CONTENT_MODEL §6, DESIGN_STANDARD "Explain card"), each only when it has
 * something to say, plus "Not sure about" (PRD F7: never an empty section). Nothing at all when the
 * thread has none of them. Title `About this` is PROPOSED copy.
 */
function CompactExplain({
  thread: t,
  timezone,
  now,
  notSure,
}: {
  thread: ThreadDetail["thread"];
  timezone: string;
  now: Date;
  notSure: string[];
}) {
  const due = t.due_at && (t.status === "open" || t.status === "waiting" || t.status === "snoozed");
  if (!t.next_action && !due && notSure.length === 0) return null;
  return (
    <section aria-labelledby="explain-title" className="mt-10 rounded-card border border-le-border bg-le-surface p-4 sm:p-5">
      <h2 id="explain-title" className="text-h2 text-le-text">
        {EXPLAIN_COMPACT_TITLE}
      </h2>
      <div className="mt-4 space-y-6">
        {t.next_action ? (
          <div>
            <h3 className="text-eyebrow text-le-text-tertiary uppercase">{EXPLAIN_COPY.whatToDo}</h3>
            <p className="mt-2 text-body text-le-text">{t.next_action}</p>
          </div>
        ) : null}
        {due ? (
          <div>
            <h3 className="text-eyebrow text-le-text-tertiary uppercase">{EXPLAIN_COPY.byWhen}</h3>
            <p className="mt-2">
              <DueChip dueAt={t.due_at} certainty={t.due_certainty} timeKnown={t.due_time_known} timezone={timezone} now={now} />
            </p>
          </div>
        ) : null}
        {notSure.length > 0 ? <NotSureList lines={notSure} /> : null}
      </div>
    </section>
  );
}

/** PROPOSED. */
const EXPLAIN_COMPACT_TITLE = "About this";
