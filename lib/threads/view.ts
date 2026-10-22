import { formatInTimeZone } from "date-fns-tz";
import type { ThreadEventType, ThreadKind, ThreadStatus } from "@/lib/schemas";
import { parseInstant } from "@/lib/time";

/**
 * Pure view rules for the Threads index, Thread detail and the interim Today list (SITE_CONTRACT
 * §2.5–§2.7, CONTENT_MODEL §5–§6). No I/O; the pages and the unit tests share them.
 */

export type ThreadFilter = "active" | "closed";

/** D7: Active = Open, Waiting, Snoozed; Closed = Resolved, Dismissed. */
export const FILTER_STATUSES: Record<ThreadFilter, ThreadStatus[]> = {
  active: ["open", "waiting", "snoozed"],
  closed: ["resolved", "dismissed"],
};

/** `?filter=` → filter; anything else is the default, Active (SITE_CONTRACT §1.2). */
export function parseFilter(raw: string | string[] | undefined): ThreadFilter {
  return (Array.isArray(raw) ? raw[0] : raw) === "closed" ? "closed" : "active";
}

/** CONTENT_MODEL §6 status words; overdue is never a status (D2). */
export const STATUS_LABEL: Record<ThreadStatus, string> = {
  open: "Open",
  waiting: "Waiting",
  snoozed: "Snoozed",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

/** Loop type: the same values as the Review Tray. */
export const KIND_LABEL: Record<ThreadKind, string> = {
  commitment: "Commitment",
  request: "Request",
  waiting_on: "Waiting on",
  admin: "Admin",
  decision: "Decision",
};

export interface ListRow {
  id: string;
  status: ThreadStatus;
  due_at: string | null;
  resolved_at: string | null;
  updated_at: string;
  created_at: string;
}

const time = (s: string | null) => (s === null ? null : parseInstant(s).getTime());

/**
 * SITE_CONTRACT §2.6 sort. Active: due date ascending, undated last (ties: oldest first). Closed:
 * resolved/dismissed date, newest first. A dismissed thread has no resolved_at, so its last update
 * (the dismissal) stands in.
 */
export function sortThreads<T extends ListRow>(rows: T[], filter: ThreadFilter): T[] {
  const out = [...rows];
  if (filter === "active") {
    out.sort((a, b) => {
      const da = time(a.due_at);
      const db = time(b.due_at);
      if (da !== db) return da === null ? 1 : db === null ? -1 : da - db;
      return time(a.created_at)! - time(b.created_at)! || a.id.localeCompare(b.id);
    });
  } else {
    const closedAt = (r: T) => time(r.status === "resolved" && r.resolved_at ? r.resolved_at : r.updated_at)!;
    out.sort((a, b) => closedAt(b) - closedAt(a) || a.id.localeCompare(b.id));
  }
  return out;
}

/** Whether Done is offered (D6: never on decision threads; only on Active threads). */
export function canMarkDone(t: { status: ThreadStatus; kind: ThreadKind }): boolean {
  return FILTER_STATUSES.active.includes(t.status) && t.kind !== "decision";
}

/** History timestamp: "Oct 18, 9:42 AM" in the user's timezone (DESIGN_STANDARD "Dates and numbers"). */
export function formatHistoryTime(iso: string, timezone: string): string {
  return formatInTimeZone(parseInstant(iso), timezone, "MMM d, h:mm a");
}

/** "Until Fri Oct 9" for snoozed rows: a date, never a time (snooze presets are all 9:00). */
export function formatUntil(iso: string, timezone: string): string {
  return `Until ${formatInTimeZone(parseInstant(iso), timezone, "EEE MMM d")}`;
}

export interface HistoryEvent {
  type: ThreadEventType | string;
  actor: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * One history line per event. Approved copy (user, Oct 21; not yet in SITE_CONTRACT / CONTENT_MODEL); corrections
 * ("You changed …") arrive with Edit. Unknown types fall back to a neutral line.
 */
export function historyLine(e: HistoryEvent): string {
  const actor = e.actor === "system" ? "Loose Ends" : "You";
  switch (e.type) {
    case "created":
      return e.after?.via === "auto_create" ? "Added from quick add." : "You accepted this from your source.";
    case "resolved":
      return e.after?.resolution === "done" ? `${actor} marked this done.` : `${actor} resolved this.`;
    case "undone":
      return "You undid the last change.";
    case "reopened":
      return "You reopened this.";
    case "snoozed":
      return "You snoozed this.";
    case "edited":
      return "You edited this.";
    case "status_changed":
      return `Status changed to ${STATUS_LABEL[e.after?.status as ThreadStatus] ?? "a new status"}.`;
    default:
      return "Updated.";
  }
}

/** Copy for these pages. Strings marked Approved were signed off by the user Oct 21 and are not in the docs yet. */
export const THREADS_COPY = {
  heading: "Threads",
  active: "Active",
  closed: "Closed",
  /** CONTENT_MODEL §5. */
  emptyActive: "No open threads.",
  emptyActiveLine: "Add something to get started.",
  emptyClosed: "Nothing closed yet.",
  /** SITE_CONTRACT §2.5 Today empty-state action, reused. */
  addSomething: "Add something",
  done: "Done",
  resolve: "Resolve…",
  undo: "Undo",
  refresh: "Refresh",
  tryAgain: "Try again",
  /** Approved (Oct 21): the Done undo toast message. */
  doneToast: (title: string) => `Marked done: "${title}"`,
  /** Approved (Oct 21): why Resolve… is disabled until F11 ships. */
  resolveUnavailable: "Resolving with a decision isn't available yet.",
  /** Approved (Oct 21): page banner when a list or thread fails to load. */
  loadFailed: "I couldn't load your threads.",
  evidence: "Evidence",
  history: "History",
  nextAction: "Next action",
  /** SITE_CONTRACT §1.2. */
  notFound: "This thread doesn't exist or was deleted.",
  goToToday: "Go to Today",
  /** Interim Today (Approved Oct 21, replaced by F10). */
  todayEmpty: "Nothing needs you right now.",
  todayListLabel: "Active threads",
} as const;
