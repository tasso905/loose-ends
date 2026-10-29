import { describe, expect, it } from "vitest";
import type { ThreadStatus } from "@/lib/schemas";
import { transition, type ThreadAction, type ThreadActionType, type ThreadState } from "@/lib/threads/transition";
import { threadKindFor } from "@/lib/threads/mapping";

const NOW = new Date("2026-10-05T16:00:00.000Z");
const LATER = "2026-10-06T13:00:00.000Z";
const EARLIER = "2026-10-04T13:00:00.000Z";

function thread(status: ThreadStatus, over: Partial<ThreadState> = {}): ThreadState {
  return {
    title: "Send revised proposal to Mike",
    kind: "commitment",
    next_action: "Send the revised proposal",
    counterparty: "Mike",
    due_at: "2026-10-10T03:59:00.000Z",
    due_certainty: "explicit",
    due_time_known: false,
    consequence: null,
    consequence_basis: null,
    status,
    resolution: status === "resolved" ? "done" : null,
    waiting_on: status === "waiting" ? "Mike" : null,
    expected_by: null,
    snoozed_until: status === "snoozed" ? LATER : null,
    resolved_at: status === "resolved" ? EARLIER : null,
    primary_source_id: null,
    confidence: 0.95,
    ...over,
  };
}

const ACTIONS: Record<ThreadActionType, ThreadAction> = {
  create: {
    type: "create",
    via: "accept",
    extractionItemId: "item-1",
    fields: {
      title: "Send revised proposal to Mike",
      kind: "commitment",
      next_action: "Send the revised proposal",
      counterparty: "Mike",
      due_at: null,
      due_certainty: "none",
      due_time_known: false,
      consequence: null,
      consequence_basis: null,
      waiting_on: null,
      expected_by: null,
      primary_source_id: null,
      confidence: 0.95,
    },
  },
  mark_waiting: { type: "mark_waiting", waitingOn: "Mike", expectedBy: null },
  snooze: { type: "snooze", until: LATER },
  done: { type: "done" },
  resolve: { type: "resolve", resolution: "not_needed" },
  dismiss: { type: "dismiss" },
  back_to_me: { type: "back_to_me" },
  wake: { type: "wake" },
  reopen: { type: "reopen" },
  edit: { type: "edit", fields: { title: "Send the proposal to Mike" } },
  forget: { type: "forget" },
  // Undo of a Done from open, written 1 s ago: it applies only to a thread still in that resolved state.
  undo: {
    type: "undo",
    target: {
      id: 7,
      type: "resolved",
      actor: "user",
      before: { status: "open", resolution: null, resolved_at: null },
      after: { status: "resolved", resolution: "done", resolved_at: EARLIER },
      created_at: new Date(NOW.getTime() - 1000).toISOString(),
      latest: true,
    },
  },
};

/**
 * The PRD "Lifecycle transitions" table, written out independently of the implementation.
 * Key: from-status (or "proposal"); value: action → resulting status ("deleted" for forget).
 */
const TABLE: Record<ThreadStatus | "proposal", Partial<Record<ThreadActionType, ThreadStatus | "deleted">>> = {
  proposal: { create: "open" },
  open: {
    mark_waiting: "waiting",
    snooze: "snoozed",
    done: "resolved",
    resolve: "resolved",
    dismiss: "dismissed",
    edit: "open",
    forget: "deleted",
  },
  waiting: { done: "resolved", back_to_me: "open", resolve: "resolved", dismiss: "dismissed", edit: "waiting", forget: "deleted" },
  snoozed: { wake: "open", done: "resolved", resolve: "resolved", dismiss: "dismissed", edit: "snoozed", forget: "deleted" },
  // undo (D44 a): only where the thread still holds the undone event's `after` values.
  resolved: { reopen: "open", edit: "resolved", forget: "deleted", undo: "open" },
  dismissed: { reopen: "open", edit: "dismissed", forget: "deleted" },
};

