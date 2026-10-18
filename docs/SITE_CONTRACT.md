# Loose Ends — Site Contract

**Status:** MVP implementation contract — **v1.1, Oct 18, 2026**  
**Basis:** PRD v1.1, content model v1.1 and the Loose Ends Visual Design Standard  
**Purpose:** Define the site's pages, routes, content, states and interaction behaviour. Decision IDs (D1–D14) refer to the PRD Decisions Log. All visual values (colours, type, spacing, timing) come from the Visual Design Standard; this contract no longer proposes its own.

**v1.1 changes:** navigation reconciled with the PRD (Decisions added); new pages for sign-in/onboarding, Why panel, Source viewer and Decisions; route map; error copy table; per-screen state matrix; quick-add routing exception; undo-vs-confirm rule; Active/Closed thread filter; account deletion.

## 1. Page Structure

| Order | Page / section | Purpose |
|---:|---|---|
| 0 | Sign in and onboarding | Magic link or Google identity sign-in; one aliases question; sensitive-data and analytics notices. |
| 1 | App shell and navigation | Today · Threads · Decisions, global Add, account menu, review chip, demo-date banner. |
| 2 | Add / Capture | Paste, upload or quick-add source material. |
| 3 | Extraction progress | Real pipeline steps; success, failure, slow and unsupported states. |
| 4 | Review Tray | Inspect, correct, clarify, accept or reject proposals before they become threads. |
| 5 | Today | At most 5 ranked threads plus Waiting, Coming up and Recently resolved. |
| 6 | Threads index | All threads, filtered Active / Closed. |
| 7 | Life Thread detail | Situation, next action, Explain card, evidence, history, decision, actions. |
| 8 | Why panel | Deterministic explanation of why a thread exists and why it is surfacing now. |
| 9 | Source viewer | The original text with the quoted span highlighted. |
| 10 | Resolve / Decision Memory | How the loop ended, optional decision and reason. |
| 11 | Decisions / Ask Why | Decision list and grounded answers about past decisions. |
| 12 | Settings and Data | Profile, aliases, timezone, analytics, sources, retention, export, account deletion, sign-out. |

### 1.1 Persistent app shell

- **Primary destinations:** Today, Threads, Decisions (D1).
- **Global action:** Add, on every authenticated page.
- **Account menu:** Settings, Export data, Sign out. Export data starts the export directly and reports completion only after the download is ready.
- **Review chip:** `N to review` on Today when pending proposals exist; links to the most recent pending Review Tray.
- **Demo-date banner:** in `DEMO_MODE` with a date set, a full-width banner above the shell (D12).
- **Page title:** `{Page} · Loose Ends` in the browser tab; thread detail uses the thread title.

### 1.2 Route map (v1.1)

| Route | Page | Auth | Notes |
|---|---|---|---|
| `/sign-in` | Sign in | Public | `?sent=1` shows the check-your-email state |
| `/auth/callback` | Auth handoff | Public | Redirects to `/onboarding` on first sign-in, else to the `next` param or `/today` |
| `/onboarding` | Aliases question | Signed in | Shown once; skippable |
| `/` | — | Signed in | Redirects to `/today` |
| `/today` | Today | Signed in | Default landing page |
| `/add` | Add / Capture | Signed in | `?mode=paste` (default), `upload`, `quick` |
| `/review/[extractionId]` | Extraction progress + Review Tray | Signed in | Same route shows progress, then proposals; survives refresh by polling |
| `/threads` | Threads index | Signed in | `?filter=active` (default) or `closed` |
| `/threads/[id]` | Thread detail | Signed in | `?panel=why` opens the Why panel; `?sheet=resolve` opens Resolve |
| `/sources/[id]` | Source viewer | Signed in | `?evidence=[evidenceId]` highlights and scrolls to that quote |
| `/decisions` | Decisions / Ask Why | Signed in | `?q=` holds the last question so answers can be deep-linked |
| `/settings` | Settings | Signed in | Anchors `#profile` and `#data` |

