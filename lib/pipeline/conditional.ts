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

const isOwnOrTimeStep = (rest: string) => isOwnStep(rest) || TIME_STEP.test(rest);

/** Auxiliaries and adverbs between "I" / "we" and the step's verb ("I've just", "we will finally"). */
const STEP_AUX = new Set(["have", "has", "had", "will", "would", "can", "could", "should", "just", "finally", "first", "both", "all", "also"]);
/** "am / are / was / be..." before a participle: the step is done to the speaker ("once I'm paid"). */
const BE = new Set(["am", "are", "is", "was", "were", "be", "been", "being"]);
/** Receiving or waiting: the step depends on someone else ("once I hear from the venue"; T-G4). */
const WAITING = new Set(["hear", "heard", "hearing", "receive", "received", "receiving", "wait", "waited", "waiting"]);
/** Participles after "be": told, paid, approved... by someone else (T-G4). */
const DONE_TO = new Set([
  "told", "paid", "approved", "given", "allowed", "cleared", "notified", "invited", "asked", "sent", "contacted",
  "reimbursed", "informed", "authorized", "authorised", "confirmed", "accepted", "hired", "assigned", "funded",
]);
/** "get" / "got" that is the speaker's own doing ("once I get back", "once we get it done"); any other "get" waits ("get paid", "get approval", "get the go-ahead"). */
const GET = new Set(["get", "gets", "got", "gotten", "getting"]);
const GET_OWN = new Set(["back", "home", "in", "there", "through", "to", "it", "this", "done", "started", "going", "set", "settled", "round", "around", "off", "ready", "up"]);

/**
 * A trailing step the speaker performs: subject I / we and an action verb ("once I've cleaned them
 * up", "as soon as I finish the edits", "once we're back"). Receiving or waiting ("once I hear from
 * the venue", "once we get approval", "once I get paid", "once I'm told") is not their own step (T-G4).
 */
function isOwnStep(rest: string): boolean {
  const m = /^\s*(i|we)\b(.*)$/isu.exec(rest);
  if (!m) return false;
  const words = m[2]!
    .replace(/'ve\b/giu, " have").replace(/'m\b/giu, " am").replace(/'re\b/giu, " are").replace(/'d\b/giu, " had").replace(/'ll\b/giu, " will")
    .toLowerCase()
    .split(/[^a-z-]+/u)
    .filter(Boolean);
  let i = 0;
  let passive = false;
  while (i < words.length && (STEP_AUX.has(words[i]!) || BE.has(words[i]!))) passive ||= BE.has(words[i++]!);
  const verb = words[i];
  if (!verb) return passive; // "once I'm", "as soon as we are": nothing waited on
  if (WAITING.has(verb)) return false;
  if (passive && DONE_TO.has(verb)) return false;
  if (GET.has(verb)) return GET_OWN.has(words[i + 1] ?? "");
  return true;
}

/**
 * A trailing step that is only time passing, which no one has to do and which cannot fail to happen:
 * "once the clocks have changed", "as soon as the holidays are over", "once the week is over"
 * (golden 12 g1 is explicit, High). Only the period itself ending, starting or changing counts; a
 * period word that names whose thing someone else acts on ("once the month's invoices are
 * approved", "once the season tickets go on sale") caps (T-G5).
 */
const TIME_STEP = new RegExp(
  String.raw`^\s*(?:the\s+)?(?:` +
    String.raw`clocks?\s+(?:(?:have|has)\s+(?:changed|gone\s+(?:back|forward))|change|go\s+(?:back|forward))` +
    String.raw`|(?:(?:this|next)\s+)?(?:holidays?|weekend|week|month|quarter|term|semester|season|new\s+year|long\s+weekend)\s+` +
    String.raw`(?:(?:is|are|'s|'re)\s+over|ends?|(?:has|have)\s+(?:ended|changed|started|begun|passed)|starts?|begins?)` +
    String.raw`)\b`,
  "iu",
);

/** Abbreviations whose period does not end a sentence. */
const ABBREV = /\b(?:dr|mr|mrs|ms|st|vs|etc|e\.g|i\.e|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|no)\.$/iu;
/** "a.m." / "p.m." end a sentence only before a capital ("at 9 a.m. If you're busy..."; T-G6). */
const CLOCK_END = /\b[ap]\.m\.$/iu;

/** Words that may stand around a condition fragment without being a main clause of their own. */
const FRAGMENT_FILLER = /^(?:only|though|but|and|just|then|of|course|obviously|naturally|ok|okay|so|that|is|all|really|still)$/iu;

/**
 * A sentence with no promise verb that is only a condition clause: "Only if the venue confirms,
 * though.", "If the venue confirms by Friday.", "Assuming the budget passes." It belongs to the
 * neighbouring promise (T-G3). A trigger sentence with a main clause of its own ("If I don't pick
 * up, text me.") does not.
 */
function isConditionFragment(sentence: string): boolean {
  for (const [, re] of TRIGGERS) {
    const m = re.exec(sentence);
    if (!m) continue;
    const clauseEnd = sentence.slice(m.index).search(/[,;:]/u);
    const rest =
      sentence.slice(0, m.index) + " " + (clauseEnd < 0 ? "" : sentence.slice(m.index + clauseEnd));
    if (rest.split(/[^\p{L}']+/u).filter(Boolean).every((w) => FRAGMENT_FILLER.test(w))) return true;
  }
  return false;
}

/** Sentence spans of `text` (T-G6: any casing after the stop, straight or curly quotes, "a.m."). */
function sentences(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  const end = /[.!?]+["'”’)]?(?=\s+\S)/gu;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const stop = m.index + m[0].length;
    const head = text.slice(start, stop);
    if (ABBREV.test(head)) continue;
    if (CLOCK_END.test(head) && !/^\s+["'“‘(]?\p{Lu}/u.test(text.slice(stop))) continue;
    spans.push([start, stop]);
    start = stop;
  }
  spans.push([start, text.length]);
  return spans;
}

/**
 * The parts of `text` the condition search covers: the sentences that hold a promise verb, plus
 * condition fragments that attach to them, or the whole text when no sentence has a promise verb.
 * Same length as `text` (other sentences are blanked), so indices hold.
 */
function promiseSentences(text: string): string {
  const spans = sentences(text);
  const keep = spans.map(([a, b]) => {
    const sentence = text.slice(a, b);
    return PROMISE_VERB.test(sentence) || isConditionFragment(sentence);
  });
  if (!spans.some(([a, b]) => PROMISE_VERB.test(text.slice(a, b)))) return text;
  return spans.map(([a, b], i) => (keep[i] ? text.slice(a, b) : " ".repeat(b - a))).join("");
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
