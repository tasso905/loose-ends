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
  /\b(?:if|assuming)\s+(?:i|we)\s+(?:don['’]t|do\s+not|haven['’]t|have\s+not)\s+(?:hear|heard|get\s+an?\s+(?:reply|response|answer))\b[^,.;!?]*/giu,
  /\bif\s+(?:i|we)\s+hear\s+nothing\b[^,.;!?]*/giu,
  /\bif\s+(?:you|nobody|no\s+one|no-one)\s+(?:don['’]t|doesn['’]t|do\s+not|does\s+not)\s+(?:object|reply|respond|say\s+otherwise|tell\s+me\s+otherwise)\b[^,.;!?]*/giu,
  /\b(?:if|assuming)\s+(?:nobody|no\s+one|no-one)\s+(?:objects|says\s+otherwise)\b[^,.;!?]*/giu,
  /\bif\s+there\s+are\s+no\s+objections\b[^,.;!?]*/giu,
  // Courtesies.
  // "have" only with what a courtesy is about: "If you have the contract signed by Thursday" is a real condition.
  /\bif\s+(?:you|u)\s+have\s+(?:no\s+(?:(?:more|further|other)\s+)*(?:objections?|questions?|issues?|concerns?|problems?)|(?:(?:any|a|an|some|more|further|other)\s+)*(?:questions?|issues?|concerns?|problems?|trouble|comments?|thoughts?|objections?|feedback|time|minute|moment|sec|second|chance))\b[^,.;!?]*/giu,
  /\bif\s+(?:you|u)(?:['’]d\s+(?:like|prefer)|\s+(?:need|want|wish|would\s+like|get\s+stuck|run\s+into|prefer|like|don['’]t\s+mind))\b[^,.;!?]*/giu,
  /\bif\s+(?:needed|possible|necessary|so|not|any|anything)\b/giu,
  // Only as a courtesy to the reader: "if that's fine with the board" is a real condition.
  /\bif\s+(?:that\s+works|that\s+helps|it\s+helps|(?:that|it)['’]s\s+(?:ok|okay|fine|alright|all\s+right|easier|easiest|better))(?=\s*(?:[,.;:!?)]|$|(?:with|for|by)\s+(?:you|u|everyone|all)\b))/giu,
  /\blet\s+(?:me|us|you|them|him|her)\s+know\b[^,.;!?]*?\bif\b[^,.;!?]*/giu,
  // Embedded questions ("check if" = "check whether").
  /\b(?:see|check|ask|asked|asking|know|wonder|wondering|find\s+out|confirm|verify|decide|determine|figure\s+out|tell\s+(?:me|you|us))(?:\s+by\s+\w+)?\s+if\b[^,.;!?]*/giu,
  // Idioms.
  /\b(?:even|as|what)\s+if\b/giu,
  /\bas\s+soon\s+as\s+(?:possible|you\s+can|i\s+can|we\s+can|today|tonight|tomorrow|next\s+\w+|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b(?!['’])/giu,
  /\basap\b/giu,
  /\bonce\s+(?:a|an|per|every|each)\s+(?:day|week|month|year|quarter|while|fortnight)\b/giu,
  /\bonce\s+(?:again|more|or\s+twice|in\s+a\s+while|upon\s+a\s+time|and\s+for\s+all)\b/giu,
  /\b(?:just\s+this|at\s+least|more\s+than)\s+once\b/giu,
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

/** "...and the client approves", "...and Sam signs off": a second clause someone else has to do (T-G10, T-G12). */
const JOINED_OTHER =
  /\b(?:and|or|but)\s+(?:(?:the|a|an|my|our|your|his|her|their|this|that)\s+[\p{L}-]+(?:\s+[\p{L}-]+)?|(?!I\b|We\b)\p{Lu}[\p{L}-]*)\s+(?:[\p{L}-]+(?:s|ed)|is|are|was|were|has|have|will|gets?|goes)\b/u;

const isOwnOrTimeStep = (rest: string) => {
  const clause = rest.split(/[,.;:!?]/u)[0]!;
  return !JOINED_OTHER.test(clause) && (isOwnStep(clause) || TIME_STEP.test(clause));
};

/** Auxiliaries and adverbs between "I" / "we" and the step's verb ("I've just", "we will finally"). */
const STEP_AUX = new Set(["have", "has", "had", "will", "would", "can", "could", "should", "just", "finally", "first", "both", "all", "also", "actually", "eventually", "really", "only", "already", "then"]);
/** "am / are / was / be..." before a participle: the step is done to the speaker ("once I'm paid"). */
const BE = new Set(["am", "are", "is", "was", "were", "be", "been", "being"]);
/** Receiving or waiting: the step depends on someone else ("once I hear from the venue"; T-G4). */
const WAITING = new Set(["hear", "heard", "hearing", "receive", "received", "receiving", "wait", "waited", "waiting", "know", "learn", "learned"]);
/** Participles after "be": told, paid, approved... by someone else (T-G4, T-G10). */
const DONE_TO = new Set([
  "told", "paid", "approved", "given", "granted", "signed", "allowed", "cleared", "notified", "invited", "asked", "sent", "contacted",
  "reimbursed", "informed", "authorized", "authorised", "confirmed", "accepted", "hired", "assigned", "funded",
]);
/** What someone else gives: "once I have approval", "once we have the go-ahead" (T-G10). */
const RECEIVED = new Set([
  "approval", "go-ahead", "ok", "okay", "sign-off", "signoff", "permission", "funds", "money", "deposit", "payment",
  "confirmation", "clearance", "authorization", "authorisation", "answer", "reply", "response", "word", "access", "green",
]);
/** "have" + this is the auxiliary ("I've paid the deposit"), so what follows is the speaker's own work. */
const PARTICIPLE = /(?:ed|^(?:paid|sent|done|made|written|given|taken|seen|read|told|got|gotten|had|built|put|set|met|won|drawn|shown|chosen|spoken|brought|bought|left|held|kept|found|run))$/u;
const GET = new Set(["get", "gets", "got", "gotten", "getting"]);
/**
 * "get" is the speaker's own doing or own time only in these wordings (coordinator, T-G9); any other
 * "get" caps, because an unknown wording landing on Low is the safe side: "get paid", "get approval",
 * "get the go-ahead", "get it from Sam".
 */
const GET_OWN = new Set(["back", "home", "in", "there", "through", "to", "started", "going", "set", "settled", "round", "around", "off", "up", "done", "ready"]);
const GET_OWN_TIME = /^(?:(?:a|an)\s+(?:chance|minute|moment|sec|second|break)|some\s+time|time)\b/u;
/** Causative: "get everything sorted", "get my notes together", "get the kids to bed", "get it done". */
const GET_CAUSED = /^(?:[\p{L}'-]+\s+){1,4}(?:sorted|together|done|ready|finished|to\s+bed)\b/u;

function isOwnGet(after: string[]): boolean {
  if (GET_OWN.has(after[0] ?? "")) return true;
  const rest = after.join(" ");
  return GET_OWN_TIME.test(rest) || GET_CAUSED.test(rest);
}

/**
 * A trailing step the speaker performs: subject I / we and an action verb ("once I've cleaned them
 * up", "as soon as I finish the edits", "once we're back"). Receiving or waiting ("once I hear from
 * the venue", "once we get approval", "once I have approval", "once I find out", "once I'm told") is
 * not their own step (T-G4, T-G10).
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
  let have = false;
  while (i < words.length && (STEP_AUX.has(words[i]!) || BE.has(words[i]!))) {
    passive ||= BE.has(words[i]!);
    have ||= words[i] === "have" || words[i] === "had";
    i += 1;
  }
  const verb = words[i];
  if (!verb) return passive; // "once I'm", "as soon as we are": nothing waited on
  if (WAITING.has(verb)) return false;
  if ((verb === "find" || verb === "found") && words[i + 1] === "out") return false;
  if (passive && DONE_TO.has(verb)) return false;
  if (GET.has(verb)) return isOwnGet(words.slice(i + 1));
  // "have" as the main verb: any word of the step can be what is received ("have final approval"; T-G18).
  if (have && !PARTICIPLE.test(verb) && words.slice(i).some((w) => RECEIVED.has(w))) return false;
  return true;
}

/**
 * A trailing step that is only time passing, which no one has to do and which cannot fail to happen:
 * "once the clocks have changed", "as soon as the holidays are over", "once the week's over"
 * (golden 12 g1 is explicit, High). Only the period itself ending, starting or changing counts; a
 * period word that names whose thing someone else acts on ("once the month's invoices are
 * approved", "once the season tickets go on sale") caps (T-G5). Must be the whole clause up to any
 * date words: "once the month is over and the invoices are approved" caps (T-G12, JOINED_OTHER).
 */
const TIME_STEP = new RegExp(
  String.raw`^\s*(?:the\s+)?(?:` +
    String.raw`clocks?\s+(?:(?:have|has)\s+(?:changed|gone\s+(?:back|forward))|change|go\s+(?:back|forward))` +
    String.raw`|(?:(?:this|next)\s+)?(?:holidays?|weekend|week|month|quarter|term|semester|season|new\s+year|long\s+weekend)` +
    String.raw`(?:'s\s+over|'re\s+over|\s+(?:(?:is|are)\s+over|ends?|(?:has|have)\s+(?:ended|changed|started|begun|passed)|starts?|begins?))` +
    String.raw`)\b`,
  "iu",
);

/** Abbreviations whose period does not end a sentence by itself. */
const ABBREV = /^(?:dr|mr|mrs|ms|st|vs|etc|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|no)\.$/iu;
/** Words that open a new sentence even after an abbreviation: triggers and subject pronouns. */
const OPENER = /^(?:if|once|assuming|provided|providing|as\s+soon|only|but|unless|(?:i|we|you|he|she|they|it)(?:'\p{L}+)?)$/iu;

/**
 * Whether a period ends the sentence (T-G6, T-G13, T-G14). When in doubt it does not, so a condition
 * stays attached to its promise and caps (the safe side):
 *  - before an opener ("If", "I'll"): it ends, except a lowercase opener after an abbreviation-shaped
 *    word ("a.m. if", "Inc. if");
 *  - before lowercase or a number ("Fri. at 9", "Inc. on Friday", "approx. 40"): it does not;
 *  - before any other capital: it ends after an ordinary word ("back. Thanks"), not after an
 *    abbreviation-shaped one ("a.m. Friday", "U.S. Senate", "Prof. Lin").
 */
function periodEndsSentence(head: string, after: string): boolean {
  const prev = (head.trimEnd().split(/\s+/u).pop() ?? "").replace(/^["'“‘(]+/u, "").replace(/["'”’)]+$/u, "");
  const next = /^\s*["'“‘(]*([\p{L}\d'-]+(?:\s+soon\b)?)/u.exec(after)?.[1];
  if (!next) return true;
  const capital = /^\p{Lu}/u.test(next);
  const shaped = /\p{L}\.\p{L}/u.test(prev) || ABBREV.test(prev) || /^\p{Lu}\p{L}{0,4}\.$/u.test(prev);
  if (OPENER.test(next)) return capital || !shaped;
  return capital && !shaped;
}

/** Sentence spans of `text`: ends at ! ? ; or a line break, and at a period by the rule above (T-G15). */
function sentences(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  const end = /[.!?]+["'”’)]*(?=\s)|;|[\r\n]+/gu;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const stop = m.index + m[0].length;
    if (m[0].startsWith(".") && !m[0].startsWith("..") && !periodEndsSentence(text.slice(start, stop), text.slice(stop))) continue;
    spans.push([start, stop]);
    start = stop;
  }
  spans.push([start, text.length]);
  return spans;
}

/** Words that may stand around a condition fragment without being a main clause of their own. */
const FRAGMENT_FILLER = /^(?:only|though|but|and|just|then|of|course|obviously|naturally|ok|okay|so|that|is|all|really|still|well|again|also|however|remember|note|yes|yeah|sure|oh|um)$/iu;
/** After the condition's comma, these continue the condition rather than open a main clause (T-G8). */
const CONTINUES_CONDITION = /^[\s,;:–—-]*(?:and|or|by|on|at|in|before|after|until|till)\b/iu;
const ASIDE = /\b(?:i\s+mean|i\s+guess|i\s+think|i\s+suppose|you\s+know)\b/giu;
/** Where a condition clause ends when it is written with punctuation. */
const CLAUSE_END = /[,;:]|\s[-–—]\s/u;
/** Instructions that open a main clause with no comma before them ("If I'm out text me"; T-G7). */
const IMPERATIVE = new Set(["text", "call", "email", "message", "ping", "ring", "phone", "leave", "tell", "ask", "start", "go", "ignore", "skip", "use", "try", "let", "wait", "grab", "reach", "contact", "please", "just", "feel", "don't"]);
/** A word before a verb form that makes it part of the condition ("if they can call", "if I don't call"). */
const NOT_BEFORE_IMPERATIVE = new Set(["to", "can", "will", "would", "could", "should", "might", "may", "must", "don't", "doesn't", "didn't", "won't", "can't", "not", "and", "or", "all", "both", "just", "then", "also"]);
const SUBJECT_PRONOUN = /^(?:i|we|you|he|she|they|it|that|this)(?:'\p{L}+)?$/u;
const FINITE_VERB = /^(?:[\p{L}-]+(?:s|ed)|is|are|was|were|has|have|had|am|did|does|do)$/u;

/**
 * A condition clause that runs on into an instruction with no comma: "I don't pick up text me", "it's
 * urgent call Priya instead". The words before the instruction must already read as a clause
 * (a pronoun subject, or a finite verb): "If they call" and "If the venue people leave" do not.
 */
function runsIntoInstruction(clause: string): boolean {
  const words = clause.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
  for (let i = 2; i < words.length; i += 1) {
    if (!IMPERATIVE.has(words[i]!) || NOT_BEFORE_IMPERATIVE.has(words[i - 1]!)) continue;
    const before = words.slice(0, i);
    if (SUBJECT_PRONOUN.test(before[0]!) || before.slice(1).some((w) => FINITE_VERB.test(w))) return true;
  }
  return false;
}

/**
 * A sentence with no promise verb that is only a condition clause: "Only if the venue confirms,
 * though.", "If the venue confirms by Friday.", "Assuming the budget passes." It belongs to the
 * neighbouring promise (T-G3), also with words around it: "Well, only if the venue confirms, I mean."
 * (T-G8). A trigger sentence with a main clause of its own, with or without a
 * comma ("If I don't pick up, text me.", "If I don't pick up text me."), does not (T-G7).
 */
function isConditionFragment(sentence: string): boolean {
  for (const [, re] of TRIGGERS) {
    const m = re.exec(sentence);
    if (!m) continue;
    const after = sentence.slice(m.index + m[0].length);
    const stop = after.search(CLAUSE_END);
    const clause = stop < 0 ? after : after.slice(0, stop);
    const before = sentence.slice(0, m.index);
    const tail = (stop < 0 ? "" : after.slice(stop)).replace(ASIDE, " ");
    // "only if" is a condition whatever comes before it; a tail like "and the budget passes" is more of it.
    const rest = `${/\bonly\s*$/iu.test(before) ? "" : before} ${CONTINUES_CONDITION.test(tail) ? "" : tail}`;
    if (runsIntoInstruction(clause)) continue;
    if (rest.split(/[^\p{L}']+/u).filter(Boolean).every((w) => FRAGMENT_FILLER.test(w))) return true;
  }
  return false;
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
