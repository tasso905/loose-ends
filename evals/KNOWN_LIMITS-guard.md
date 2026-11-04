# Known limits of the conditional guard and possessive dates

Kept here until `docs/AI_BEHAVIOR.md` is written; move this list there then.

The conditional guard (`lib/pipeline/conditional.ts`, D64(c)) caps a promise with a condition at Low. It is rule-based and reads only the item's own quotes, so a condition outside the quoted text can't cap it. Each example below was run against the code. Most are pinned in `tests/unit/tester-guard-followups-3.test.ts`, so a change gets noticed.

## Under-caps: a conditional promise with a date stays High

This is the unsafe direction.

- "if you need..." or "if you like..." with an object reads as a courtesy: "If you need the deck, I'll send it Monday.", "If you like the design, we'll order it Friday."
- A condition-only sentence that opens with other words: "I'll send it Monday. That's if the venue confirms.", "I'll send it Monday. Just to be clear, if the venue confirms."
- A tail after the comma that reads as a main clause: "I'll send it Monday. If the venue confirms, Friday works."
- A verb in the condition from the instruction list reads as a main clause: "I'll send it Monday. If they let me go early."
- A step off the waiting lists counts as the speaker's own: "once I have the numbers", "once I see the contract".
- A joined clause is missed when:
  - the name is lowercase: "once the week ends and sam signs off"
  - the subject is a pronoun: "once I've cleaned up and they approve"
  - a comma comes first: "once I've cleaned up, and the client approves"
- "am" without inner dots reads as a sentence end: "I'll call at 9 am. Friday if the venue confirms."
- A participle straight after "have" reads as the speaker's own work: "once I have signed approval", "once I have written approval", "once I have written confirmation", "once I have confirmed funding".
- "if you have any..." with a courtesy noun reads as a courtesy: "If you have any objections, I'll rework it Friday."

## Over-caps: a firm promise with a date drops to Low

This is the safe direction, and these trade-offs were accepted.

- A short capitalised word before a new sentence: "I'll call Sam. Text me if I don't pick up."
- A no-comma instruction with a verb off the list: "I'll call you Friday. If I'm late save me a seat.", "I'll call you Friday. If it rains we stay in."
- A compound plural after "and": "once I've finished the deck and the client notes", "once I've cleaned up and the kids are in bed".
- Lowercase chat: "i'll call you friday. text me if i don't pick up".
- A "get" outside the exempt set: "once I get a few minutes".
- Both sentences hold a promise verb: "I'll call you back. If I can't, I'll send a text."
- With "have" as the main verb, a listed word anywhere in the step caps: "once I have a draft response", "once I have a word with Sam", "once I have a quick word with Sam", "once I have the payment details", "once I have the reply drafted".
- "no" counts as an opt-out only before objections, questions, issues, concerns and problems: "If you have no comments, I'll send it Friday."
- An irregular participle off the list reads as main-verb "have": "once I've spent the money", "once I've come up with an answer".

## Possessive dates

- An ordinal followed by a noun reads as a day: "June's 15th birthday" gives Jun 15, flagged inferred.
- The end/start removal covers only May, June, April and August: "December's end" gives Dec 1, flagged inferred.
- Months that aren't first names keep the old reading: "March's meeting" gives Mar 1, flagged inferred.
- For May, June, April and August, only a fixed noun list counts as a date: "June's party" gives no date, even when the month is meant.
