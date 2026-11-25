import { describe, expect, it } from "vitest";
import { parseQuickAddForm, QUICK_ADD_COPY, QUICK_ADD_MAX_CHARS, quickAddFieldError, quickAddWrittenOn } from "@/lib/capture/quickAddInput";
import type { ProposalView } from "@/lib/extraction/service";
import { quickAddRoute, quickAddToast, reviewableProposals } from "@/lib/review/quickAdd";
import { transition, type CreateFields, type UndoTarget } from "@/lib/threads/transition";

/** S14 (F4 quick add): input rules, routing, toast copy, and transition()'s undo of an auto-create. */

const NOW = new Date("2026-11-11T15:00:00Z");
const ITEM = "00000000-0000-0000-0000-0000000000a1";

const fields: CreateFields = {
  title: "Call the plumber",
  kind: "commitment",
  next_action: "Call the plumber",
  counterparty: null,
  due_at: null,
  due_certainty: "none",
  due_time_known: false,
  consequence: null,
  consequence_basis: null,
  waiting_on: null,
  expected_by: null,
  primary_source_id: null,
  confidence: 0.85,
};

function autoCreated() {
  const r = transition(null, { type: "create", via: "auto_create", extractionItemId: ITEM, fields }, { actor: "ai", now: NOW });
  if (!r.ok || !r.thread || !r.event) throw new Error("create failed");
  const target: UndoTarget = { id: 7, type: "created", actor: "ai", before: null, after: r.event.after, created_at: NOW.toISOString(), latest: true };
  return { thread: r.thread, target };
}
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe("transition(): quick-add auto-create and its undo (F4, D8, D9)", () => {
  it("only the AI auto-creates, and only via auto_create", () => {
    expect(transition(null, { type: "create", via: "auto_create", extractionItemId: ITEM, fields }, { actor: "ai" }).ok).toBe(true);
    expect(transition(null, { type: "create", via: "auto_create", extractionItemId: ITEM, fields }, { actor: "user" }).ok).toBe(false);
    expect(transition(null, { type: "create", via: "accept", extractionItemId: ITEM, fields }, { actor: "ai" }).ok).toBe(false);
  });

  it("Undo within 30 s removes the thread: no thread, no event, one delete_thread effect", () => {
    const { thread, target } = autoCreated();
    for (const ms of [0, 8_000, 12_001, 29_000, 30_000]) {
      expect(transition(thread, { type: "undo", target }, { actor: "user", now: at(ms) })).toEqual({
        ok: true,
        thread: null,
        event: null,
        effects: [{ type: "delete_thread", alsoDeleteSource: false }],
      });
    }
  });

  it("is refused after 30 s, before the event, when not latest, or once the thread changed", () => {
    const { thread, target } = autoCreated();
    const undo = (t = thread, x = target, ms = 1_000) => transition(t, { type: "undo", target: x }, { actor: "user", now: at(ms) });
    expect(undo(thread, target, 30_001)).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    expect(undo(thread, target, -1)).toMatchObject({ ok: false });
    expect(undo(thread, { ...target, latest: false })).toMatchObject({ ok: false });
    expect(undo({ ...thread, title: "Edited" })).toMatchObject({ ok: false });
  });

  it("is refused for a thread accepted from the tray (actor user, via accept)", () => {
    const { thread, target } = autoCreated();
    expect(transition(thread, { type: "undo", target: { ...target, actor: "user" } }, { actor: "user", now: at(1_000) }).ok).toBe(false);
    const accepted = { ...target, after: { ...target.after, via: "accept" } };
    expect(transition(thread, { type: "undo", target: accepted }, { actor: "user", now: at(1_000) }).ok).toBe(false);
  });
});

describe("quick add input (SITE_CONTRACT §2.2)", () => {
  it("keeps the user's wording; refuses blank and over 2,000 characters", () => {
    expect(parseQuickAddForm({ text: "  Send Mike the proposal Friday " })).toEqual({ ok: true, data: { text: "  Send Mike the proposal Friday " } });
    expect(parseQuickAddForm({ text: "   " })).toMatchObject({ ok: false, reason: "empty" });
    expect(parseQuickAddForm({ text: undefined })).toMatchObject({ ok: false, reason: "empty" });
    expect(parseQuickAddForm({ text: "x".repeat(QUICK_ADD_MAX_CHARS) }).ok).toBe(true);
    expect(parseQuickAddForm({ text: "x".repeat(QUICK_ADD_MAX_CHARS + 1) })).toEqual({ ok: false, reason: "too_long", length: 2_001 });
    expect(quickAddFieldError(2_000)).toBeNull();
    expect(quickAddFieldError(2_001)).toBe(QUICK_ADD_COPY.tooLong(2_001));
  });

  it("written today in the user's timezone", () => {
    expect(quickAddWrittenOn(new Date("2026-11-12T03:00:00Z"), "America/New_York")).toBe("2026-11-11");
    expect(quickAddWrittenOn(new Date("2026-11-12T03:00:00Z"), "Not/AZone")).toBe("2026-11-12");
  });
});

describe("routing and toast (SITE_CONTRACT §3.1)", () => {
  const p = (band: ProposalView["band"], reviewStatus: ProposalView["reviewStatus"], type = "commitment"): ProposalView =>
    ({ id: `${band}-${reviewStatus}`, band, confidence: 0.8, reviewStatus, threadId: null, payload: { item: { type }, label: { word: "x", reason: "y" } } }) as unknown as ProposalView;

  it("stays when everything became a thread; reviews when anything waits or nothing was created", () => {
    const one = [{ title: "A" }];
    expect(quickAddRoute(one, [p("high", "auto_created")])).toBe("stay");
    expect(quickAddRoute(one, [p("high", "auto_created"), p("medium", "pending")])).toBe("review");
    expect(quickAddRoute(one, [p("high", "auto_created"), p("low", "pending")])).toBe("review");
    // A key fact never shows in the tray, so it does not send the user there.
    expect(quickAddRoute(one, [p("high", "auto_created"), p("high", "pending", "key_fact")])).toBe("stay");
    expect(quickAddRoute([], [p("medium", "pending")])).toBe("review");
    expect(quickAddRoute([], [])).toBe("review");
  });

  it("the tray leaves out auto-created proposals", () => {
    expect(reviewableProposals([p("high", "auto_created"), p("medium", "pending")]).map((x) => x.reviewStatus)).toEqual(["pending"]);
  });

  it("toast copy: the documented single form, and a count for several", () => {
    expect(quickAddToast([{ title: "Send revised proposal to Mike" }])).toEqual({
      message: 'Added "Send revised proposal to Mike"',
      undoLabel: "Undo add: Send revised proposal to Mike",
    });
    expect(quickAddToast([{ title: "A" }, { title: "B" }])).toEqual({ message: "Added 2 threads", undoLabel: "Undo add: 2 threads" });
  });
});
