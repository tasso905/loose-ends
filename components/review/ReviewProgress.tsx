"use client";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Quote } from "lucide-react";
import { retryExtractionAction } from "@/app/review/[extractionId]/actions";
import { Spinner } from "@/components/auth/Spinner";
import { ErrorBanner } from "@/components/Notice";
import { Button, buttonVariants } from "@/components/ui/button";
import { EXTRACTION_SLOW_MESSAGE, apiError, type ApiError } from "@/lib/errors";
import type { ExtractionStage, ExtractionView, ProposalView } from "@/lib/extraction/service";
import { threadKindFor } from "@/lib/threads/mapping";
import type { ThreadKind } from "@/lib/schemas";
import { cn } from "@/lib/utils";

/** Real pipeline steps, shown only as the server reports each one (SITE_CONTRACT §2.3, A1). */
export const STAGE_COPY: Record<ExtractionStage, string> = {
  reading: "Reading…",
  finding: "Finding commitments…",
  checking: "Checking dates…",
};

const POLL_MS = 1000;

/**
 * Extraction progress → result on /review/[extractionId]. Polls GET /api/extractions/:id while the
 * extraction is running, so the page survives refresh and can be left and revisited. States:
 * staged progress + skeleton cards, slow (45 s), failure (`Try again`, `Back to Add`), zero
 * proposals, and the persisted proposals. The interactive Review Tray (accept/reject) is S3.
 */
export function ReviewProgress({ initial }: { initial: ExtractionView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [retryError, setRetryError] = useState<ApiError["error"] | null>(null);
  const [retrying, startRetry] = useTransition();

  useEffect(() => {
    if (view.status !== "running") return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/extractions/${view.id}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) {
          router.refresh();
          return;
        }
        if (res.ok) {
          setView((await res.json()) as ExtractionView);
          return;
        }
      } catch {
        // Offline or a transient error: keep the current state and poll again.
      }
      if (!cancelled) setView((v) => ({ ...v }));
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [view, router]);

  function retry() {
    setRetryError(null);
    startRetry(async () => {
      try {
        const res = await retryExtractionAction(view.id);
        if (res.ok) {
          // A new attempt exists (rule 10); its progress page takes over.
          router.replace(`/review/${res.extractionId}`);
          return;
        }
        setRetryError(res.error);
      } catch {
        setRetryError(apiError(navigator.onLine ? "save_failed" : "offline").error);
      }
    });
  }

  if (view.status === "failed") {
    return (
      <div className="space-y-4">
        <h1 className="sr-only">Review source</h1>
        <ErrorBanner
          action={
            <div className="flex flex-wrap gap-2">
              {/* Hidden once the newest attempt has used the Try again cap (MAX_RETRIES_PER_SOURCE). */}
              {view.retryAvailable && retryError?.retryable !== false ? (
                <Button variant="secondary" size="small" onClick={retry} disabled={retrying}>
                  {retrying ? <Spinner /> : null}
                  Try again
                </Button>
              ) : null}
              <Link href="/add" className={buttonVariants({ variant: "ghost", size: "small" })}>
                Back to Add
              </Link>
            </div>
          }
        >
          {(view.error ?? apiError("extraction_failed").error).message}
        </ErrorBanner>
        {retryError ? <ErrorBanner>{retryError.message}</ErrorBanner> : null}
      </div>
    );
  }

  if (view.status === "running") {
    return (
      <div>
        <h1 className="sr-only">Review source</h1>
        <div role="status" aria-live="polite" className="space-y-1">
          <p key={view.stage ?? "reading"} className="animate-fade-in text-h2 text-le-text">
            {STAGE_COPY[view.stage ?? "reading"]}
          </p>
          {view.slow ? <p className="text-body text-le-text-secondary">{EXTRACTION_SLOW_MESSAGE}</p> : null}
        </div>
        <div aria-hidden className="mt-6 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-skeleton rounded-card border border-le-border bg-le-surface p-4 sm:p-5">
              <div className="h-3 w-full rounded-control bg-le-surface-sunken" />
              <div className="mt-3 h-3 w-4/5 rounded-control bg-le-surface-sunken" />
              <div className="mt-3 h-3 w-3/5 rounded-control bg-le-surface-sunken" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const n = view.proposals.length;
  if (n === 0) {
    return <h1 className="text-display-sm text-le-text sm:text-display">Nothing here needs your attention</h1>;
  }

  const groups: Array<{ band: ProposalView["band"]; title: string }> = [
    { band: "high", title: "Likely" },
    { band: "medium", title: "Maybe" },
    { band: "low", title: "Also noticed" },
  ];

  return (
    <div>
      <h1 className="text-display-sm text-le-text sm:text-display">
        I found {n} {n === 1 ? "thing" : "things"} in this
      </h1>
      {groups.map(({ band, title }) => {
        const items = view.proposals.filter((p) => p.band === band);
        if (items.length === 0) return null;
        const list = (
          <ul className="mt-3 space-y-3">
            {items.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))}
          </ul>
        );
        // Also noticed is collapsed by default (D3).
        return band === "low" ? (
          <details key={band} className="mt-8">
            <summary className="focus-ring flex min-h-11 cursor-pointer items-center rounded-control text-h3 text-le-text md:min-h-0">
              {title} ({items.length})
            </summary>
            {list}
          </details>
        ) : (
          <section key={band} className="mt-8" aria-labelledby={`group-${band}`}>
            <h2 id={`group-${band}`} className="text-h3 text-le-text">
              {title}
            </h2>
            {list}
          </section>
        );
      })}
    </div>
  );
}

const KIND_LABEL: Record<ThreadKind, string> = {
  commitment: "Commitment",
  request: "Request",
  waiting_on: "Waiting on",
  admin: "Admin",
  decision: "Decision",
};

const DOT: Record<ProposalView["band"], string> = {
  high: "bg-(--le-likely-dot)",
  medium: "bg-(--le-maybe-dot)",
  low: "border border-(--le-low-dot) bg-transparent",
};
const WORD: Record<ProposalView["band"], string> = {
  high: "text-(--le-likely-fg)",
  medium: "text-(--le-maybe-fg)",
  low: "text-le-text-secondary",
};

/** Read-only proposal card from stored fields (A11). Accept, edit and reject arrive with S3. */
function ProposalCard({ proposal }: { proposal: ProposalView }) {
  const { item, label, evidence } = proposal.payload;
  const kind = threadKindFor(item.type, item.owner)?.kind;
  return (
    <li className="rounded-card border border-le-border bg-le-surface p-4 sm:p-5">
      <p className="text-body-strong text-le-text">{item.title}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-1 text-small text-le-text-secondary">
        <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[proposal.band])} />
        <span className={cn("text-label", WORD[proposal.band])}>{label?.word}</span>
        {label?.reason ? <span>· {label.reason}</span> : null}
        {kind ? <span>· {KIND_LABEL[kind]}</span> : null}
      </p>
      {evidence[0] ? (
        <figure className="mt-3 rounded-r-control border-l-2 border-(--le-evidence-rule) bg-(--le-evidence-bg) px-4 py-3">
          <figcaption className="flex items-center gap-1 text-label text-le-text-secondary">
            <Quote aria-hidden strokeWidth={1.75} className="size-3.5" />
            Pasted text
          </figcaption>
          <blockquote className="mt-1 font-serif text-body text-le-text">{evidence[0].quote}</blockquote>
        </figure>
      ) : null}
    </li>
  );
}
