# Trust Scorecard

- Model: google:gemini-3.6-flash
- Prompt version: extract.v4 (sha256 c1cea18ea137)
- Schema version: extraction.v1
- Run date: 2026-11-04T21:39:17.523Z
- Fixtures: 42 (14 ambiguous)
- Throttle: 30 requests/min
- Extra attempts after provider unavailable: 0 (0 fixtures, 0 rounds, 0 still unavailable)

Result: PASS

| Metric | Result | Threshold | How it's measured |
| --- | --- | --- | --- |
| Precision | 93.8% | ≥ 75.0% | Shown items matching a golden item ÷ all shown items (every type except key facts) |
| Recall | 97.6% | ≥ 80.0% | Golden items shown ÷ all golden items; a failed fixture's items count as missed |
| Date accuracy | 98.9% | ≥ 95.0% | Correct due dates ÷ matched items where the golden or the prediction has a date (an invented date is an error) |
| Owner accuracy | 100.0% | ≥ 90.0% | Correct owner ÷ matched items |
| Verified quotations | 100.0% | 100% | Shown items with a server-verified quote ÷ shown items |
| False-positive rate | 6.3% | | Shown items not in the golden set ÷ all shown items |
| Uncertainty band accuracy | 92.7% | ≥ 85.0% | Golden items in ambiguous fixtures landing in their expected band |
| Speculative items scored High | 0 | 0 | Golden speculative or Ignore items shown as Likely |
| Explicit dated promises scored Low | 0 | 0 | Golden explicit, dated promises (yours or owed to you) scored Also noticed or Ignore |
| Ask-why fabrications | 0 | 0 | Questions (of 20: 10 answerable, 10 with no recorded decision) whose answer cites, quotes or claims anything not in the retrieved, stored decisions, or calls the model with nothing retrieved |
| Extraction failures | 0 | 0 | Fixtures whose extraction call failed |
| Evaluation cases | 42 | 40 | Synthetic fixtures in `evals/fixtures/` |

Informational (not gated):

- Band accuracy, all fixtures: 95.4%
- Date certainty (explicit / inferred / none) accuracy: 99.2%
- Item type accuracy: 89.2%
- Evidence page accuracy (uploads with page offsets): 100.0%
- Ask-why: PASS; model google:gemini-3.6-flash, prompt ask-why.v3 (sha256 2e242d5138dc), schema ask-why.v1; answerable hit rate 100.0%; model calls 10; failed calls 0; extra attempts after provider unavailable 0 (0 questions, 0 rounds, 0 still unavailable)

## Per fixture

| Fixture | Status | Extra attempts | Matched | Missed | Extra | Ignore shown |
| --- | --- | --- | --- | --- | --- | --- |
| 01-demo-mike-proposal-lunch | ok | 0 | 2 | 0 | 0 | 0 |
| 02-email-contractor-others-and-requests | ok | 0 | 4 | 0 | 0 | 0 |
| 03-meeting-notes-mixed-owners | ok | 0 | 4 | 0 | 0 | 0 |
| 04-notice-renewal-decision | ok | 0 | 1 | 0 | 2 | 0 |
| 05-dst-us-fall-back | ok | 0 | 3 | 0 | 0 | 0 |
| 06-year-rollover-chat | ok | 0 | 4 | 0 | 0 | 0 |
| 07-ampm-ambiguous-chat | ok | 0 | 2 | 0 | 0 | 0 |
| 08-no-items-idioms | ok | 0 | 0 | 0 | 0 | 0 |
| 09-hedged-conditional-sarcasm | ok | 0 | 4 | 0 | 0 | 0 |
| 10-long-email-thread | ok | 0 | 5 | 0 | 1 | 0 |
| 11-upload-utility-bill-pages | ok | 0 | 2 | 0 | 1 | 0 |
| 12-dst-europe-london | ok | 0 | 3 | 0 | 0 | 0 |
| 13-dst-us-spring-forward-skipped-hour | ok | 0 | 3 | 0 | 0 | 0 |
| 14-defaulted-reference-date | ok | 0 | 3 | 0 | 0 | 0 |
| 15-overdue-month-day-past-window | ok | 0 | 2 | 0 | 0 | 0 |
| 16-vague-soon-chat | ok | 0 | 2 | 1 | 0 | 0 |
| 17-unknown-owner-shared-notes | ok | 0 | 4 | 0 | 0 | 0 |
| 18-prompt-injection-in-email | ok | 0 | 2 | 0 | 0 | 0 |
| 19-typos-fuzzy-quote-lure | ok | 0 | 3 | 0 | 0 | 0 |
| 20-group-chat-unclear-speaker-conditional | ok | 0 | 3 | 0 | 0 | 0 |
| 21-insurance-renewal-notice | ok | 0 | 2 | 1 | 1 | 0 |
| 22-upload-lease-renewal-pages | ok | 0 | 2 | 0 | 0 | 0 |
| 23-government-letter-vehicle-registration | ok | 0 | 2 | 0 | 0 | 0 |
| 24-quick-add-morning-bare-hour | ok | 0 | 1 | 0 | 0 | 0 |
| 25-timezone-relocated-tokyo | ok | 0 | 3 | 0 | 0 | 0 |
| 26-night-hours-chat | ok | 0 | 3 | 0 | 0 | 0 |
| 27-email-end-of-day-at-the-latest | ok | 0 | 4 | 0 | 0 | 0 |
| 28-weekday-contradicts-date | ok | 0 | 2 | 0 | 0 | 0 |
| 29-month-day-past-window-rolls-to-next-year | ok | 0 | 3 | 0 | 0 | 0 |
| 30-ambiguous-hedged-friends-chat | ok | 0 | 5 | 0 | 0 | 0 |
| 31-ambiguous-sarcasm-coworker | ok | 0 | 3 | 0 | 0 | 0 |
| 32-ambiguous-unclear-speaker-transcript | ok | 0 | 4 | 0 | 0 | 0 |
| 33-ambiguous-vague-timing-contractor | ok | 0 | 4 | 1 | 0 | 0 |
| 34-ambiguous-conditional-landlord | ok | 0 | 4 | 0 | 0 | 0 |
| 35-ambiguous-hedged-manager-requests | ok | 0 | 4 | 0 | 0 | 0 |
| 36-meeting-notes-action-items | ok | 0 | 4 | 0 | 1 | 0 |
| 37-no-items-order-confirmation | ok | 0 | 0 | 0 | 1 | 0 |
| 38-waiting-on-vendor-refund | ok | 0 | 3 | 0 | 0 | 0 |
| 39-decision-open-enrollment | ok | 0 | 2 | 0 | 1 | 0 |
| 40-upload-policy-wording-cover-letter | ok | 0 | 2 | 0 | 0 | 0 |
| 41-conditional-promises-abbreviations-chat | ok | 0 | 3 | 0 | 0 | 0 |
| 42-firm-promises-own-steps-chat | ok | 0 | 4 | 0 | 0 | 0 |
