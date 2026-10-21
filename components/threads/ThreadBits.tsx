import Link from "next/link";
import { Circle, CircleCheck, CircleSlash, Clock, Hourglass, Moon, type LucideIcon } from "lucide-react";
import { formatDue } from "@/lib/dates";
import type { DueCertainty, ThreadStatus } from "@/lib/schemas";
import { STATUS_LABEL, formatUntil } from "@/lib/threads/view";
import { cn } from "@/lib/utils";

/** Status icon + word (Iconography map); colour is never the only signal. */
const STATUS_ICON: Record<ThreadStatus, LucideIcon> = {
  open: Circle,
  waiting: Hourglass,
  snoozed: Moon,
  resolved: CircleCheck,
  dismissed: CircleSlash,
};

export function StatusChip({ status, className }: { status: ThreadStatus; className?: string }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className={cn("inline-flex items-center gap-1 text-label text-le-text-secondary", className)}>
      <Icon aria-hidden strokeWidth={1.75} className="size-3.5" />
      {STATUS_LABEL[status]}
    </span>
  );
}

const chip = "inline-flex h-6 items-center gap-1 rounded-control px-2 text-label tabular-nums text-le-text-secondary";

/** Due chip (Clock + date, tabular figures) plus the dotted `Assumed` chip for inferred dates. */
export function DueChip(props: { dueAt: string | null; certainty: DueCertainty; timeKnown: boolean; timezone: string; now: Date }) {
  if (!props.dueAt) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={cn(chip, "bg-le-surface-sunken")}>
        <Clock aria-hidden strokeWidth={1.75} className="size-3.5" />
        {formatDue(props.dueAt, { timeKnown: props.timeKnown, timezone: props.timezone, now: props.now })}
      </span>
      {props.certainty === "inferred" ? <span className={cn(chip, "border border-dotted border-le-border-strong")}>Assumed</span> : null}
    </span>
  );
}

export interface RowThread {
  id: string;
  title: string;
  status: ThreadStatus;
  due_at: string | null;
  due_certainty: DueCertainty;
  due_time_known: boolean;
  snoozed_until: string | null;
}

/**
 * Thread row (SITE_CONTRACT §2.6): status icon + word, title, due chip; snoozed rows show
 * `Until {date}`. Closed rows carry no due chip, so a finished thread never reads as overdue.
 */
export function ThreadRow({ t, timezone, now, showStatus = true }: { t: RowThread; timezone: string; now: Date; showStatus?: boolean }) {
  const active = t.status === "open" || t.status === "waiting" || t.status === "snoozed";
  return (
    <li>
      <Link
        href={`/threads/${t.id}`}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-le-border bg-le-surface px-4 py-3 transition-colors duration-(--le-dur-fast) ease-(--le-ease-out) hover:bg-le-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-le-accent max-md:min-h-11"
      >
        {showStatus ? <StatusChip status={t.status} className="w-24 shrink-0" /> : null}
        <span className="min-w-0 flex-1 text-body-strong text-le-text">{t.title}</span>
        {t.status === "snoozed" && t.snoozed_until ? (
          <span className={cn(chip, "bg-le-surface-sunken")}>{formatUntil(t.snoozed_until, timezone)}</span>
        ) : active ? (
          <DueChip dueAt={t.due_at} certainty={t.due_certainty} timeKnown={t.due_time_known} timezone={timezone} now={now} />
        ) : null}
      </Link>
    </li>
  );
}
