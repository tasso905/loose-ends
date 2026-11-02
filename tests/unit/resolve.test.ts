import { describe, expect, it } from "vitest";
import { RESOLVE_COPY, ResolveInput, resolutionsFor } from "@/lib/threads/resolve";
import { canMarkDone, canResolve, formatDecisionDate, THREADS_COPY } from "@/lib/threads/view";

const ID = "3f1c2a4e-8b7d-4c6a-9e2f-1a2b3c4d5e6f";

describe("F11 Resolve sheet rules", () => {
  it("offers Done, Decided and Not needed; a decision thread offers Decided and Not needed (D6)", () => {
    expect(resolutionsFor("commitment")).toEqual(["done", "decided", "not_needed"]);
    expect(resolutionsFor("decision")).toEqual(["decided", "not_needed"]);
  });

  it("Resolve… on every Active thread, decision threads included; Done never on decision threads", () => {
    for (const status of ["open", "waiting", "snoozed"] as const) {
      expect(canResolve({ status })).toBe(true);
      expect(canMarkDone({ status, kind: "decision" })).toBe(false);
    }
    expect(canResolve({ status: "resolved" })).toBe(false);
    expect(canResolve({ status: "dismissed" })).toBe(false);
  });

  it("documented copy (SITE_CONTRACT §2.10, CONTENT_MODEL §9); the interim disabled reason is gone", () => {
    expect(RESOLVE_COPY.heading).toBe("How did this end?");
    expect(RESOLVE_COPY.options).toEqual({ done: "Done", decided: "Decided", not_needed: "Not needed" });
    expect(RESOLVE_COPY.choiceLabel).toBe("What did you decide?");
    expect(RESOLVE_COPY.reasonLabel).toBe("Want me to remember why?");
    expect([RESOLVE_COPY.save, RESOLVE_COPY.skip]).toEqual(["Save", "Skip"]);
    expect(THREADS_COPY.resolve).toBe("Resolve…");
    expect("resolveUnavailable" in THREADS_COPY).toBe(false);
  });

  it("input: Decided needs a non-blank decision within 300 characters; the reason is optional, kept as typed", () => {
    const base = { threadId: ID, fromStatus: "open" as const };
    const reason = "  Cheaper,\nand covers the windshield.  ";
    const ok = ResolveInput.safeParse({ ...base, resolution: "decided", choice: "Renew", reason });
    expect(ok.success && ok.data).toMatchObject({ choice: "Renew", reason });
    expect(ResolveInput.safeParse({ ...base, resolution: "decided", choice: "Renew", reason: null }).success).toBe(true);
    expect(ResolveInput.safeParse({ ...base, resolution: "decided", choice: "   ", reason: null }).success).toBe(false);
    expect(ResolveInput.safeParse({ ...base, resolution: "decided", choice: "x".repeat(301), reason: null }).success).toBe(false);
    expect(ResolveInput.safeParse({ ...base, resolution: "decided", choice: "x", reason: "y".repeat(2001) }).success).toBe(false);
    expect(ResolveInput.safeParse({ ...base, resolution: "not_needed" }).success).toBe(true);
    expect(ResolveInput.safeParse({ ...base, resolution: "archived" }).success).toBe(false);
    expect(ResolveInput.safeParse({ ...base, threadId: "nope", resolution: "done" }).success).toBe(false);
  });

  it("a decision's date reads 'Oct 18, 2026' in the user's timezone", () => {
    expect(formatDecisionDate("2026-10-19T02:00:00.000Z", "America/New_York")).toBe("Oct 18, 2026");
  });
});
