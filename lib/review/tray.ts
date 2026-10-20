import type { ProposalPayload } from "@/lib/extraction/payload";
import type { ProposalView } from "@/lib/extraction/service";
import { BAND_LABEL } from "@/lib/pipeline/score";
import type { Band } from "@/lib/schemas";
import { threadKindFor } from "@/lib/threads/mapping";
import { transition, type CreateFields } from "@/lib/threads/transition";

/**
 * F6 Review Tray rules (SITE_CONTRACT §2.4, CONTENT_MODEL §3, D3, D5). Pure: the tray component and
 * the tests use the same functions, and nothing here recomputes a score (rule 6).
 */

export type TrayBand = Exclude<Band, "ignore">;

export interface TrayGroup {
  band: TrayBand;
  /** `Likely`, `Maybe`, `Also noticed` (D3). */
  title: (typeof BAND_LABEL)[TrayBand];
  /** Also noticed starts collapsed. */
  collapsed: boolean;
  items: ProposalView[];
}

const ORDER: TrayBand[] = ["high", "medium", "low"];

/**
 * The fields transition(create) receives when a proposal is accepted unedited. Mirrored in SQL by
 * private.proposal_thread_fields() (migration 20261020225037); the integration test proves they
 * agree. null for an item that never becomes a thread (key_fact, D5).
 */
export function createFieldsFromPayload(
  payload: ProposalPayload,
  opts: { sourceId: string | null; confidence: number | null },
): CreateFields | null {
  const mapped = threadKindFor(payload.item.type, payload.item.owner);
  if (!mapped) return null;
  const dueAt = payload.date.due_at;
  const waiting = mapped.status === "waiting";
  return {
    title: payload.item.title,
    kind: mapped.kind,
    next_action: payload.item.action,
    counterparty: payload.item.counterparty,
    due_at: dueAt,
    due_certainty: payload.date.due_certainty,
    due_time_known: payload.date.due_time_known,
    consequence: null,
    consequence_basis: null,
    // PRD mapping table: waiting_on = counterparty; expected_by = resolved date if any.
    waiting_on: waiting ? payload.item.counterparty : null,
    expected_by: waiting ? dueAt : null,
    primary_source_id: opts.sourceId,
    confidence: opts.confidence,
  };
}

/** True when Accept would create a thread: transition(null, create) succeeds for this proposal. */
export function canAccept(p: Pick<ProposalView, "id" | "payload" | "confidence">, sourceId: string | null): boolean {
  const fields = createFieldsFromPayload(p.payload, { sourceId, confidence: p.confidence });
  if (!fields) return false;
  return transition(null, { type: "create", via: "accept", extractionItemId: p.id, fields }, { actor: "user" }).ok;
}

/** Proposals the tray shows: never Ignore (D3), never key_fact (no thread, D5). */
export function trayProposals(proposals: ProposalView[]): ProposalView[] {
  return proposals.filter((p) => (p.band as Band) !== "ignore" && p.payload.item.type !== "key_fact" && p.payload.label !== null);
}

/** Likely, Maybe, Also noticed, in that order; empty groups are left out. */
export function groupProposals(proposals: ProposalView[]): TrayGroup[] {
  const shown = trayProposals(proposals);
  return ORDER.map((band) => ({
    band,
    title: BAND_LABEL[band],
    collapsed: band === "low",
    items: shown.filter((p) => p.band === band),
  })).filter((g) => g.items.length > 0);
}

/**
 * Initial selection: pending Likely items that can be accepted are pre-checked; Maybe and Also
 * noticed are never pre-selected (F19, D3).
 */
export function initialSelection(proposals: ProposalView[], sourceId: string | null): Set<string> {
  return new Set(
    trayProposals(proposals)
      .filter((p) => p.band === "high" && p.reviewStatus === "pending" && canAccept(p, sourceId))
      .map((p) => p.id),
  );
}

/** Band counts of what the tray shows, for `proposals_shown`. */
export function bandCounts(proposals: ProposalView[]): Partial<Record<TrayBand, number>> {
  const out: Partial<Record<TrayBand, number>> = {};
  for (const p of trayProposals(proposals)) out[p.band] = (out[p.band] ?? 0) + 1;
  return out;
}

export const TRAY_COPY = {
  heading: (n: number) => `I found ${n} ${n === 1 ? "thing" : "things"} in this`,
  zero: "Nothing here needs your attention",
  acceptSelected: "Accept selected",
  rejectAll: "Reject all",
  reject: "Reject",
  rejected: "Rejected",
  undo: "Undo",
  /** `N threads added · View in Today` (SITE_CONTRACT §2.4). */
  resultCount: (n: number) => `${n} ${n === 1 ? "thread" : "threads"} added`,
  viewInToday: "View in Today",
  suggested: "Suggested",
  assumed: "Assumed",
  notSureAbout: "Not sure about",
  /** Proposed copy (not in SITE_CONTRACT): why a card's checkbox is disabled. */
  cannotAcceptWaiting: "I can't tell who this is waiting on, so it can't be added yet.",
  /** Proposed copy (not in SITE_CONTRACT): why Accept selected is disabled. */
  nothingSelected: "Nothing selected.",
} as const;