Unknown or other users' IDs render a plain not-found page (`This thread doesn't exist or was deleted.`) with a link to Today; never reveal whether another user's record exists.

## 2. Content Inventory

Field-level content, constraints and copy are defined in the content model v1.1; this section lists what each page must render and any constraints the content model leaves to implementation.

### 2.0 Sign in and onboarding

| Field | Constraints |
|---|---|
| Email + `Email me a sign-in link` | Disabled while sending; check-your-email state names the address and offers `Use a different email` |
| `Continue with Google` | Identity scopes only (`openid email profile`) |
| Aliases question | Skippable; signed-in email always saved as alias |
| Notices | "Don't paste passwords or full account numbers." Analytics notice with opt-out link |

### 2.1 App shell and navigation

| Field | Constraints |
|---|---|
| Product name | `Loose Ends`, consistent casing |
| Nav labels | `Today`, `Threads`, `Decisions`; Add button labelled `Add` |
| Account menu | `Settings`, `Export data`, `Sign out` |
| Review chip | Real pending count only |
| Demo banner | `Demo date: {Weekday Mon D, YYYY}`; `DEMO_MODE` only |

### 2.2 Add / Capture

| Field | Constraints |
|---|---|
| Mode tabs | `Paste`, `Upload`, `Quick add` |
| Text input | Max 30,000 characters; counter visible from 27,000; over-limit blocks submit with the error copy |
| File drop area | PDF, TXT, MD, DOCX; ≤ 10 MB; ≤ 30 pages; one file; type sniffed, not taken from extension |
| Source title | Optional; max 120 characters |
| Written-on date | Optional, collapsed under `When was this written?`; defaults to today with an `Assumed` label |
| Quick-add field | Single line; max 2,000 characters; placeholder `e.g. Send Mike the proposal Friday` |
| Submit | `Review source` (paste/upload) or `Add` (quick add); disabled while invalid or submitting |

### 2.3 Extraction progress

| Field | Constraints |
|---|---|
| Progress steps | `Reading…`, `Finding commitments…`, `Checking dates…`, shown only as the server reports each step |
| Slow state | After 45 s: `Still working — we'll show results here.`; the page polls and can be left and revisited |
| Success | Transitions straight into the Review Tray heading `I found N things in this` |
| Failure | Error copy from §2.12; source is kept; `Try again` and `Back to Add` |

### 2.4 Review Tray

| Field | Constraints |
|---|---|
| Groups | `Likely` (pre-checked), `Maybe` (unchecked), `Also noticed` (collapsed, unchecked) (D3) |
| Proposal card | Title, loop type, suggested next action (`Suggested`), counterparty, due date (+ `Assumed`), confidence label with reason, evidence quote |
| Inline edit | Title, loop type, date, counterparty; edited fields lose the `Suggested` label |
| Clarification | Inline above the groups; `Which of these is you?` + participant buttons + `None of them`; then `Remember "{name}" as you?` |
| Tray actions | `Accept selected`, `Reject all`; per-card `Reject` with inline `Rejected · Undo` |
| Result | `N threads added · View in Today` |
| Zero state | `Nothing here needs your attention` + document brief if present |

### 2.5 Today

| Field | Constraints |
|---|---|
| Greeting + count | Local date; count line only when ≥ 1 |
| Worth your attention | ≤ 5, score ≥ 0.3, deterministic; no unaccepted Low proposals (D4) |
| Row | Title, reason line ending in `Why?`, due chip, quick actions `Done`/`Resolve…`, `Snooze` |
| Collapsed sections | `Waiting on others`, `Coming up`, `Recently resolved`, each with a count; hidden when the count is 0 |
| Still relevant? | Once per thread > 30 days overdue: `Resolve`, `Dismiss`, `Keep` |
| Empty state | `Nothing needs you right now.` + `Add something` |

### 2.6 Threads index

| Field | Constraints |
|---|---|
| Filter | `Active` (Open, Waiting, Snoozed) / `Closed` (Resolved, Dismissed) (D7); selected state exposed with `aria-selected` |
| Row | Status icon + word, title, due chip; snoozed rows show `Until {date}` |
| Sort | Due date ascending, undated last; Closed sorted by resolved/dismissed date, newest first |
| Empty state | Per content model §5 |

### 2.7 Life Thread detail

| Field | Constraints |
|---|---|
| Header | Title (editable), status, loop type, due chip, next action, confidence label |
| Explain card | Six sections for document sources; two for quick add; source lines with quote icon, interpretation lines labelled |
| Evidence | Quote, source, page/date, `Open source`, `Why?` |
| History | Append-only timeline; corrections phrased `You changed …` |
| Decision | Shown when resolution is Decided |
| Actions | `Done` (not for decision threads), `Resolve…`, `Mark waiting`, `Snooze`, `Edit`, `Dismiss`, `Reopen` (closed threads only), `Forget permanently…`; desktop shows the first three as buttons and the rest in an overflow menu labelled `More actions` |
| Mark waiting form | `Waiting on` (required, prefilled with counterparty), `Expected by` (optional date) |
| Snooze menu | `Tomorrow, 9:00`, `Next Monday, 9:00`, `Pick a date…` (D11) |

