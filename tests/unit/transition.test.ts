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
  resolved: { reopen: "open", edit: "resolved", forget: "deleted" },
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
    const r = transition(t, { type: "resolve", resolution: "decided" }, { now: NOW });
    expect(r.ok && r.thread?.resolution).toBe("decided");
  });

  it("Resolve accepts done, decided and not_needed", () => {
    for (const resolution of ["done", "decided", "not_needed"] as const) {
      const r = transition(thread("open"), { type: "resolve", resolution }, { now: NOW });
      expect(r.ok && r.thread?.resolution).toBe(resolution);
    }
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
