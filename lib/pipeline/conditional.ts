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
 *    the work: a self-controlled step on a firm, dated promise is not a condition on something that
 *    may not happen (confirmed by the coordinator, Nov 2; goldens 10 g0 and 12 g1 are explicit,
 *    dated, High). A leading "once" or any "if" still caps. The step must be the speaker's own
 *    (subject I / we: "once I've", "as soon as we get back") or only time passing ("once the clocks
 *    have changed", golden 12 g1); a step on anyone else's action or an outside event ("once the
 *    venue confirms", "once the contract is signed", "as soon as the labels print") caps (T-G1, Nov 2).
 *  - a trigger in another sentence of the quote than the promise ("I'll call you back. If I don't
 *    pick up, text me."): a condition is attached only within the promise's own sentence (T-G2).
 *  - "provided" as a verb ("the slides I provided the board"): after a subject or auxiliary it is
 *    the verb, not "provided (that)" (T-G2).
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
  ["provided", /(?<!\b(?:i|we|you|they|he|she|it|who|which|that|was|were|be|been|being|is|are|am|has|have|had|having)\s+)\bprovid(?:ed|ing)(?:\s+that)?\s+(?=(?:that\s+)?(?:you|we|i|they|he|she|it|the|there|everything|nothing|all|our|your|my|his|her|their)\b)/iu],
  ["once", /\b(?:once|as\s+soon\s+as)\b/iu],
];

/** The promise's verb: what the condition is attached to. */
const PROMISE_VERB = /\b(?:i|we|you|he|she|they|it)['’]ll\b|\b(?:will|shall|going\s+to|gonna)\b|\bi\s+can\b/iu;

const isOwnOrTimeStep = (rest: string) => OWN_STEP.test(rest) || TIME_STEP.test(rest);

/** A trailing step the speaker controls: "once I've cleaned them up", "as soon as we're back". */
const OWN_STEP = /^\s*(?:i|we)(?:['’](?:ve|m|re|d|ll)|\s+(?:have|am|are|had|can|get|got|finish|finished|wrap|wrapped))?\b/iu;

/**
 * A trailing step that is only time passing, which no one has to do and which cannot fail to happen:
 * "once the clocks have changed", "as soon as the holidays are over" (golden 12 g1 is explicit, High).
 */
const TIME_STEP = /^\s*(?:the\s+)?(?:clocks?|holidays?|weekend|week|month|quarter|term|semester|season|new\s+year|long\s+weekend)\b/iu;

/** Abbreviations whose period does not end a sentence. */
const ABBREV = /\b(?:dr|mr|mrs|ms|st|vs|etc|e\.g|i\.e|a\.m|p\.m|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|no)\.$/iu;

/**
 * The parts of `text` the condition search covers: the sentences that hold a promise verb, or the
 * whole text when none does. Same length as `text` (other sentences are blanked), so indices hold.
 */
function promiseSentences(text: string): string {
  const spans: Array<[number, number]> = [];
  let start = 0;
  const end = /[.!?]+(?=\s+["'(]?[A-Z])/g;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const stop = m.index + m[0].length;
    if (ABBREV.test(text.slice(start, stop))) continue;
    spans.push([start, stop]);
    start = stop;
  }
  spans.push([start, text.length]);
  const keep = spans.filter(([a, b]) => PROMISE_VERB.test(text.slice(a, b)));
  if (keep.length === 0 || keep.length === spans.length) return text;
  return spans.map(([a, b]) => (keep.some(([k]) => k === a) ? text.slice(a, b) : " ".repeat(b - a))).join("");
}

/**
 * The first condition attached in `quote`, or null. `dated` says the item has a due date of its own
 * (a trailing "once" step on a dated promise is not a condition; see above).
 */
export function findCondition(quote: string, dated: boolean): ConditionFound | null {
  const text = promiseSentences(
    NOT_CONDITIONS.reduce((s, re) => s.replace(re, (m) => " ".repeat(m.length)), quote.replace(/[‘’]/g, "'")),
  );
  const verb = PROMISE_VERB.exec(text);
  let best: (ConditionFound & { at: number }) | null = null;
  for (const [kind, re] of TRIGGERS) {
    const m = re.exec(text);
    if (!m) continue;
    const position = verb && m.index > verb.index ? "trailing" : "leading";
    if (kind === "once" && position === "trailing" && dated && isOwnOrTimeStep(text.slice(m.index + m[0].length))) continue;
    if (!best || m.index < best.at) best = { kind, position, at: m.index };
  }
  return best ? { kind: best.kind, position: best.position } : null;
}