### 2.8 Why panel

| Field | Constraints |
|---|---|
| Title | `Why am I seeing this?` |
| Content | Quote highlighted within ±200 characters; source + date; reasoning steps; why now; corrections; deleted-source state |
| Actions | `This is wrong` → choice of `Edit` or `Dismiss`; `Open source` |
| Generation | Deterministic from stored fields; no LLM call |

### 2.9 Source viewer

| Field | Constraints |
|---|---|
| Header | Title, kind, written-on date (+ `Assumed`), added date |
| Body | Normalized text; page markers for PDFs; highlighted span from `?evidence=` |
| Linked threads | Titles with status |
| Deleted state | `Original source deleted on {date}.`; the page is replaced by this message and links to the threads that keep their quotes |

### 2.10 Resolve / Decision Memory

| Field | Constraints |
|---|---|
| Choice | `Done`, `Decided`, `Not needed` |
| Decided fields | `What did you decide?` (prefilled, editable), `Want me to remember why?` textarea with autofocus |
| Actions | `Save` and `Skip` equally prominent; Skip never re-prompts |
| Result | Thread shows Resolved with the decision; undo toast |

### 2.11 Decisions / Ask Why

| Field | Constraints |
|---|---|
| Ask box | Placeholder `Ask about a past decision`; max 300 characters; 50 asks/day |
| Answer card | Labelled parts in fixed order: `You decided` · `You wrote:` · `From the source:` · `Interpretation:`; `Open thread` |
| No match | `I don't have a recorded decision about that.` |
| No reason | `You didn't record a reason for this decision.` + `Add a reason now` |
| Decision list | Newest first; empty state per content model §10 |

### 2.12 Settings and Data

| Field | Constraints |
|---|---|
| Profile | Display name, aliases (add/remove), timezone (IANA select), analytics toggle |
| Data | Retention toggle; sources list with two delete options; `Export data (JSON)`; `Delete account…` (D14) |
| Privacy explanation | Matches PRIVACY.md |
| SHOULD fields | Digest and type toggles only if F15/F17 ship |
| Sign out | Confirms only after the session has ended |

### 2.13 Error copy (v1.1)

| Code | Message | Action | Retry? |
|---|---|---|---|
| `input_too_long` | `That's {n} characters. The limit is 30,000 — trim it or split it into two pastes.` | Inline under the textarea | No |
| `unsupported_type` | `Loose Ends can read PDF, TXT, MD and DOCX files.` | `Choose another file` | No |
| `file_too_large` | `This file is {size} MB. The limit is 10 MB.` | `Choose another file` | No |
| `too_many_pages` | `This document has {n} pages. The limit is 30.` | `Choose another file` | No |
| `unsupported_scan` | `This looks like a scan. I can't read scans yet.` | `Paste the text instead` | No |
| `extraction_failed` | `Something went wrong reading this. Your text is saved.` | `Try again`, `Back to Add` | Yes |
| `extraction_slow` | `Still working — we'll show results here.` | Page polls | — |
| `rate_limited` | `You've reached today's limit of {limit} {sources/questions}. It resets at midnight ({timezone}).` | None | No |
| `invalid_transition` | `That change isn't possible any more. Refresh to see the latest.` | `Refresh` | No |
| Network / offline | `You're offline. Nothing was saved.` | `Try again` | Yes |
| Any other save failure | `That didn't save. Try again.` | `Try again` | Yes |

Errors appear next to the control that caused them (forms) or as an error banner at the top of the content column (page-level). Toasts are never used for errors.

### 2.14 State matrix (v1.1)

| Page | Loading | Empty | Error | Partial / other |
|---|---|---|---|---|
| Today | Skeleton rows (3) | `Nothing needs you right now.` | Page banner + `Try again` | Pending chip; Still relevant? prompt |
| Add | — | — | Field errors per §2.13 | Over-limit counter |
| Review / progress | Staged steps + skeleton cards | Zero-proposal state | Failure state | Slow state; clarification pending |
| Threads | Skeleton rows | Per filter | Page banner | — |
| Thread detail | Skeleton header + card | — | Not-found page | Source deleted; decision missing reason |
| Why panel | Inline spinner | — | `Couldn't load this explanation.` + retry | Source deleted |
| Source viewer | Skeleton text | — | Not-found page | Deleted state |
| Decisions | Skeleton list | Decision list empty state | Page banner | No match; no reason |
| Settings | Skeleton form | No sources: `You haven't added anything yet.` | Field / banner errors | Export in progress; deletion in progress |