describe("transition(): every (status, action) pair matches the PRD table", () => {
  const froms = Object.keys(TABLE) as (ThreadStatus | "proposal")[];
  const actions = Object.keys(ACTIONS) as ThreadActionType[];

  for (const from of froms) {
    for (const actionType of actions) {
      const expected = TABLE[from][actionType];
      const name = `${from} --${actionType}--> ${expected ?? "invalid_transition"}`;
      it(name, () => {
        const t = from === "proposal" ? null : thread(from);
        const r = transition(t, ACTIONS[actionType], { now: NOW });
        if (expected === undefined) {
          expect(r.ok).toBe(false);
          if (!r.ok) {
            expect(r.error.code).toBe("invalid_transition");
            expect(r.error.message).toBe("That change isn't possible any more. Refresh to see the latest.");
            expect(r.error.retryable).toBe(false);
          }
          return;
        }
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        if (expected === "deleted") {
          expect(r.thread).toBeNull();
          expect(r.effects).toEqual([{ type: "delete_thread", alsoDeleteSource: false }]);
        } else {
          expect(r.thread?.status).toBe(expected);
          expect(r.event).not.toBeNull();
        }
      });
    }
  }
});

describe("transition(): thread_events before/after", () => {
  it("created event has before = null, full after, and the extraction_item_id (F6)", () => {
    const r = transition(null, ACTIONS.create, { now: NOW });
    expect(r.ok && r.event).toMatchObject({
      type: "created",
      actor: "user",
      before: null,
      after: { status: "open", title: "Send revised proposal to Mike", extraction_item_id: "item-1", via: "accept" },
    });
  });

  it("records only changed fields with their before and after values", () => {
    const r = transition(thread("open"), { type: "mark_waiting", waitingOn: "Legal", expectedBy: LATER }, { now: NOW });
    expect(r.ok && r.event).toEqual({
      type: "status_changed",
      actor: "user",
      before: { status: "open", waiting_on: null, expected_by: null },
      after: { status: "waiting", waiting_on: "Legal", expected_by: LATER },
    });
  });

  it("uses the event taxonomy types from the schema", () => {
    const types = (a: ThreadAction, s: ThreadStatus) => {
      const r = transition(thread(s), a, { now: NOW });
      return r.ok ? r.event?.type : null;
    };
    expect(types(ACTIONS.snooze, "open")).toBe("snoozed");
    expect(types(ACTIONS.done, "open")).toBe("resolved");
    expect(types(ACTIONS.resolve, "waiting")).toBe("resolved");
    expect(types(ACTIONS.dismiss, "open")).toBe("status_changed");
    expect(types(ACTIONS.reopen, "resolved")).toBe("reopened");
    expect(types(ACTIONS.edit, "open")).toBe("edited");
  });

  it("passes the actor through (system wake)", () => {
    const r = transition(thread("snoozed", { snoozed_until: EARLIER }), { type: "wake" }, { now: NOW, actor: "system" });
    expect(r.ok && r.event?.actor).toBe("system");
  });
});

