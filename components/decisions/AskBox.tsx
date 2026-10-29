"use client";
import { useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { PenLine, Quote } from "lucide-react";
import { askAction } from "@/app/decisions/actions";
import { Spinner } from "@/components/auth/Spinner";
import { FieldError } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ASK_MAX, type AskView } from "@/lib/decisions/view";
import { DECISIONS_COPY as D } from "@/lib/decisions/copy";
import { apiError, type ApiError } from "@/lib/errors";
import { formatDecisionDate } from "@/lib/threads/view";

/**
 * Ask box and answer card (SITE_CONTRACT §2.11, DESIGN_STANDARD "Ask Why answer card", Three
 * voices). The answer shows only after the server returns it (rule 10); a new ask clears the
 * previous answer first, so a failed ask never leaves an answer on screen. Every failure is shown
 * inline under the box with the question kept (D54); `ask_failed` offers Try again.
 * `?q=` prefills the box and is updated to the last question asked, so it can be shared or
 * reloaded; opening the link does not ask by itself (each ask counts toward the 50 a day).
 */
export function AskBox({ initialQuestion, timezone }: { initialQuestion: string; timezone: string }) {
  const [question, setQuestion] = useState(initialQuestion.slice(0, ASK_MAX));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ApiError["error"] | null>(null);
  const [view, setView] = useState<AskView | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();

  function ask() {
    const q = question.trim();
    if (!q || pending) return;
    setError(null);
    setView(null);
    startTransition(async () => {
      try {
        const res = await askAction(q);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setView(res.view);
        try {
          window.history.replaceState(window.history.state, "", `/decisions?q=${encodeURIComponent(q)}`);
        } catch {
          // The deep link is a convenience; the answer is already shown.
        }
      } catch {
        setError(apiError("ask_failed").error);
      }
    });
  }

  return (
    <div>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {D.askPlaceholder}
        </label>
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            id={inputId}
            type="text"
            name="question"
            value={question}
            maxLength={ASK_MAX}
            placeholder={D.askPlaceholder}
            autoComplete="off"
            onChange={(e) => setQuestion(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="min-w-0 flex-1"
          />
          <Button type="submit" disabled={pending || question.trim().length === 0} className="shrink-0">
            {pending ? <Spinner /> : null}
            {D.ask}
          </Button>
        </div>
        {error ? (
          <div className="flex flex-wrap items-center gap-x-3">
            <FieldError id={errorId}>{error.message}</FieldError>
            {error.code === "ask_failed" ? (
              <Button variant="secondary" size="small" className="mt-1" onClick={ask} disabled={pending}>
                {D.tryAgain}
              </Button>
            ) : null}
          </div>
        ) : null}
      </form>

      <div aria-live="polite" aria-busy={pending}>
        {view ? <AnswerCard view={view} timezone={timezone} /> : null}
      </div>
    </div>
  );
}

function AnswerCard({ view, timezone }: { view: AskView; timezone: string }) {
  if (!view.found) {
    return (
      <div className="mt-6 rounded-card border border-le-border bg-le-surface p-5">
        <p className="text-body text-le-text">{view.message}</p>
      </div>
    );
  }
  return (
    <div className="mt-6 space-y-4">
      {view.decisions.map((d) => {
        const date = formatDecisionDate(d.decided_at, timezone);
        return (
          <article key={d.id} aria-label={`${D.youDecided} · ${date}`} className="space-y-4 rounded-card border border-le-border bg-le-surface p-5">
            <div>
              <p className="text-label text-le-text-secondary">
                {D.youDecided} · {date}
              </p>
              <p className="mt-1 text-body-strong whitespace-pre-wrap text-le-text">{d.choice}</p>
            </div>
            {d.reason_user !== null ? (
              <figure className="border-l-2 border-le-border-strong pl-4">
                <figcaption className="flex items-center gap-1 text-label text-le-text-secondary">
                  <PenLine aria-hidden strokeWidth={1.75} className="size-3.5" />
                  {D.youWrote}
                </figcaption>
                <blockquote className="mt-1 text-body whitespace-pre-wrap text-le-text">
                  <span aria-hidden>“</span>
                  <span data-testid="reason">{d.reason_user}</span>
                  <span aria-hidden>”</span>
                </blockquote>
              </figure>
            ) : (
              <p className="text-body text-le-text-secondary">{D.noReason}</p>
            )}
            {d.facts.map((f) => (
              <figure key={f} className="rounded-r-control border-l-2 border-(--le-evidence-rule) bg-(--le-evidence-bg) px-4 py-3">
                <figcaption className="flex items-center gap-1 text-label text-le-text-secondary">
                  <Quote aria-hidden strokeWidth={1.75} className="size-3.5" />
                  {D.fromSource}
                </figcaption>
                <blockquote className="mt-1 font-serif text-body text-le-text">{f}</blockquote>
              </figure>
            ))}
            {d.interpretations.map((t) => (
              <Interpretation key={t} text={t} />
            ))}
            <Link href={`/threads/${d.thread_id}`} aria-label={`${D.openThread}: ${d.thread_title}`} className="focus-ring inline-flex min-h-11 items-center rounded-control text-body-strong text-le-accent underline-offset-4 hover:underline md:min-h-0">
              {D.openThread}
            </Link>
          </article>
        );
      })}
      {view.interpretations.map((t) => (
        <Interpretation key={t} text={t} />
      ))}
    </div>
  );
}

function Interpretation({ text }: { text: string }) {
  return (
    <div className="border-l-2 border-dashed border-le-border-strong pl-4">
      <p className="text-label text-le-text-secondary">{D.interpretation}</p>
      <p className="mt-1 text-body text-le-text-secondary">{text}</p>
    </div>
  );
}
