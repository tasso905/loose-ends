import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { UndoToast } from "@/components/toast/UndoToast";
import { canMarkDone, FILTER_STATUSES, formatHistoryTime, formatUntil, historyLine, parseFilter, sortThreads, THREADS_COPY } from "@/lib/threads/view";

const row = (id: string, over: Partial<Parameters<typeof sortThreads>[0][number]> = {}) => ({
  id,
  status: "open" as const,
  due_at: null,
  resolved_at: null,
  updated_at: "2026-10-05T12:00:00.000Z",
  created_at: "2026-10-01T12:00:00.000Z",
  ...over,
});

describe("Threads index rules (SITE_CONTRACT §2.6, D7)", () => {
  it("Active = open, waiting, snoozed; Closed = resolved, dismissed", () => {
    expect(FILTER_STATUSES).toEqual({ active: ["open", "waiting", "snoozed"], closed: ["resolved", "dismissed"] });
  });

  it("?filter= defaults to active; only 'closed' selects closed", () => {
    expect(parseFilter(undefined)).toBe("active");
    expect(parseFilter("closed")).toBe("closed");
    expect(parseFilter(["closed", "active"])).toBe("closed");
    expect(parseFilter("CLOSED")).toBe("active");
    expect(parseFilter("anything")).toBe("active");
  });

  it("Active sorts by due date ascending, undated last", () => {
    const rows = [
      row("a"),
      row("b", { due_at: "2026-10-12T00:00:00.000Z" }),
      row("c", { due_at: "2026-10-08T00:00:00.000Z" }),
      row("d", { created_at: "2026-09-01T00:00:00.000Z" }),
    ];
    expect(sortThreads(rows, "active").map((r) => r.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("Closed sorts by resolved / dismissed date, newest first", () => {
    const rows = [
      row("old", { status: "resolved", resolved_at: "2026-10-02T00:00:00.000Z" }),
      row("dismissed", { status: "dismissed", updated_at: "2026-10-04T00:00:00.000Z" }),
      row("new", { status: "resolved", resolved_at: "2026-10-06T00:00:00.000Z" }),
    ];
    expect(sortThreads(rows, "closed").map((r) => r.id)).toEqual(["new", "dismissed", "old"]);
  });

  it("does not mutate its input", () => {
    const rows = [row("b", { due_at: "2026-10-12T00:00:00.000Z" }), row("a", { due_at: "2026-10-01T00:00:00.000Z" })];
    sortThreads(rows, "active");
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("Done availability (D6)", () => {
  it("only on active, non-decision threads", () => {
    expect(canMarkDone({ status: "open", kind: "commitment" })).toBe(true);
    expect(canMarkDone({ status: "waiting", kind: "waiting_on" })).toBe(true);
    expect(canMarkDone({ status: "snoozed", kind: "admin" })).toBe(true);
    expect(canMarkDone({ status: "open", kind: "decision" })).toBe(false);
    expect(canMarkDone({ status: "resolved", kind: "commitment" })).toBe(false);
    expect(canMarkDone({ status: "dismissed", kind: "request" })).toBe(false);
  });
});

describe("dates and history lines", () => {
  it("history time is month, day, time in the user's timezone", () => {
    expect(formatHistoryTime("2026-10-18T13:42:00.000Z", "America/New_York")).toBe("Oct 18, 9:42 AM");
  });

  it("snoozed rows show Until {date}, no time", () => {
    expect(formatUntil("2026-10-09T13:00:00.000Z", "America/New_York")).toBe("Until Fri Oct 9");
  });

  it("history lines for created, done, undone", () => {
    expect(historyLine({ type: "created", actor: "user", before: null, after: { via: "accept" } })).toBe("You accepted this from your source.");
    expect(historyLine({ type: "resolved", actor: "user", before: {}, after: { resolution: "done" } })).toBe("You marked this done.");
    expect(historyLine({ type: "undone", actor: "user", before: {}, after: {} })).toBe("You undid the last change.");
    expect(historyLine({ type: "mystery", actor: "user", before: null, after: null })).toBe("Updated.");
  });

  it("glossary words: Done and Resolve…, never Complete", () => {
    expect(THREADS_COPY.done).toBe("Done");
    expect(THREADS_COPY.resolve).toBe("Resolve…");
    expect(JSON.stringify(THREADS_COPY)).not.toMatch(/Complete|Oops|!/);
  });
});

describe("UndoToast markup", () => {
  it("keeps an empty polite status region mounted when there is no toast", () => {
    const html = renderToStaticMarkup(createElement(UndoToast, { toast: null, onClose: () => undefined }));
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-live="polite"/);
    expect(html).not.toMatch(/Undo/);
  });

  it("renders the message and a named Undo button inside the status region", () => {
    const html = renderToStaticMarkup(
      createElement(UndoToast, { toast: { id: 1, message: 'Marked done: "X"', onUndo: async () => undefined, undoLabel: "Undo done: X" }, onClose: () => undefined }),
    );
    expect(html).toContain("Marked done: &quot;X&quot;");
    expect(html).toMatch(/<button[^>]*aria-label="Undo done: X"/);
  });
});
