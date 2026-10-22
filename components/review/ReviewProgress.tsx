"use client";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { retryExtractionAction } from "@/app/review/[extractionId]/actions";
import { Spinner } from "@/components/auth/Spinner";
import { ErrorBanner } from "@/components/Notice";
import { Button, buttonVariants } from "@/components/ui/button";
import { EXTRACTION_SLOW_MESSAGE, apiError, type ApiError } from "@/lib/errors";
import type { ExtractionStage, ExtractionView } from "@/lib/extraction/service";
import type { SourceRef } from "@/lib/threads/view";
import { ReviewTray } from "./ReviewTray";

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
 * proposals, and the Review Tray (S3, components/review/ReviewTray.tsx).
 */
export function ReviewProgress({
  initial,
  timezone,
  nowIso,
  source,
}: {
  initial: ExtractionView;
  timezone: string;
  nowIso: string;
  source?: SourceRef | null;
}) {
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

  return <ReviewTray key={view.id} view={view} timezone={timezone} nowIso={nowIso} source={source} />;
}
