import { apiError, type ApiError } from "@/lib/errors";
import { Resolution as ResolutionSchema, type Actor, type DueCertainty, type Resolution, type Thread, type ThreadEventType, type ThreadKind, type ThreadStatus } from "@/lib/schemas";
import { getNow } from "@/lib/time";

/**
 * The single place thread status changes happen (CLAUDE.md engineering conventions).
 * Implements exactly the PRD "Lifecycle transitions" table (v1.1, incl. D6), plus the `undo` of
 * D44 option (a) (approved Oct 21: 8 s toast + 4 s server grace), kept in its own branch. Anything else
 * returns `invalid_transition`. Pure: the caller persists the new state, appends the
 * returned `thread_events` row and applies the effects.
 */

/** The parts of a thread the lifecycle reads and writes (DB shape: ISO strings for instants). */
export type ThreadState = Pick<
  Thread,
  | "title"
  | "kind"
  | "next_action"
  | "counterparty"
  | "due_at"
  | "due_certainty"
  | "due_time_known"
  | "consequence"
  | "consequence_basis"
  | "status"
  | "resolution"
  | "waiting_on"
  | "expected_by"
  | "snoozed_until"
  | "resolved_at"
  | "primary_source_id"
  | "confidence"
>;

/** Fields the user can change with Edit. Lifecycle fields change only through their actions. */
export type EditableFields = Partial<
  Pick<ThreadState, "title" | "kind" | "next_action" | "counterparty" | "due_at" | "due_time_known" | "consequence"> & {
    /** Only while status = waiting. */
    waiting_on: string;
    /** Only while status = waiting. */
    expected_by: string | null;
    /** Only while status = snoozed. */
    snoozed_until: string;
  }
>;

export interface CreateFields {
  title: string;
  kind: ThreadKind;
  next_action: string | null;
  counterparty: string | null;
  due_at: string | null;
  due_certainty: DueCertainty;
  due_time_known: boolean;
  consequence: string | null;
  consequence_basis: "source" | "interpretation" | null;
  /** Required when kind = waiting_on (the thread starts as `waiting`). */
  waiting_on: string | null;
  expected_by: string | null;
  primary_source_id: string | null;
  confidence: number | null;
}

export type ThreadAction =
  | { type: "create"; via: "accept" | "edit_accept" | "auto_create"; extractionItemId: string | null; fields: CreateFields }
  | { type: "mark_waiting"; waitingOn: string; expectedBy?: string | null }
  | { type: "snooze"; until: string }
  | { type: "done" }
  | { type: "resolve"; resolution: Resolution }
  | { type: "dismiss" }
  | { type: "back_to_me" }
  | { type: "wake" }
  | { type: "reopen" }
  | { type: "edit"; fields: EditableFields }
  | { type: "forget"; alsoDeleteSource?: boolean }
  | { type: "undo"; target: UndoTarget };

/**
 * The event an Undo reverses (D44 option a, approved Oct 21). The caller reads it
 * from `thread_events`; `latest` says whether it is the thread's newest event.
 */
export interface UndoTarget {
  id: number;
  type: ThreadEventType;
  actor: Actor;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** ISO instant the event was written (getNow() on the server). */
  created_at: string;
  latest: boolean;
}

/** D8, D44 (a): the undo toast lasts 8 s (it pauses while hovered or focused). */
export const UNDO_WINDOW_MS = 8_000;
/**
 * D44 (a), approved Oct 21: the server accepts an Undo up to 4 s past the toast's 8 s, so a short
 * pause and the round trip are not refused. Mirrored by private.thread_undo_unguarded (12 s).
 */
export const UNDO_GRACE_MS = 4_000;

/**
 * Event types an Undo may reverse. Only Done exists so far (S4); mirrored by public.thread_undo().
 * Each reversible action joins this list when it ships, with its effects reversed too (Dismiss must
 * delete its suppression; Resolve as Decided must delete its decision row).
 */
export const UNDOABLE_EVENT_TYPES: ReadonlyArray<ThreadEventType> = ["resolved"];