describe("transition(): row rules", () => {
  it("proposal of kind waiting_on creates a waiting thread and requires waiting_on", () => {
    const base = ACTIONS.create as Extract<ThreadAction, { type: "create" }>;
    const ok = transition(null, { ...base, fields: { ...base.fields, kind: "waiting_on", waiting_on: "Acme" } }, { now: NOW });
    expect(ok.ok && ok.thread?.status).toBe("waiting");
    expect(ok.ok && ok.thread?.waiting_on).toBe("Acme");
    const missing = transition(null, { ...base, fields: { ...base.fields, kind: "waiting_on", waiting_on: null } }, { now: NOW });
    expect(missing.ok).toBe(false);
  });

  it("mark waiting requires a non-empty waiting_on", () => {
    expect(transition(thread("open"), { type: "mark_waiting", waitingOn: "  " }, { now: NOW }).ok).toBe(false);
  });

  it("snooze requires a future snoozed_until", () => {
    expect(transition(thread("open"), { type: "snooze", until: EARLIER }, { now: NOW }).ok).toBe(false);
    expect(transition(thread("open"), { type: "snooze", until: "not a date" }, { now: NOW }).ok).toBe(false);
  });

  it("Done sets resolution = done and resolved_at = now", () => {
    const r = transition(thread("open"), { type: "done" }, { now: NOW });
    expect(r.ok && r.thread).toMatchObject({ status: "resolved", resolution: "done", resolved_at: NOW.toISOString() });
  });

  it("Done is not available on decision threads (D6); Resolve… is", () => {
    const t = thread("open", { kind: "decision" });
    expect(transition(t, { type: "done" }, { now: NOW }).ok).toBe(false);
    const r = transition(t, { type: "resolve", resolution: "decided", decision: { choice: "Renew", reason: null } }, { now: NOW });
    expect(r.ok && r.thread?.resolution).toBe("decided");
  });

  it("Resolve accepts done, decided and not_needed", () => {
    for (const resolution of ["done", "decided", "not_needed"] as const) {
      const decision = resolution === "decided" ? { choice: "Renew", reason: null } : undefined;
      const r = transition(thread("open"), { type: "resolve", resolution, decision }, { now: NOW });
      expect(r.ok && r.thread?.resolution).toBe(resolution);
    }
  });

  it("Decided without a decision, or a decision with Done / Not needed, is refused (as thread_resolve() refuses it)", () => {
    expect(transition(thread("open"), { type: "resolve", resolution: "decided" }, { now: NOW })).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    expect(transition(thread("open"), { type: "resolve", resolution: "done", decision: { choice: "x", reason: null } }, { now: NOW }).ok).toBe(false);
  });

  it("a decision of only zero-width or no-break spaces is blank, as private.is_blank() sees it", () => {
    for (const choice of ["\u200b\u200b", "\u00a0 \ufeff", "\u3000"]) {
      expect(transition(thread("open"), { type: "resolve", resolution: "decided", decision: { choice, reason: null } }, { now: NOW }).ok).toBe(false);
    }
    const r = transition(thread("open"), { type: "resolve", resolution: "decided", decision: { choice: "Renew", reason: "\u200b " } }, { now: NOW });
    expect(r.ok && r.effects).toContainEqual({ type: "write_decision", choice: "Renew", reason: null });
  });

  it("F11: Decided with a decision writes it as typed; Skip (no reason) and a blank reason write none", () => {
    const reason = "  Cheaper, and it covers the windshield.\n";
    const r = transition(thread("open"), { type: "resolve", resolution: "decided", decision: { choice: "Renewed with Provider A", reason } }, { now: NOW });
    expect(r.ok && r.effects).toEqual([{ type: "write_decision", choice: "Renewed with Provider A", reason }]);
    const skip = transition(thread("open"), { type: "resolve", resolution: "decided", decision: { choice: "Renew", reason: null } }, { now: NOW });
    expect(skip.ok && skip.effects).toEqual([{ type: "write_decision", choice: "Renew", reason: null }]);
    const blank = transition(thread("open"), { type: "resolve", resolution: "decided", decision: { choice: "Renew", reason: " \n " } }, { now: NOW });
    expect(blank.ok && blank.effects).toEqual([{ type: "write_decision", choice: "Renew", reason: null }]);
  });

  it("F11: refuses a blank or over-long choice, an over-long reason, and a decision on Done or Not needed", () => {
    const resolve = (resolution: "done" | "decided" | "not_needed", choice: string, reason: string | null = null) =>
      transition(thread("open"), { type: "resolve", resolution, decision: { choice, reason } }, { now: NOW }).ok;
    expect(resolve("decided", "  ")).toBe(false);
    expect(resolve("decided", "x".repeat(300))).toBe(true);
    expect(resolve("decided", "x".repeat(301))).toBe(false);
    expect(resolve("decided", "Renew", "y".repeat(2000))).toBe(true);
    expect(resolve("decided", "Renew", "y".repeat(2001))).toBe(false);
    expect(resolve("decided", "Renew", "😀".repeat(2000))).toBe(true); // counted as Postgres counts characters
    expect(resolve("done", "Renew")).toBe(false);
    expect(resolve("not_needed", "Renew")).toBe(false);
  });

  it("F11/D6: a decision thread resolves as Decided or Not needed, never Done", () => {
    const t = thread("open", { kind: "decision" });
    expect(transition(t, { type: "resolve", resolution: "done" }, { now: NOW }).ok).toBe(false);
    expect(transition(t, { type: "resolve", resolution: "not_needed" }, { now: NOW }).ok).toBe(true);
  });

  it("D44: undoing a resolution as Decided deletes its decision; undoing Done deletes nothing", () => {
    const target = (resolution: string) => ({
      id: 7,
      type: "resolved" as const,
      actor: "user" as const,
      before: { status: "open", resolution: null, resolved_at: null },
      after: { status: "resolved", resolution, resolved_at: NOW.toISOString() },
      created_at: NOW.toISOString(),
      latest: true,
    });
    const decided = thread("resolved", { resolution: "decided", resolved_at: NOW.toISOString() });
    const u = transition(decided, { type: "undo", target: target("decided") }, { now: NOW });
    expect(u.ok && u.effects).toEqual([{ type: "delete_decision", resolutionEventId: 7 }]);
    const done = thread("resolved", { resolution: "done", resolved_at: NOW.toISOString() });
    const v = transition(done, { type: "undo", target: target("done") }, { now: NOW });
    expect(v.ok && v.effects).toEqual([]);
  });

  it("Dismiss writes a suppression record; reopening a dismissed thread deletes it", () => {
    const d = transition(thread("open"), { type: "dismiss" }, { now: NOW });
    expect(d.ok && d.effects).toEqual([{ type: "write_suppression" }]);
    const r = transition(thread("dismissed"), { type: "reopen" }, { now: NOW });
    expect(r.ok && r.effects).toEqual([{ type: "delete_suppression" }]);
  });

  it("reopening a resolved thread clears resolution but asks for no decision deletion", () => {
    const r = transition(thread("resolved", { resolution: "decided" }), { type: "reopen" }, { now: NOW });
    expect(r.ok && r.thread).toMatchObject({ status: "open", resolution: null, resolved_at: null });
    expect(r.ok && r.effects).toEqual([]);
  });

  it("Back to me clears waiting_on and expected_by", () => {
    const r = transition(thread("waiting", { expected_by: LATER }), { type: "back_to_me" }, { now: NOW });
    expect(r.ok && r.thread).toMatchObject({ status: "open", waiting_on: null, expected_by: null });
  });

  it("system wake only once snoozed_until is reached; user Wake now any time", () => {
    const early = thread("snoozed", { snoozed_until: LATER });
    expect(transition(early, { type: "wake" }, { now: NOW, actor: "system" }).ok).toBe(false);
    expect(transition(early, { type: "wake" }, { now: NOW, actor: "user" }).ok).toBe(true);
    const due = thread("snoozed", { snoozed_until: EARLIER });
    const r = transition(due, { type: "wake" }, { now: NOW, actor: "system" });
    expect(r.ok && r.thread).toMatchObject({ status: "open", snoozed_until: null });
  });

  it("closing a snoozed thread directly clears snoozed_until (D6)", () => {
    const r = transition(thread("snoozed"), { type: "done" }, { now: NOW });
    expect(r.ok && r.thread).toMatchObject({ status: "resolved", snoozed_until: null });
  });

  it("snoozing a waiting thread is not allowed", () => {
    expect(transition(thread("waiting"), ACTIONS.snooze, { now: NOW }).ok).toBe(false);
  });

  it("forget passes alsoDeleteSource through and writes no event", () => {
    const r = transition(thread("open"), { type: "forget", alsoDeleteSource: true }, { now: NOW });
    expect(r.ok && r.event).toBeNull();
    expect(r.ok && r.effects).toEqual([{ type: "delete_thread", alsoDeleteSource: true }]);
  });
});

