"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { CircleHelp, Loader2, PenLine, Quote } from "lucide-react";
import { whyAction } from "@/app/threads/[id]/actions";
import { ErrorBanner } from "@/components/Notice";
import { ConfidenceLabel } from "@/components/review/ReviewTray";
import { Button, buttonVariants } from "@/components/ui/button";
import { WHY_COPY as W, type WhyView } from "@/lib/threads/why";
import { cn } from "@/lib/utils";

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; view: WhyView };

/**
 * F8 `Why?` link + Why sheet (SITE_CONTRACT §2.8 and §3.1, CONTENT_MODEL §7, DESIGN_STANDARD "Why
 * sheet"). The link works without JavaScript (`/threads/{id}?panel=why`); with it, the sheet opens
 * in place: a level-3 modal, a 440 px side sheet from 768 px up and a bottom sheet (max 85vh)
 * below. Its content comes from whyAction, which fills fixed templates from stored fields (rule 6).
 * Loading shows an inline spinner; a failure shows `Couldn't load this explanation.` + Try again.
 * Escape, Close and the scrim close it, and focus returns to the `Why?` link (§3.1).
 *
 * `This is wrong` links to Thread detail, where Edit and Dismiss now are (S12); the in-panel choice
 * of Edit or Dismiss (§2.8) and its `marked_wrong` event are not built yet. `Open source` is left
 * out until the Source viewer (/sources/[id]) exists; a deleted source shows its line instead.
 */
export function WhyLink({
  threadId,
  surface,
  autoOpen = false,
  className,
  describedBy,
}: {
  threadId: string;
  surface: "today" | "detail";
  /** Thread detail with `?panel=why`: open on load. */
  autoOpen?: boolean;
  className?: string;
  /** Id of the element naming the thread (Today rows: the title link), so each `Why?` says which thread it explains. */
  describedBy?: string;
}) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(autoOpen);
  const fromUrl = useRef(autoOpen);

  const close = useCallback(() => {
    setOpen(false);
    if (fromUrl.current) {
      // Drop `?panel=why` so a refresh does not reopen the sheet.
      fromUrl.current = false;
      const url = new URL(window.location.href);
      url.searchParams.delete("panel");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
  }, []);

  const href = `/threads/${threadId}?panel=why`;
  return (
    <>
      <a
        ref={linkRef}
        href={href}
        aria-haspopup="dialog"
        aria-describedby={describedBy}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          setOpen(true);
        }}
        className={cn(
          "focus-ring inline-flex items-center gap-1 rounded-control text-small text-le-accent underline-offset-2 hover:underline max-md:min-h-11",
          className,
        )}
      >
        <CircleHelp aria-hidden strokeWidth={1.75} className="size-3.5" />
        {W.why}
      </a>
      <WhySheet threadId={threadId} surface={surface} open={open} onClose={close} returnFocus={linkRef} />
    </>
  );
}