## 3. Behaviour Spec

### 3.1 Navigation behaviour

- Today, Threads and Decisions update the active nav state; Add opens `/add` and returns the user to their previous page on cancel.
- Selecting a thread opens Thread detail; Back restores the previous list's filter and scroll position.
- **Paste and upload:** after submit, route to `/review/[extractionId]`. On failure, stay on that route showing the failure state with `Try again` and `Back to Add`.
- **Quick add (D9):** High-confidence items create threads immediately; the user stays on the current page and sees an 8 s undo toast (`Added "Send revised proposal to Mike" · Undo`). If any item is Medium or Low, route to the Review Tray for those items only.
- After accepting proposals, show the result line with `View in Today`; do not auto-navigate.
- Resolve opens as a sheet over Thread detail; saving closes it and shows the resolved state.
- Why opens as a side sheet (desktop) or bottom sheet (mobile) from Today rows and Thread detail; closing returns focus to the `Why?` link that opened it.
- `Open source` navigates to `/sources/[id]?evidence=…`; Back returns to the thread.
- Ask Why lives on `/decisions`; thread detail links a decision to `/decisions?q=` prefilled with the thread title.
- No interface state claims success before the server confirms it.

### 3.2 Scroll behaviour

- Normal document scrolling; no nested scroll regions except the Why sheet body and the Source viewer when shown beside the tray on desktop.
- Sticky top bar and mobile bottom nav never cover focused content; add `scroll-padding` equal to their heights.
- Restore list scroll and filter on Back.
- Never auto-scroll past evidence, uncertainty labels, errors or confirmation text.
- Focus the first relevant field on `/add`, on opening a clarification prompt, and on the Resolve sheet's reason field when Decided is chosen.

### 3.3 Hover, focus, and pressed states

Exact values are in the Visual Design Standard (Interactions). Contract-level requirements:

- Every hover affordance has a keyboard-focus equivalent; hover styles are limited to `(hover: hover)` devices.
- Menus, sheets and dialogs are keyboard-operable, close with Escape and return focus to their trigger.
- Selected filters and the active nav item are exposed programmatically (`aria-current`, `aria-selected`).
- Tooltips never hold the only copy of an instruction.

### 3.4 Mobile layout changes

- Below 768 px: single column; a 48 px mobile header (wordmark left, account button right); bottom navigation with four items — Today, Threads, **Add** (centre), Decisions.
- Touch targets ≥ 44 × 44 px.
- Review Tray: stacked list; source-beside-tray layout only at ≥ 1024 px.
- Why panel and Resolve become bottom sheets (max 85vh).
- Thread actions beyond Done and Snooze move to `More actions`.
- Respect safe areas and the virtual keyboard; submit buttons stay visible above the keyboard.

### 3.5 Transitions and animation

All durations, easing and product-moment animations are defined in the Visual Design Standard (Interactions). Contract-level requirements: no fake progress, no punitive or urgent motion, `prefers-reduced-motion` respected, and animations never delay access to controls, evidence, errors or confirmations.

### 3.6 Global trust and interaction requirements

1. AI outputs are labelled `Suggested` or `Interpretation` until the user accepts or edits them.
2. Evidence quotes are verbatim and traceable; unverified excerpts are never shown.
3. Explicit and assumed dates are distinguishable.
4. Unaccepted low-confidence proposals are never auto-accepted, ranked or notified.
5. User wording and rationale are preserved; AI summaries are supplemental and labelled.
6. Errors, empty states, missing rationale and unsupported files are handled honestly, using §2.13 copy.
7. **Reversible actions** (Done, Resolve, Dismiss, Snooze, Mark waiting, Edit, quick-add auto-create) run immediately with an 8 s undo toast and no confirmation. **Irreversible actions** (Forget permanently, Delete source, Delete source and everything derived, Delete account) require a confirmation dialog that lists exactly what is deleted, and have no undo (D8).
8. No interface state claims an action succeeded until the operation has succeeded.

## 4. Known gaps / implementation notes

- **Conflicting dates without F14:** a proposal that would change an existing thread's date shows both values and both quotes as an update proposal; never overwrite silently.
- **Scanned PDFs:** out of MVP scope; `unsupported_scan` copy applies.
- **SHOULD features** (dedupe, digest, forwarding, toggles, redaction) appear in the UI only if built after the day-14 checkpoint.
- **Trust Scorecard:** README and demo materials only.
- **Accessibility:** automated axe checks run in the Playwright suite on Today, Review Tray, Thread detail, Why panel and Settings; VoiceOver pass on the Review Tray weekly.
