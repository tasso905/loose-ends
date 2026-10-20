"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Clock, Quote, Sparkle } from "lucide-react";
import {
  acceptProposalsAction,
  proposalsShownAction,
  rejectProposalsAction,
  undoRejectAction,
} from "@/app/review/[extractionId]/actions";
import { Spinner } from "@/components/auth/Spinner";
import { ErrorBanner } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { formatDue } from "@/lib/dates";
import { apiError, type ApiError } from "@/lib/errors";
import type { ExtractionView, ProposalView } from "@/lib/extraction/service";
import { canAccept, groupProposals, initialSelection, TRAY_COPY as C, trayProposals, type TrayBand } from "@/lib/review/tray";
import type { ReviewStatus, ThreadKind } from "@/lib/schemas";
import { threadKindFor } from "@/lib/threads/mapping";
import { parseInstant } from "@/lib/time";
import { cn } from "@/lib/utils";
import { ExplainBrief } from "./ExplainBrief";

/**
 * F6 Review Tray (SITE_CONTRACT §2.4; DESIGN_STANDARD product moments "Accept selected", "Reject").
 * Likely is pre-checked, Maybe unchecked, Also noticed collapsed and unchecked; Ignore and key_fact
 * never render. Every state change shown here comes from a server result (rule 10).
 *
 * Reject runs immediately and is stored (D8: a reversible action executes, then offers undo). The
 * card dims with an inline `Rejected · Undo` that stays until the tray is left; Undo reverses the
 * stored rejection on the server.
 */

type Busy = { kind: "accept" | "reject_all" } | { kind: "card"; id: string } | null;

const offlineOr = (code: "save_failed") => apiError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : code).error;