describe("transition(): edit", () => {
  it("logs before/after and keeps status", () => {
    const r = transition(thread("open"), { type: "edit", fields: { due_at: "2026-10-13T03:59:00.000Z" } }, { now: NOW });
    expect(r.ok && r.thread?.status).toBe("open");
    expect(r.ok && r.event).toEqual({
      type: "edited",
      actor: "user",
      before: { due_at: "2026-10-10T03:59:00.000Z" },
      after: { due_at: "2026-10-13T03:59:00.000Z" },
    });
  });

  it("a user-set date is explicit; clearing it sets certainty none", () => {
    const inferred = thread("open", { due_certainty: "inferred" });
    const set = transition(inferred, { type: "edit", fields: { due_at: "2026-10-13T03:59:00.000Z" } }, { now: NOW });
    expect(set.ok && set.thread?.due_certainty).toBe("explicit");
    const cleared = transition(inferred, { type: "edit", fields: { due_at: null } }, { now: NOW });
    expect(cleared.ok && cleared.thread).toMatchObject({ due_at: null, due_certainty: "none", due_time_known: false });
  });

  it("an edit that changes nothing writes no event", () => {
    const r = transition(thread("open"), { type: "edit", fields: { title: "Send revised proposal to Mike" } }, { now: NOW });
    expect(r.ok && r.event).toBeNull();
  });

  it("rejects an empty title", () => {
    expect(transition(thread("open"), { type: "edit", fields: { title: "" } }, { now: NOW }).ok).toBe(false);
  });

  it("waiting fields can be edited only while waiting; snoozed_until only while snoozed", () => {
    expect(transition(thread("open"), { type: "edit", fields: { waiting_on: "Legal" } }, { now: NOW }).ok).toBe(false);
    expect(transition(thread("waiting"), { type: "edit", fields: { waiting_on: "Legal" } }, { now: NOW }).ok).toBe(true);
    expect(transition(thread("open"), { type: "edit", fields: { snoozed_until: LATER } }, { now: NOW }).ok).toBe(false);
    expect(transition(thread("snoozed"), { type: "edit", fields: { snoozed_until: "2026-10-07T13:00:00.000Z" } }, { now: NOW }).ok).toBe(true);
  });
});