/** Every ThreadState key; Undo restores only these. */
export const THREAD_STATE_KEYS: ReadonlyArray<keyof ThreadState> = [
  "title",
  "kind",
  "next_action",
  "counterparty",
  "due_at",
  "due_certainty",
  "due_time_known",
  "consequence",
  "consequence_basis",
  "status",
  "resolution",
  "waiting_on",
  "expected_by",
  "snoozed_until",
  "resolved_at",
  "primary_source_id",
  "confidence",
];

export type ThreadActionType = ThreadAction["type"];

export interface TransitionContext {
  actor?: Actor;
  now?: Date;
}

export type TransitionEffect =
  | { type: "write_suppression" }
  | { type: "delete_suppression" }
  | { type: "delete_thread"; alsoDeleteSource: boolean };

export interface EventDraft {
  type: ThreadEventType;
  actor: Actor;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export type TransitionResult =
  | { ok: true; thread: ThreadState | null; event: EventDraft | null; effects: TransitionEffect[] }
  | ({ ok: false } & ApiError);

/** From-statuses allowed per action, straight from the PRD table. `null` = no thread yet (proposal). */
export const ALLOWED_FROM: Record<ThreadActionType, ReadonlyArray<ThreadStatus | null>> = {
  create: [null],
  mark_waiting: ["open"],
  snooze: ["open"],
  done: ["open", "waiting", "snoozed"],
  resolve: ["open", "waiting", "snoozed"],
  dismiss: ["open", "waiting", "snoozed"],
  back_to_me: ["waiting"],
  wake: ["snoozed"],
  reopen: ["resolved", "dismissed"],
  edit: ["open", "waiting", "snoozed", "resolved", "dismissed"],
  forget: ["open", "waiting", "snoozed", "resolved", "dismissed"],
  // D44 (a), approved Oct 21: what it restores depends on the undone event.
  undo: ["open", "waiting", "snoozed", "resolved", "dismissed"],
};

/**
 * Who may perform each action. The AI never acts on the world (PRD "Explicit non-behaviors"):
 * it may only create through quick-add auto-create (`via: "auto_create"`, with undo) and edit
 * fields, and any date it sets is `inferred`. `auto_create` is never a user action.
 * The system actor only wakes a snoozed thread when its date is reached.
 */
export const ALLOWED_ACTORS: Record<ThreadActionType, ReadonlyArray<Actor>> = {
  create: ["user", "ai"],
  mark_waiting: ["user"],
  snooze: ["user"],
  done: ["user"],
  resolve: ["user"],
  dismiss: ["user"],
  back_to_me: ["user"],
  wake: ["user", "system"],
  reopen: ["user"],
  edit: ["user", "ai"],
  forget: ["user"],
  undo: ["user"],
};

const invalid = (): TransitionResult => ({ ok: false, ...apiError("invalid_transition") });

const nonEmpty = (s: string | null | undefined): s is string => typeof s === "string" && s.trim().length > 0;

const validInstant = (s: string | null | undefined): s is string =>
  typeof s === "string" && !Number.isNaN(new Date(s).getTime());

/** before/after hold only the fields that changed. */
function diff(before: ThreadState, after: ThreadState): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof ThreadState)[]) {
    if (before[key] !== after[key]) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a };
}

function changed(
  before: ThreadState,
  after: ThreadState,
  type: ThreadEventType,
  actor: Actor,
  effects: TransitionEffect[] = [],
): TransitionResult {
  const d = diff(before, after);
  return { ok: true, thread: after, event: { type, actor, before: d.before, after: d.after }, effects };
}

