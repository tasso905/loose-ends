/**
 * Deterministic conditional guard (user decision Nov 2, "3 yes"; a D36 change). A promise whose own
 * verified quote attaches a condition to it is capped at `speculative` certainty, so it is never
 * banded above Low, whatever the model labelled it ("if the venue confirms by Friday, I'll send
 * the invites on Monday").
 *
 * Triggers, in a leading or trailing clause: "if", "assuming", "provided (that)", "providing
 * (that)", "once", "as soon as".
 *
 * Not triggers (false positives the guard must not cap):
 *  - opt-out defaults: "unless I hear otherwise", "if I don't hear back", "if nobody objects"
 *    (golden 34 g4 is implied / Medium);
 *  - courtesies: "if you have questions, call me", "if needed", "if possible", "let me know if";
 *  - embedded questions: "I'll check if the room is free", "see if", "ask whether";
 *  - idioms: "as soon as possible", "once a week", "once again", "at once", "even if", "as if".
 *  - a trailing "once" / "as soon as" step on a promise that has its own date ("I'll send the files
 *    by Tuesday, once I've cleaned them up"): the date is the commitment and the clause only orders
 *    the work. Goldens 10 g0 and 12 g1 are explicit, dated, High; capping them would breach the
 *    zero-tolerance "explicit dated commitment scored Low" gate. A leading "once" or any "if" still
 *    caps.
 *
 * Content-free: returns only which kind of clause was found, never text.
 */

export type ConditionKind = "if" | "assuming" | "provided" | "once";
export interface ConditionFound {
  kind: ConditionKind;
  position: "leading" | "trailing";
}

/** Phrases removed before searching: they contain a trigger word but set no condition. */
const NOT_CONDITIONS: RegExp[] = [
  // Opt-out defaults: the promise happens unless someone objects.
  /\bif\s+(?:i|we)\s+(?:don['’]t|do\s+not|haven['’]t|have\s+not)\s+(?:hear|heard|get\s+a\s+reply)\b[^,.;!?]*/giu,
  /\bif\s+(?:you|nobody|no\s+one|no-one)\s+(?:don['’]t|doesn['’]t|do\s+not|does\s+not)\s+(?:object|reply|respond|say\s+otherwise|tell\s+me\s+otherwise)\b[^,.;!?]*/giu,
  /\bif\s+(?:nobody|no\s+one|no-one)\s+objects\b[^,.;!?]*/giu,
  /\bif\s+there\s+are\s+no\s+objections\b[^,.;!?]*/giu,
  // Courtesies.
  /\bif\s+(?:you|u)(?:['’]d\s+(?:like|prefer)|\s+(?:have|need|want|would\s+like|get\s+stuck|run\s+into|prefer|like))\b[^,.;!?]*/giu,
  /\bif\s+(?:needed|possible|necessary|so|not|any|anything|that\s+works|that\s+helps|it\s+helps|that['’]s\s+(?:ok|okay|easier|easiest|better))\b/giu,
  /\blet\s+(?:me|us)\s+know\s+if\b[^,.;!?]*/giu,
  // Embedded questions ("check if" = "check whether").
  /\b(?:see|check|ask|asked|asking|know|wonder|wondering|find\s+out|confirm|tell\s+(?:me|you|us))\s+if\b[^,.;!?]*/giu,
  // Idioms.
  /\b(?:even|as|what)\s+if\b/giu,
  /\bas\s+soon\s+as\s+(?:possible|you\s+can|i\s+can|we\s+can)\b/giu,
  /\basap\b/giu,
  /\bonce\s+(?:a|an|per|every|each)\s+(?:day|week|month|year|quarter|while|fortnight)\b/giu,
  /\bonce\s+(?:again|more|or\s+twice|in\s+a\s+while|upon\s+a\s+time)\b/giu,
  /\b(?:at|all\s+at|for)\s+once\b/giu,
];

const TRIGGERS: Array<[ConditionKind, RegExp]> = [
  ["if", /\bif\b/iu],
  ["assuming", /\bassuming\b/iu],
  ["provided", /\bprovid(?:ed|ing)(?:\s+that)?\s+(?=(?:that\s+)?(?:you|we|i|they|he|she|it|the|there|everything|nothing|all|our|your|my|his|her|their)\b)/iu],
  ["once", /\b(?:once|as\s+soon\s+as)\b/iu],
];

/** The promise's verb: what the condition is attached to. */
const PROMISE_VERB = /\b(?:i|we|you|he|she|they|it)['’]ll\b|\b(?:will|shall|going\s+to|gonna)\b|\bi\s+can\b/iu;

/**
 * The first condition attached in `quote`, or null. `dated` says the item has a due date of its own
 * (a trailing "once" step on a dated promise is not a condition; see above).
 */
export function findCondition(quote: string, dated: boolean): ConditionFound | null {
  const text = NOT_CONDITIONS.reduce((s, re) => s.replace(re, (m) => " ".repeat(m.length)), quote.replace(/[‘’]/g, "'"));
  const verb = PROMISE_VERB.exec(text);
  let best: (ConditionFound & { at: number }) | null = null;
  for (const [kind, re] of TRIGGERS) {
    const m = re.exec(text);
    if (!m) continue;
    const position = verb && m.index > verb.index ? "trailing" : "leading";
    if (kind === "once" && position === "trailing" && dated) continue;
    if (!best || m.index < best.at) best = { kind, position, at: m.index };
  }
  return best ? { kind: best.kind, position: best.position } : null;
}
