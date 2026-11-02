/**
 * Decisions / Ask Why copy (SITE_CONTRACT §2.11, §2.13, CONTENT_MODEL §10, DESIGN_STANDARD "Ask Why
 * answer card"). Client-safe.
 *
 * PROPOSED copy (not in the docs; needs the user's approval):
 *   - the Ask button: `Ask`
 *   - the decision list's heading: `Recorded decisions`
 *   - the list's load failure: `I couldn't load your decisions.` (+ the documented `Try again`)
 *   - the thread-detail link to Ask Why (SITE_CONTRACT §3.1 names the link, not its words): `Ask why`
 *   - the empty-question fallback `Write a question first.` (lib/errors.ts; Ask is disabled while
 *     the box is empty, so it is rarely seen)
 */
export const DECISIONS_COPY = {
  heading: "Decisions",
  askPlaceholder: "Ask about a past decision",
  /** PROPOSED. */
  ask: "Ask",
  youDecided: "You decided",
  youWrote: "You wrote:",
  fromSource: "From the source:",
  interpretation: "Interpretation:",
  openThread: "Open thread",
  noReason: "You didn't record a reason for this decision.",
  /** PROPOSED. */
  listHeading: "Recorded decisions",
  empty: "Decisions you record when resolving threads will appear here.",
  /** PROPOSED. */
  loadFailed: "I couldn't load your decisions.",
  tryAgain: "Try again",
  /** PROPOSED. */
  askWhyLink: "Ask why",
} as const;