describe("threadKindFor(): item type → thread kind (D5)", () => {
  it.each([
    ["commitment", "user", { kind: "commitment", status: "open" }],
    ["commitment", "other", { kind: "waiting_on", status: "waiting" }],
    ["request", "user", { kind: "request", status: "open" }],
    ["waiting_on", "other", { kind: "waiting_on", status: "waiting" }],
    ["deadline", "user", { kind: "admin", status: "open" }],
    ["intention", "user", { kind: "commitment", status: "open" }],
    ["decision", "user", { kind: "decision", status: "open" }],
    ["key_fact", "unknown", null],
  ] as const)("%s (owner %s)", (type, owner, expected) => {
    expect(threadKindFor(type, owner)).toEqual(expected);
  });
});

describe("transition(): actors (round 2 fixes)", () => {
  it("the system actor can only wake; it cannot close, dismiss or reopen", () => {
    for (const a of [ACTIONS.done, ACTIONS.resolve, ACTIONS.dismiss, ACTIONS.mark_waiting, ACTIONS.snooze]) {
      expect(transition(thread("open"), a, { now: NOW, actor: "system" }).ok).toBe(false);
    }
    expect(transition(thread("resolved"), ACTIONS.reopen, { now: NOW, actor: "system" }).ok).toBe(false);
  });

  it("the ai actor may create (quick-add auto-create) and edit, nothing else", () => {
    expect(transition(null, { ...(ACTIONS.create as Extract<ThreadAction, { type: "create" }>), via: "auto_create" }, { now: NOW, actor: "ai" }).ok).toBe(true);
    expect(transition(thread("open"), ACTIONS.edit, { now: NOW, actor: "ai" }).ok).toBe(true);
    expect(transition(thread("open"), ACTIONS.forget, { now: NOW, actor: "ai" }).ok).toBe(false);
    expect(transition(thread("snoozed"), ACTIONS.wake, { now: NOW, actor: "ai" }).ok).toBe(false);
  });
});

