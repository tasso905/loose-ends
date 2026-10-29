import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateEvent } from "@/lib/analytics/events";

/** S2 events map to the S1 allow-list exactly (rule 9: enums, IDs and counts only). */

const sent: Array<{ userId: string; event: string; props: unknown }> = [];
vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/track", () => ({
  track: (userId: string, event: string, props: unknown) => sent.push({ userId, event, props }),
  createTracker: () => ({
    trackAndWait: async (userId: string, event: string, props: unknown) => {
      sent.push({ userId, event, props });
      return "disabled";
    },
  }),
}));

const { trackSourceSubmitted, extractionCompletedTracker } = await import("@/lib/extraction/analytics");
const { SETTINGS_ANALYTICS_TOGGLE_SHIPPED } = await import("@/lib/supabase/env");

const USER = "3f1c2b4a-8d6e-4c1a-9b2e-7a5d3c1e0f9a";
const EX = "9a2b4c6d-1e3f-4a5b-8c7d-0e1f2a3b4c5d";

beforeEach(() => {
  sent.length = 0;
});

describe("S2 analytics events", () => {
  it("source_submitted: paste with a character-count bucket, no file type", () => {
    trackSourceSubmitted(USER, 86);
    trackSourceSubmitted(USER, 30_000);
    expect(sent.map((s) => s.props)).toEqual([
      { kind: "paste", char_count_bucket: "lt_500" },
      { kind: "paste", char_count_bucket: "10k_30k" },
    ]);
    for (const s of sent) expect(validateEvent(s.event, s.props).ok).toBe(true);
  });

  it("extraction_completed: counts and enums only, and awaited", async () => {
    await extractionCompletedTracker(USER)({ extractionId: EX, status: "succeeded", latencyMs: 812, itemCount: 3, bandCounts: { high: 1, low: 1, ignore: 1 } });
    expect(sent).toEqual([
      {
        userId: USER,
        event: "extraction_completed",
        props: { extraction_id: EX, status: "succeeded", latency_ms: 812, item_count: 3, band_counts: { high: 1, low: 1, ignore: 1 } },
      },
    ]);
    expect(validateEvent("extraction_completed", sent[0]!.props).ok).toBe(true);
  });

  it("shipped: the user approved the notice and toggle (D46); the ship switch is on", () => {
    expect(SETTINGS_ANALYTICS_TOGGLE_SHIPPED).toBe(true);
  });
});