export function transition(thread: ThreadState | null, action: ThreadAction, ctx: TransitionContext = {}): TransitionResult {
  const actor = ctx.actor ?? "user";
  const now = ctx.now ?? getNow();
  const nowIso = now.toISOString();
  const from = thread?.status ?? null;

  if (!ALLOWED_FROM[action.type].includes(from)) return invalid();
  if (!ALLOWED_ACTORS[action.type].includes(actor)) return invalid();
  // Only quick add creates threads without review (F4, D9), and that is the only create the AI does.
  if (action.type === "create" && (action.via === "auto_create") !== (actor === "ai")) return invalid();

  if (action.type === "create") {
    const f = action.fields;
    if (!nonEmpty(f.title)) return invalid();
    const status: ThreadStatus = f.kind === "waiting_on" ? "waiting" : "open";
    if (status === "waiting" && !nonEmpty(f.waiting_on)) return invalid();
    const created: ThreadState = {
      title: f.title,
      kind: f.kind,
      next_action: f.next_action,
      counterparty: f.counterparty,
      due_at: f.due_at,
      due_certainty: f.due_at ? f.due_certainty : "none",
      due_time_known: f.due_at ? f.due_time_known : false,
      consequence: f.consequence,
      consequence_basis: f.consequence ? f.consequence_basis : null,
      status,
      resolution: null,
      waiting_on: status === "waiting" ? f.waiting_on : null,
      expected_by: status === "waiting" ? f.expected_by : null,
      snoozed_until: null,
      resolved_at: null,
      primary_source_id: f.primary_source_id,
      confidence: f.confidence,
    };
    return {
      ok: true,
      thread: created,
      event: {
        type: "created",
        actor,
        before: null,
        after: { ...created, via: action.via, extraction_item_id: action.extractionItemId },
      },
      effects: [],
    };
  }

  // Every other action needs an existing thread (guaranteed by ALLOWED_FROM).
  const t = thread as ThreadState;

  switch (action.type) {
    case "mark_waiting": {
      if (!nonEmpty(action.waitingOn)) return invalid();
      const expectedBy = action.expectedBy ?? null;
      if (expectedBy !== null && !validInstant(expectedBy)) return invalid();
      return changed(t, { ...t, status: "waiting", waiting_on: action.waitingOn, expected_by: expectedBy }, "status_changed", actor);
    }

    case "snooze": {
      if (!validInstant(action.until) || new Date(action.until) <= now) return invalid();
      return changed(t, { ...t, status: "snoozed", snoozed_until: action.until }, "snoozed", actor);
    }

    case "done": {
      // D6: decision threads use Resolve… instead of the Done quick action.
      if (t.kind === "decision") return invalid();
      return changed(t, closeAs(t, "resolved", "done", nowIso), "resolved", actor);
    }

    case "resolve":
      // Runtime check: callers may pass unvalidated input.
      if (!ResolutionSchema.safeParse(action.resolution).success) return invalid();
      return changed(t, closeAs(t, "resolved", action.resolution, nowIso), "resolved", actor);

    case "dismiss":
      return changed(t, closeAs(t, "dismissed", null, nowIso), "status_changed", actor, [{ type: "write_suppression" }]);

    case "back_to_me":
      return changed(t, { ...t, status: "open", waiting_on: null, expected_by: null }, "status_changed", actor);

    case "wake": {
      // System wakes only once the snooze date is reached; the user can Wake now at any time.
      if (actor === "system" && (!t.snoozed_until || new Date(t.snoozed_until) > now)) return invalid();
      return changed(t, { ...t, status: "open", snoozed_until: null }, "status_changed", actor);
    }

    case "reopen": {
      const reopened: ThreadState = {
        ...t,
        status: "open",
        resolution: null,
        resolved_at: null,
        waiting_on: null,
        expected_by: null,
        snoozed_until: null,
      };
      // Keeps the decision row (the caller must not delete it); dismissed → delete suppression.
      const effects: TransitionEffect[] = t.status === "dismissed" ? [{ type: "delete_suppression" }] : [];
      return changed(t, reopened, "reopened", actor, effects);
    }

    case "edit":
      return edit(t, action.fields, actor, now);

    case "undo":
      return undo(t, action.target, actor, now);

    case "forget":
      return {
        ok: true,
        thread: null,
        event: null, // the thread and its events are hard-deleted (rule 8); nothing is left to log against
        effects: [{ type: "delete_thread", alsoDeleteSource: action.alsoDeleteSource ?? false }],
      };
  }
}

/**
 * Undo (D44 option a, approved Oct 21): only the thread's latest event, only the user's own
 * reversible action, only within UNDO_WINDOW_MS + UNDO_GRACE_MS (12 s) of it. Restores that event's `before` values exactly (a Done
 * from waiting goes back to waiting) and returns an `undone` event; nothing earlier is rewritten.
 */