export function ReviewTray({ view, timezone, nowIso }: { view: ExtractionView; timezone: string; nowIso: string }) {
  const shown = useMemo(() => trayProposals(view.proposals), [view.proposals]);
  const [status, setStatus] = useState<Record<string, ReviewStatus>>(() =>
    Object.fromEntries(shown.map((p) => [p.id, p.reviewStatus])),
  );
  const [selected, setSelected] = useState<Set<string>>(() => initialSelection(shown, view.sourceId));
  const [acceptedOnLoad] = useState<Set<string>>(() => new Set(shown.filter((p) => p.reviewStatus !== "pending" && p.reviewStatus !== "rejected").map((p) => p.id)));
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<ApiError["error"] | null>(null);
  // Where focus goes after a reject or undo replaces the button that had it.
  const focusNext = useRef<string | null>(null);
  const [, startTransition] = useTransition();
  const shownOnce = useRef(false);

  const pendingIds = shown.filter((p) => status[p.id] === "pending").map((p) => p.id);
  const acceptedCount = shown.filter((p) => isAccepted(status[p.id])).length;
  const selectedPending = pendingIds.filter((id) => selected.has(id));

  useEffect(() => {
    if (shownOnce.current || pendingIds.length === 0) return;
    shownOnce.current = true;
    void proposalsShownAction(view.id).catch(() => undefined);
  }, [view.id, pendingIds.length]);

  function apply(ids: string[], next: ReviewStatus) {
    setStatus((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, next])) }));
    setSelected((sel) => {
      const out = new Set(sel);
      for (const id of ids) {
        if (next === "pending" && shown.find((p) => p.id === id)?.band === "high") out.add(id);
        else out.delete(id);
      }
      return out;
    });
  }

  function run(b: Exclude<Busy, null>, work: () => Promise<void>) {
    setError(null);
    setBusy(b);
    startTransition(async () => {
      try {
        await work();
      } catch {
        setError(offlineOr("save_failed"));
      } finally {
        setBusy(null);
      }
    });
  }

  const acceptSelected = () =>
    run({ kind: "accept" }, async () => {
      const res = await acceptProposalsAction(view.id, selectedPending);
      if (!res.ok) return setError(res.error);
      apply(res.accepted.map((a) => a.itemId), "accepted");
      if (res.invalid.length > 0) setError(apiError("invalid_transition").error);
    });

  const rejectAll = () =>
    run({ kind: "reject_all" }, async () => {
      const res = await rejectProposalsAction(view.id, pendingIds);
      if (!res.ok) return setError(res.error);
      apply(res.rejected, "rejected");
      if (res.invalid.length > 0) setError(apiError("invalid_transition").error);
    });

  const rejectOne = (id: string) =>
    run({ kind: "card", id }, async () => {
      const res = await rejectProposalsAction(view.id, [id]);
      if (!res.ok) return setError(res.error);
      apply(res.rejected, "rejected");
      if (res.rejected.includes(id)) focusNext.current = `undo-${id}`;
      if (res.invalid.length > 0) setError(apiError("invalid_transition").error);
    });

  const undoOne = (id: string) =>
    run({ kind: "card", id }, async () => {
      const res = await undoRejectAction(view.id, [id]);
      if (!res.ok) return setError(res.error);
      apply(res.restored, "pending");
      if (res.restored.includes(id)) focusNext.current = `reject-${id}`;
      if (res.invalid.length > 0) setError(apiError("invalid_transition").error);
    });

  useEffect(() => {
    if (!focusNext.current || busy) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  }, [status, busy]);

  if (shown.length === 0) {
    return (
      <div>
        <h1 className="text-display-sm text-le-text sm:text-display">{C.zero}</h1>
        <ExplainBrief brief={view.brief} className="mt-6" />
      </div>
    );
  }

  const groups = groupProposals(shown).filter((g) => g.items.some((p) => !acceptedOnLoad.has(p.id)));
  const anyBusy = busy !== null;
  const now = parseInstant(nowIso);

  return (
    <div>
      <h1 className="text-display-sm text-le-text sm:text-display">{C.heading(shown.length)}</h1>

      <div role="status" aria-live="polite" className="mt-3 empty:hidden">
        {acceptedCount > 0 ? (
          <p className="text-body text-le-text">
            {C.resultCount(acceptedCount)} ·{" "}
            <Link href="/today" className="focus-ring rounded-control text-le-accent underline underline-offset-3 hover:text-le-accent-hover">
              {C.viewInToday}
            </Link>
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="mt-6">
          <ErrorBanner>{error.message}</ErrorBanner>
        </div>
      ) : null}

      {groups.map((g) => {
        const list = (
          <ul className="mt-3 space-y-3">
            {g.items
              .filter((p) => !acceptedOnLoad.has(p.id))
              .map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  status={status[p.id] ?? p.reviewStatus}
                  checked={selected.has(p.id)}
                  acceptable={canAccept(p, view.sourceId)}
                  disabled={anyBusy}
                  working={busy?.kind === "card" && busy.id === p.id}
                  timezone={timezone}
                  now={now}
                  onCheck={(on) =>
                    setSelected((sel) => {
                      const out = new Set(sel);
                      if (on) out.add(p.id);
                      else out.delete(p.id);
                      return out;
                    })
                  }
                  onReject={() => rejectOne(p.id)}
                  onUndo={() => undoOne(p.id)}
                />
              ))}
          </ul>
        );
        return g.collapsed ? (
          <details key={g.band} className="mt-8">
            <summary className="focus-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-control text-h3 text-le-text md:min-h-0">
              <BandDot band={g.band} />
              {g.title} ({g.items.length})
            </summary>
            {list}
          </details>
        ) : (
          <section key={g.band} className="mt-8" aria-labelledby={`group-${g.band}`}>
            <h2 id={`group-${g.band}`} className="flex items-center gap-2 text-h3 text-le-text">
              <BandDot band={g.band} />
              {g.title}
            </h2>
            {list}
          </section>
        );
      })}

      {pendingIds.length > 0 ? (
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Button onClick={acceptSelected} disabled={anyBusy || selectedPending.length === 0} aria-describedby={selectedPending.length === 0 ? "accept-hint" : undefined}>
            {busy?.kind === "accept" ? <Spinner /> : null}
            {C.acceptSelected}
          </Button>
          <Button variant="secondary" onClick={rejectAll} disabled={anyBusy}>
            {busy?.kind === "reject_all" ? <Spinner /> : null}
            {C.rejectAll}
          </Button>
          {selectedPending.length === 0 ? (
            <p id="accept-hint" className="text-small text-le-text-secondary">
              {C.nothingSelected}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function isAccepted(s: ReviewStatus | undefined): boolean {
  return s === "accepted" || s === "edited" || s === "auto_created";
}

const KIND_LABEL: Record<ThreadKind, string> = {
  commitment: "Commitment",
  request: "Request",
  waiting_on: "Waiting on",
  admin: "Admin",
  decision: "Decision",
};

const DOT: Record<TrayBand, string> = {
  high: "bg-(--le-likely-dot)",
  medium: "bg-(--le-maybe-dot)",
  low: "border border-(--le-low-dot) bg-transparent",
};
const WORD: Record<TrayBand, string> = {
  high: "text-(--le-likely-fg)",
  medium: "text-(--le-maybe-fg)",
  low: "text-le-text-secondary",
};

function BandDot({ band }: { band: TrayBand }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[band])} />;
}

/** F19 label: dot + word + reason, so colour is never the only signal. */
export function ConfidenceLabel({ band, label }: { band: TrayBand; label: { word: string; reason: string } }) {
  return (
    <p className="flex flex-wrap items-center gap-x-1 text-small text-le-text-secondary">
      <BandDot band={band} />
      <span className={cn("text-label", WORD[band])}>{label.word}</span>
      <span>· {label.reason}</span>
    </p>
  );
}

interface CardProps {
  proposal: ProposalView;
  status: ReviewStatus;
  checked: boolean;
  acceptable: boolean;
  disabled: boolean;
  working: boolean;
  timezone: string;
  now: Date;
  onCheck: (on: boolean) => void;
  onReject: () => void;
  onUndo: () => void;
}

function ProposalCard({ proposal: p, status, checked, acceptable, disabled, working, timezone, now, onCheck, onReject, onUndo }: CardProps) {
  const { item, label, evidence, date, not_sure } = p.payload;
  const kind = threadKindFor(item.type, item.owner)?.kind;
  const accepted = isAccepted(status);
  const rejected = status === "rejected";
  const titleId = `title-${p.id}`;
  const hintId = `hint-${p.id}`;

  return (
    <li
      // Accepted: the card collapses (height + opacity at --dur-slow) and leaves the reading order.
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-(--le-dur-slow) ease-(--le-ease-out)",
        accepted ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
      )}
      aria-hidden={accepted || undefined}
      inert={accepted || undefined}
    >
      <div className="overflow-hidden">
        <div className="flex gap-3 rounded-card border border-le-border bg-le-surface p-4 sm:p-5">
          {/* 40px hit area (44px below 768px) around the 18px box (DESIGN_STANDARD "Checkbox"). */}
          <label className="-mt-2 -ml-3 flex size-10 shrink-0 cursor-pointer items-center justify-center max-md:size-11">
            {rejected ? null : (
              <input
                type="checkbox"
                className="focus-ring size-4.5 cursor-pointer accent-(--le-accent) disabled:cursor-not-allowed"
                checked={checked}
                disabled={!acceptable || disabled}
                onChange={(e) => onCheck(e.target.checked)}
                aria-labelledby={titleId}
                aria-describedby={acceptable ? undefined : hintId}
              />
            )}
          </label>

          <div className="min-w-0 flex-1">
            <div className={cn(rejected && "opacity-50")} aria-disabled={rejected || undefined}>
              <p id={titleId} className="text-body-strong text-le-text">
                {item.title}
              </p>
              {label ? (
                <div className="mt-1">
                  <ConfidenceLabel band={p.band} label={label} />
                </div>
              ) : null}
              <p className="mt-2 flex flex-wrap items-center gap-2 text-small text-le-text-secondary">
                {kind ? <span>{KIND_LABEL[kind]}</span> : null}
                {item.counterparty ? <span>· {item.counterparty}</span> : null}
                {date.due_at ? (
                  <span className="inline-flex h-6 items-center gap-1 rounded-control bg-le-surface-sunken px-2 text-label tabular-nums text-le-text-secondary">
                    <Clock aria-hidden strokeWidth={1.75} className="size-3.5" />
                    {formatDue(date.due_at, { timeKnown: date.due_time_known, timezone, now })}
                  </span>
                ) : null}
                {date.due_at && date.due_certainty === "inferred" ? (
                  <span
                    className="inline-flex h-6 items-center rounded-control border border-dotted border-le-border-strong px-2 text-label text-le-text-secondary"
                    title={date.reasoning ?? undefined}
                  >
                    {C.assumed}
                  </span>
                ) : null}
              </p>

              {item.action ? (
                <div className="mt-3 border-l-2 border-dashed border-le-border-strong pl-3">
                  <p className="flex items-center gap-1 text-label text-le-text-secondary">
                    <Sparkle aria-hidden strokeWidth={1.75} className="size-3.5" />
                    {C.suggested}
                  </p>
                  <p className="text-body text-le-text-secondary">{item.action}</p>
                </div>
              ) : null}

              {evidence[0] ? (
                <figure className="mt-3 rounded-r-control border-l-2 border-(--le-evidence-rule) bg-(--le-evidence-bg) px-4 py-3">
                  <figcaption className="flex items-center gap-1 text-label text-le-text-secondary">
                    <Quote aria-hidden strokeWidth={1.75} className="size-3.5" />
                    Pasted text
                  </figcaption>
                  <blockquote className="mt-1 font-serif text-body text-le-text">{evidence[0].quote}</blockquote>
                </figure>
              ) : null}

              {not_sure.length > 0 ? (
                <div className="mt-3 rounded-control bg-(--le-maybe-bg) px-4 py-3">
                  <p className="text-eyebrow text-le-text-secondary uppercase">{C.notSureAbout}</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-small text-le-text">
                    {not_sure.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {!acceptable && !rejected ? (
                <p id={hintId} className="mt-3 text-small text-le-text-secondary">
                  {C.cannotAcceptWaiting}
                </p>
              ) : null}
            </div>

            <div className="mt-3 flex items-center gap-2">
              {rejected ? (
                <p className="flex items-center gap-1 text-small text-le-text">
                  <span>{C.rejected} ·</span>
                  <Button id={`undo-${p.id}`} variant="ghost" size="small" onClick={onUndo} disabled={disabled} aria-label={`${C.undo} reject: ${item.title}`}>
                    {working ? <Spinner /> : null}
                    {C.undo}
                  </Button>
                </p>
              ) : (
                <Button id={`reject-${p.id}`} variant="ghost" size="small" onClick={onReject} disabled={disabled} aria-label={`${C.reject}: ${item.title}`}>
                  {working ? <Spinner /> : null}
                  {C.reject}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

