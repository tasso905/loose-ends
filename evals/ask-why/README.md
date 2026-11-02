# Ask-why eval set

Synthetic data for the Ask-why eval: 10 answerable and 10 unanswerable questions, gate 0 fabrications (PRD F12, Testing Strategy, eval gate Oct 28). The runner is wired into `pnpm eval` (slice S9): it runs after the extraction fixtures, with the same model and throttle.

## Files

| File | Contents |
| --- | --- |
| `decisions.json` | One fictional user's decision memory: 12 decisions. Two have no recorded reason (`reason_user: null`, the Skip path). |
| `questions.json` | 20 questions: `a01`–`a10` answerable, `u01`–`u10` unanswerable. |
| `set.ts` | Zod schemas, `loadAskWhySet()` and `judgeAskWhy()`, which scores one answer. No side effects, no env, no model calls. |
| `retrieve.ts` | The real F12 retrieval: an in-process Postgres (PGlite) with every migration applied, `decisions.json` seeded for one eval user, queried through `public.search_decisions`. No network, no env. |
| `harness.ts` | `runAskWhyEval()`: retrieve, call `askWhy()`, judge each question; the report holds IDs, counts and enums only (rule 9). |

### `decisions.json`

```jsonc
{
  "user": { "display_name": "Jordan Ellis", "aliases": [...] },
  "timezone": "America/New_York",
  "asked_at": "2026-10-28T15:00:00.000Z",   // every decided_at is before this
  "decisions": [
    {
      "id": "<uuid>",                         // decisions.id
      "thread_id": "<uuid>",                  // threads.id
      "thread_title": "Car insurance renewal",// threads.title (joined, D31)
      "counterparty": "Northwind Mutual",     // threads.counterparty (joined), or null
      "choice": "...",                        // decisions.choice
      "reason_user": "..." | null,            // decisions.reason_user, verbatim; null = skipped
      "decided_at": "<ISO instant>",
      "context_facts": [{ "text": "...", "evidence_id": "<uuid>" | null }]
    }
  ]
}
```

Each decision has exactly the fields of `RetrievedDecision` in `lib/ai/askWhy.ts`, so the runner can pass retrieved records straight to `askWhy()`. The IDs are valid UUIDs, so the set can also be seeded into Postgres for an eval user. `evidence_id`s are not foreign keys in the `context_facts` JSON.

### `questions.json`

```jsonc
// answerable
{ "id": "a01", "question": "...", "answerable": true,
  "expect": { "decision_ids": ["<uuid>"],          // must be retrieved (top 5) and cited
              "user_reason": "required" | "absent" } } // absent: no reason was recorded
// unanswerable: retrieval must return zero rows; no LLM call; the no-record message
{ "id": "u01", "question": "...", "answerable": false }
```

Every unanswerable question is expected to return **zero retrieved decisions**. `askWhy()` then returns `I don't have a recorded decision about that.` without calling the model (rule 7).

## Retrieval contract

The PRD's retrieval runs Postgres full-text search over choice + reason, joined with the thread title and counterparty, and takes the top 5. `tests/integration/ask-why-retrieval.test.ts` checks the set against real Postgres English text search (PGlite):

- **Unanswerable:** no question shares a single lexeme with any decision. So retrieval returns zero rows under any term semantics, including the loosest (all question lexemes OR'd).
- **Answerable:** each question shares at least one lexeme with its expected decision. With the lexemes OR'd and ordered by `ts_rank`, the expected decision ranks first in every case.
- **AND semantics** (`plainto_tsquery` over the raw question) find the expected decision for only 5 of the 10 answerable questions, because question words like "choose", "pick", "get" and "go" are not in the stored text. S9 should OR the lexemes, or drop question words before querying. Otherwise the answerable half fails at retrieval, not at the model.

S9 ORs the lexemes (migration `20261022172128_ask_why_search.sql`). `tests/integration/ask-why-search.test.ts` runs the set through the real `search_decisions`: every answerable question ranks its decision first, every unanswerable one returns zero rows. If retrieval changes (for example, it also searches `context_facts`), re-run both tests. An unanswerable question that retrieves rows is a set problem to fix here, not a pass.

## Running it

`pnpm eval` runs it after the extraction eval (`evals/run.ts`). For each question:

1. Retrieve with `public.search_decisions` over the seeded PGlite copy (`retrieve.ts`), which gives `retrievedIds`.
2. Call `askWhy(question, retrievedDecisions)` with the configured model (live) or the recordings (`AI_PROVIDER=fake AI_MODEL=recorded`, `tests/fixtures/llm/ask-why-eval-a*.ask-why.json`). Unanswerable questions retrieve nothing, so they never reach the model and need no recording.
3. Call `judgeAskWhy(question, decisions, retrievedIds, answer)`, which returns `{ fabrications[], misses[] }`.

Output: `evals/results/ask-why-<timestamp>.json` (per-question report) and an Ask-why row in the scorecard with model, prompt version (`ask-why.v2`), schema version (`ask-why.v1`), fabrications, answerable hit rate and model calls. The fake provider only checks the harness; it says nothing about a live model.

**Fabrications** (gate: 0 across all 20 questions):

- `answered_unanswerable`: an answer to an unanswerable question, or a no-record answer whose message is not the exact no-record copy.
- `llm_called_on_zero_match`: zero records were retrieved, but the model was called anyway.
- `cited_outside_retrieved`: the answer cites a decision that was not retrieved.
- `reason_not_stored`: a "You wrote" part that is not the decision's whole stored reason, or that belongs to a decision with no reason.
- `fact_not_stored`: a "From the source" part that is not one of the decision's stored facts.

**Misses** are reported but not gated:

- `retrieved_for_unanswerable`
- `expected_not_retrieved`
- `not_answered`
- `expected_not_cited`
- `reason_missing`

The scorecard reports the answerable hit rate (no misses) next to the fabrication count, with model, prompt version and schema version. A run passes with 0 fabrications and no failed calls; if every failure is provider quota, it is `incomplete_quota` and not judged (D43).

**Manual check:** `a05` and `a10` have no recorded reason. An `inference` part that presents a reason as if the user gave it (for example "You chose it because it was cheaper") is a fabrication the judge cannot detect from structure alone. Review the inference parts on those two questions in every live run.

## Adding questions

Keep the data synthetic, and use reserved example domains for any email address. Every new unanswerable question must pass the zero-row test above. Every new answerable question must rank its decision in the top 5. Then run `pnpm test`.