describe("transition(): undo (D44 option a, approved Oct 21)", () => {
  type Undo = Extract<ThreadAction, { type: "undo" }>;
  type Ev = { type: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null };
  const done = (t: ThreadState, at: Date = NOW) => {
    const r = transition(t, { type: "done" }, { now: at });
    if (!r.ok || !r.event) throw new Error("done failed");
    return { thread: r.thread!, event: r.event };
  };
  const undoOf = (ev: Ev, over: Partial<Undo["target"]> = {}): Undo => ({
    type: "undo",
    target: {
      id: 42,
      type: ev.type as Undo["target"]["type"],
      actor: "user",
      before: ev.before,
      after: ev.after,
      created_at: NOW.toISOString(),
      latest: true,
      ...over,
    },
  });
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it.each(["open", "waiting", "snoozed"] as const)("restores the exact prior state of a Done from %s", (from) => {
    const original = thread(from);
    const d = done(original);
    const r = transition(d.thread, undoOf(d.event), { now: at(3000) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.thread).toEqual(original);
    expect(r.event).toEqual({ type: "undone", actor: "user", before: d.event.after, after: { ...d.event.before, undone_event_id: 42 } });
    expect(r.effects).toEqual([]);
  });

  it("is valid up to exactly 12 s after the event (8 s toast + 4 s grace, D44 a) and refused after", () => {
    const d = done(thread("open"));
    expect(transition(d.thread, undoOf(d.event), { now: at(8001) }).ok).toBe(true);
    expect(transition(d.thread, undoOf(d.event), { now: at(12_000) }).ok).toBe(true);
    const late = transition(d.thread, undoOf(d.event), { now: at(12_001) });
    expect(late).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    // An event "from the future" (clock mismatch) is refused too.
    expect(transition(d.thread, undoOf(d.event), { now: at(-1) }).ok).toBe(false);
  });

  it("refuses a non-latest event, another actor's event, or a non-undoable type", () => {
    const d = done(thread("open"));
    expect(transition(d.thread, undoOf(d.event, { latest: false }), { now: NOW }).ok).toBe(false);
    expect(transition(d.thread, undoOf(d.event, { actor: "system" }), { now: NOW }).ok).toBe(false);
    for (const type of ["created", "edited", "status_changed", "snoozed", "reopened", "undone"] as const) {
      expect(transition(d.thread, undoOf(d.event, { type }), { now: NOW }).ok, type).toBe(false);
    }
  });

  it("refuses when the thread no longer holds the event's after values, or the event names unknown keys", () => {
    const d = done(thread("open"));
    expect(transition({ ...d.thread, resolved_at: LATER }, undoOf(d.event), { now: NOW }).ok).toBe(false);
    expect(transition(thread("open"), undoOf(d.event), { now: NOW }).ok).toBe(false);
    expect(transition(d.thread, undoOf({ ...d.event, before: { ...d.event.before, user_id: "x" } }), { now: NOW }).ok).toBe(false);
    expect(transition(d.thread, undoOf(d.event, { created_at: "nope" }), { now: NOW }).ok).toBe(false);
  });

  it("only the user can undo", () => {
    const d = done(thread("open"));
    expect(transition(d.thread, undoOf(d.event), { now: NOW, actor: "system" }).ok).toBe(false);
    expect(transition(d.thread, undoOf(d.event), { now: NOW, actor: "ai" }).ok).toBe(false);
  });
});
