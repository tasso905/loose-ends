import "server-only";
import { track } from "@/lib/analytics/track";
import type { Band } from "@/lib/schemas";
import type { ReviewEntry } from "./service";

/**
 * S3's PostHog events (D40; rule 9: IDs, enums and counts only). track() sends nothing until
 * SETTINGS_ANALYTICS_TOGGLE_SHIPPED is true, PostHog is configured and the user has not opted out.
 */

export function trackProposalsShown(userId: string, extractionId: string, counts: Partial<Record<Band, number>>): void {
  track(userId, "proposals_shown", { extraction_id: extractionId, band_counts: counts });
}

/** One `proposal_reviewed` per item the server actually changed. Inline edit is not built: fields_edited is empty. */
export function trackProposalsReviewed(userId: string, entries: ReviewEntry[], action: "accepted" | "rejected"): void {
  for (const e of entries) track(userId, "proposal_reviewed", { item_id: e.item_id, band: e.band, action, fields_edited: [] });
}
