import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateEvent } from "@/lib/analytics/events";

/** Lead-tester: the 90 s timeout sends extraction_completed (failed) exactly once, content-free (rule 9). */

const sent: Array<{ userId: string; event: string; props: unknown }> = [];
vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/track", () => ({
  track: (userId: string, event: string, props: unknown) => sent.push({ userId, event, props }),
  createTracker: () => ({ trackAndWait: async () => "disabled" }),
}));

const { trackTimedOut } = await import("@/lib/extraction/analytics");
const USER = "3f1c2b4a-8d6e-4c1a-9b2e-7a5d3c1e0f9a";
const EX = "9a2b4c6d-1e3f-4a5b-8c7d-0e1f2a3b4c5d";

beforeEach(() => {
  sent.length = 0;
});

describe("trackTimedOut", () => {
  it("sends nothing when this read did not apply the 90 s rule", () => {
    trackTimedOut(USER, { id: EX, timedOut: false, elapsedMs: 120_000 });
    expect(sent).toEqual([]);
  });

  it("sends one extraction_completed failed with ids, enums and counts only, valid for the allow-list", () => {
    trackTimedOut(USER, { id: EX, timedOut: true, elapsedMs: 91_234.6 });
    expect(sent).toEqual([
      { userId: USER, event: "extraction_completed", props: { extraction_id: EX, status: "failed", latency_ms: 91_235, item_count: 0, band_counts: {} } },
    ]);
    expect(validateEvent(sent[0]!.event, sent[0]!.props).ok).toBe(true);
  });

  it("caps latency so a very stale attempt still validates", () => {
    trackTimedOut(USER, { id: EX, timedOut: true, elapsedMs: 5e9 });
    expect((sent[0]!.props as { latency_ms: number }).latency_ms).toBe(1_000_000);
    expect(validateEvent(sent[0]!.event, sent[0]!.props).ok).toBe(true);
  });
});
