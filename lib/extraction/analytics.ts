import "server-only";
import { createTracker, track } from "@/lib/analytics/track";
import { charCountBucket } from "@/lib/analytics/events";
import type { CompletedExtraction } from "./service";

/**
 * S2's PostHog events (D40; rule 9: enums, IDs and counts only). track() sends nothing until
 * SETTINGS_ANALYTICS_TOGGLE_SHIPPED is true, PostHog is configured and the user has not opted out.
 */

/** `source_submitted`: fired once a source row exists (not on rate_limited or invalid input). */
export function trackSourceSubmitted(userId: string, charCount: number): void {
  track(userId, "source_submitted", { kind: "paste", char_count_bucket: charCountBucket(charCount) });
}

const awaited = createTracker();

/**
 * `extraction_completed`, on success and on failure; pass as runExtraction's onComplete. It runs
 * inside the pipeline's after() callback, so the send is awaited there (never throws; PostHog
 * request capped at 2.5 s) instead of scheduling a nested after().
 */
export function extractionCompletedTracker(userId: string): (r: CompletedExtraction) => Promise<unknown> {
  return (r) =>
    awaited.trackAndWait(userId, "extraction_completed", {
      extraction_id: r.extractionId,
      status: r.status,
      latency_ms: r.latencyMs,
      item_count: r.itemCount,
      band_counts: r.bandCounts,
    });
}