function WhySheet({
  threadId,
  surface,
  open,
  onClose,
  returnFocus,
}: {
  threadId: string;
  surface: "today" | "detail";
  open: boolean;
  onClose: () => void;
  returnFocus: React.RefObject<HTMLAnchorElement | null>;
}) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const request = useRef(0);

  const load = useCallback(() => {
    const n = ++request.current;
    setState({ kind: "loading" });
    whyAction(threadId, surface)
      .then((res) => {
        if (n !== request.current) return;
        setState(res.ok ? { kind: "ready", view: res.view } : { kind: "error" });
      })
      .catch(() => {
        if (n === request.current) setState({ kind: "error" });
      });
  }, [threadId, surface]);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      closeRef.current?.focus();
      load();
    } else if (!open && d.open) {
      d.close();
      returnFocus.current?.focus();
    }
  }, [open, load, returnFocus]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-busy={state.kind === "loading"}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the scrim (outside the panel) closes the sheet.
        if (e.target === e.currentTarget) onClose();
      }}
      className={cn(
        "bg-le-surface-raised p-0 text-le-text shadow-(--le-shadow-modal) backdrop:bg-(--le-scrim)",
        // From 768 px: a full-height side sheet on the right.
        "md:my-0 md:mr-0 md:ml-auto md:h-dvh md:max-h-dvh md:w-full md:max-w-sheet",
        // Below 768 px: a bottom sheet, at most 85% of the viewport tall (DESIGN_STANDARD, §3.4).
        "max-md:mx-0 max-md:mt-auto max-md:mb-0 max-md:max-h-[85vh] max-md:w-full max-md:max-w-none max-md:rounded-t-modal",
      )}
    >
      {open ? (
        <div className="flex h-full max-h-[inherit] flex-col">
          <div className="flex items-start justify-between gap-4 px-6 pt-6">
            <h3 id={titleId} className="text-h3 text-le-text">
              {W.title}
            </h3>
            <Button ref={closeRef} variant="ghost" size="small" onClick={onClose}>
              {W.close}
            </Button>
          </div>
          {/* The one nested scroll region besides the Source viewer (SITE_CONTRACT §3.2). */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
            {state.kind === "loading" ? (
              <p role="status" className="flex items-center gap-2 text-small text-le-text-secondary">
                <Loader2 aria-hidden strokeWidth={1.75} className="animate-spin-status size-4" />
                <span className="sr-only">{W.loading}</span>
              </p>
            ) : state.kind === "error" ? (
              <ErrorBanner
                action={
                  <Button variant="secondary" size="small" onClick={load}>
                    {W.tryAgain}
                  </Button>
                }
              >
                {W.loadFailed}
              </ErrorBanner>
            ) : (
              <WhyBody view={state.view} />
            )}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

function WhyBody({ view: v }: { view: WhyView }) {
  return (
    <div className="space-y-5">
      {v.quote ? (
        <figure>
          <div className="relative rounded-control bg-le-surface-raised">
            <p className={cn("font-serif text-body whitespace-pre-wrap text-le-text-secondary", v.quote.clippedBefore && "pt-2", v.quote.clippedAfter && "pb-2")}>
              {v.quote.clippedBefore ? <span aria-hidden>…</span> : null}
              {v.quote.before}
              <mark data-testid="why-quote" className="bg-(--le-highlight) text-le-text">
                {v.quote.quote}
              </mark>
              {v.quote.after}
              {v.quote.clippedAfter ? <span aria-hidden>…</span> : null}
            </p>
            {/* 32 px fade masks: the source goes on above / below (DESIGN_STANDARD Gradients). */}
            {v.quote.clippedBefore ? (
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-linear-to-t from-transparent to-le-surface-raised" />
            ) : null}
            {v.quote.clippedAfter ? (
              <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-b from-transparent to-le-surface-raised" />
            ) : null}
          </div>
          {v.caption ? (
            <figcaption className="mt-2 flex items-center gap-1 text-small text-le-text-secondary">
              <Quote aria-hidden strokeWidth={1.75} className="size-3.5" />
              {v.caption}
            </figcaption>
          ) : null}
        </figure>
      ) : (
        <p className="text-small text-le-text-secondary">{W.noQuote}</p>
      )}

      {v.origin ? <ConfidenceLabel band={v.origin.band} label={v.origin.label} /> : null}

      {v.steps.length > 0 ? (
        <ul className="space-y-2 text-body text-le-text">
          {v.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : null}

      {v.notSure.length > 0 ? (
        <div className="rounded-control bg-(--le-maybe-bg) px-4 py-3">
          <h4 className="text-eyebrow text-le-text-secondary uppercase">{W.notSure}</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-small text-le-text">
            {v.notSure.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p data-testid="why-now" className="text-body-strong text-le-text">
        {v.whyNow}
      </p>

      {v.corrections.length > 0 ? (
        <figure className="border-l-2 border-le-border-strong pl-4">
          <figcaption className="flex items-center gap-1 text-label text-le-text-secondary">
            <PenLine aria-hidden strokeWidth={1.75} className="size-3.5" />
            {W.corrections}
          </figcaption>
          <ul className="mt-1 space-y-1 text-body text-le-text">
            {v.corrections.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </figure>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
        {/* This is wrong opens the thread, where Edit and Dismiss are (S12). */}
        <Link href={`/threads/${v.threadId}`} className={buttonVariants({ variant: "secondary", size: "small" })}>
          {W.thisIsWrong}
        </Link>
        {v.sourceDeleted ? <p className="text-small text-le-text-tertiary">{v.sourceDeleted}</p> : null}
      </div>
    </div>
  );
}