function undo(t: ThreadState, target: UndoTarget, actor: Actor, now: Date): TransitionResult {
  if (!target.latest || target.actor !== "user" || !UNDOABLE_EVENT_TYPES.includes(target.type)) return invalid();
  if (!validInstant(target.created_at)) return invalid();
  const elapsed = now.getTime() - new Date(target.created_at).getTime();
  if (elapsed < 0 || elapsed > UNDO_WINDOW_MS + UNDO_GRACE_MS) return invalid();

  const before = target.before ?? {};
  const after = target.after ?? {};
  const isStateKey = (k: string): k is keyof ThreadState => (THREAD_STATE_KEYS as ReadonlyArray<string>).includes(k);
  if (![...Object.keys(before), ...Object.keys(after)].every(isStateKey)) return invalid();
  // The thread must still hold the event's `after` values; otherwise refuse rather than clobber.
  for (const k of Object.keys(after) as (keyof ThreadState)[]) if (t[k] !== after[k]) return invalid();

  const restored: ThreadState = { ...t, ...(before as Partial<ThreadState>) };
  const d = diff(t, restored);
  return {
    ok: true,
    thread: restored,
    event: { type: "undone", actor, before: d.before, after: { ...d.after, undone_event_id: target.id } },
    effects: [],
  };
}

function closeAs(t: ThreadState, status: "resolved" | "dismissed", resolution: Resolution | null, nowIso: string): ThreadState {
  return {
    ...t,
    status,
    resolution,
    resolved_at: status === "resolved" ? nowIso : t.resolved_at,
    // A snooze date is meaningless once closed; waiting_on is kept as a record of who delivered.
    snoozed_until: null,
  };
}

function edit(t: ThreadState, fields: EditableFields, actor: Actor, now: Date): TransitionResult {
  const next: ThreadState = { ...t };

  if (fields.title !== undefined) {
    if (!nonEmpty(fields.title)) return invalid();
    next.title = fields.title;
  }
  if (fields.kind !== undefined) {
    // Changing to or from waiting_on would change status; that goes through Mark waiting / Back to me.
    if ((fields.kind === "waiting_on") !== (t.kind === "waiting_on") && t.status === "waiting") return invalid();
    next.kind = fields.kind;
  }
  if (fields.next_action !== undefined) next.next_action = fields.next_action;
  if (fields.counterparty !== undefined) next.counterparty = fields.counterparty;
  if (fields.consequence !== undefined) {
    next.consequence = fields.consequence;
    // Text the user typed is theirs, not the source's and not an interpretation; the event records it.
    if (fields.consequence === null) next.consequence_basis = null;
  }
  if (fields.due_at !== undefined) {
    if (fields.due_at !== null && !validInstant(fields.due_at)) return invalid();
    next.due_at = fields.due_at;
    // A date the user set is not an assumption; a date the AI set always is.
    next.due_certainty = fields.due_at === null ? "none" : actor === "ai" ? "inferred" : "explicit";
    next.due_time_known = fields.due_at === null ? false : (fields.due_time_known ?? false);
  } else if (fields.due_time_known !== undefined) {
    if (next.due_at === null) return invalid();
    next.due_time_known = fields.due_time_known;
  }
  if (fields.waiting_on !== undefined || fields.expected_by !== undefined) {
    if (t.status !== "waiting") return invalid();
    if (fields.waiting_on !== undefined) {
      if (!nonEmpty(fields.waiting_on)) return invalid();
      next.waiting_on = fields.waiting_on;
    }
    if (fields.expected_by !== undefined) {
      if (fields.expected_by !== null && !validInstant(fields.expected_by)) return invalid();
      next.expected_by = fields.expected_by;
    }
  }
  if (fields.snoozed_until !== undefined) {
    // Same rule as Snooze: the date must be in the future.
    if (t.status !== "snoozed" || !validInstant(fields.snoozed_until) || new Date(fields.snoozed_until) <= now) return invalid();
    next.snoozed_until = fields.snoozed_until;
  }

  const d = diff(t, next);
  if (Object.keys(d.after).length === 0) return { ok: true, thread: t, event: null, effects: [] };
  return { ok: true, thread: next, event: { type: "edited", actor, before: d.before, after: d.after }, effects: [] };
}
