# Loose Ends — Site Contract

**Status:** MVP implementation contract — **v1.1, Oct 18, 2026**  
**Basis:** PRD v1.1, content model v1.1 and the Loose Ends Visual Design Standard  
**Purpose:** Define the site's pages, routes, content, states and interaction behaviour. Decision IDs (D1 onward) refer to the PRD Decisions Log. All visual values (colours, type, spacing, timing) come from the Visual Design Standard; this contract no longer proposes its own.

**v1.1 changes:** navigation reconciled with the PRD (Decisions added); new pages for sign-in/onboarding, Why panel, Source viewer and Decisions; route map; error copy table; per-screen state matrix; quick-add routing exception; undo-vs-confirm rule; Active/Closed thread filter; account deletion.

## 1. Page Structure

| Order | Page / section | Purpose |
|---:|---|---|
| 0 | Sign in and onboarding | Also the first screen judges and new users see; there is no public landing page (D38). Pitch headline (the page's h1) and subline above the form; magic link or Google identity sign-in (Google only if switched on, D41); `Try the demo` (D55); one aliases question; sensitive-data and analytics notices. |
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
- **Demo-date banner:** for a demo (anonymous) account with a demo date, a full-width banner above the shell (D12, D55). Never shown for a real account; demo-ness is decided on the server from the auth claim, never from client input.
- **Page title:** `{Page} · Loose Ends` in the browser tab; thread detail uses the thread title.

### 1.2 Route map (v1.1)

| Route | Page | Auth | Notes |
|---|---|---|---|
| `/sign-in` | Sign in | Public | First screen for signed-out visitors; no public landing page (D38). `?sent=1` shows the check-your-email state. `?next={path}` is kept through the check-your-email state and the magic link. `Try the demo` (D55) signs in anonymously without `/auth/callback`, skips onboarding (the seed sets aliases) and lands on `/today` |
| `/auth/callback` | Auth handoff | Public | Redirects to `/onboarding` on first sign-in, else to the `next` param or `/today` |
| `/onboarding` | Aliases question | Signed in | Shown once; skippable |
| `/` | — | Any | Signed in: redirects to `/today`. Signed out: redirects to `/sign-in`, with no `next` because `/` lands on Today anyway (D38) |
| `/today` | Today | Signed in | Default landing page |
| `/add` | Add / Capture | Signed in | `?mode=paste` (default), `upload`, `quick` |
| `/review/[extractionId]` | Extraction progress + Review Tray | Signed in | Same route shows progress, then proposals; survives refresh by polling |
| `/threads` | Threads index | Signed in | `?filter=active` (default) or `closed` |
| `/threads/[id]` | Thread detail | Signed in | `?panel=why` opens the Why panel; `?sheet=resolve` opens Resolve |
| `/sources/[id]` | Source viewer | Signed in | `?evidence=[evidenceId]` highlights and scrolls to that quote |
| `/decisions` | Decisions / Ask Why | Signed in | `?q=` prefills the Ask box but never asks automatically, because every ask is a model call and counts toward the daily limit (D57). *Was:* "holds the last question so answers can be deep-linked" |
| `/settings` | Settings | Signed in | Anchors `#profile` and `#data`. Renders the not-found page (404) until analytics can actually run, so it never shows a toggle with no effect (D57, rule 9) |

**Signed-out access (D38):** a signed-out visit to any Signed in route redirects to `/sign-in?next={path}`, where the path includes its query string. After sign-in, `/auth/callback` sends the user to `next`. On first sign-in, onboarding comes first and then `next`. Only same-site relative paths are honoured as `next`; anything else falls back to `/today`.

Unknown or other users' IDs render a plain not-found page with the link `Go to Today`; never reveal whether another user's record exists. Thread pages read `This thread doesn't exist or was deleted.`; other records (for example `/review/[extractionId]`) read `This doesn't exist or was deleted.` (D47).

## 2. Content Inventory

Field-level content, constraints and copy are defined in the content model v1.1; this section lists what each page must render and any constraints the content model leaves to implementation.

### 2.0 Sign in and onboarding

| Field | Constraints |
|---|---|
| Pitch headline (D38) | `Tie up your loose ends.` The page's only h1. Below the `Loose Ends` wordmark and above the subline. Exact text |
| Pitch subline (D38) | `Paste in the mess. Get back what's still open, each with the sentence it came from.` Directly below the headline and above the sign-in form. Exact text; no added marketing copy, and no privacy or speed claims (rule 9) |
| Email + `Email me a sign-in link` | Field label `Email`. Button disabled while sending. Field errors per §2.13 "Sign in and onboarding" |
| Check-your-email state (D39) | Shown only after Supabase confirms the link was sent (rule 10). Heading `Check your email`. Body `I sent a sign-in link to {email}. Open it in this browser to sign in.` then `The link works for 1 hour.` Offers `Use a different email`. The lifetime line is tied to Supabase `otp_expiry = 3600`; the copy and the setting (local config and the production project) change together |
| Divider | `or`, between the email form and `Continue with Google` (D39). Rendered only when Google sign-in is switched on (D41) |
| `Continue with Google` | Identity scopes only (`openid email profile`). Conditional (D41): rendered whenever `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED=true`; set that flag only where the Supabase Google provider is enabled (the release checklist enables both). It ships on only if the Google OAuth setup and a manual check pass by Oct 24; otherwise it stays hidden and the email link is the only sign-in method. If it does not ship, this row, the divider row and `oauth_failed` (§2.13) are removed at the Oct 25 scope review |
| `Try the demo` (D55) | Below the sign-in methods, a secondary button labelled `Try the demo`, with the line `Explore with made-up data. No email needed. Demo accounts are deleted within 2 days.` (*Proposed*, PRD Question #14). Protected by a Cloudflare Turnstile CAPTCHA. Pressing it creates a fresh anonymous demo account seeded with the "Sam" data on the demo date Mon Oct 5, 2026, then opens Today; it shows a pending state while the account is created and never claims the demo started before the server confirms (rule 10). Hidden when JavaScript is off |
| Demo unavailable (D55) | When `DEMO_ENABLED` is off or the day's demo AI budget is spent, the button is disabled and the reason is shown under it (copy in §2.13, *Proposed*). The email sign-in stays available |
| No JavaScript | `Signing in needs JavaScript. Turn it on in your browser, then reload this page.` (D39) |
| Aliases question | `What name and emails do people use for you?` Field label `Names and emails`. Hint `Separate them with commas. I use these to tell which tasks are yours.` Below it, `Your sign-in email, {email}, is always included.` Actions `Save` and `Skip`. Skippable; signed-in email always saved as alias. At most 20 names and emails, each up to 100 characters (D40). Field errors per §2.13 (D39) |
| Notices | "Don't paste passwords or full account numbers.", shown on the sign-in page and in onboarding. Analytics notice with opt-out link, shown in onboarding. It ships with the first PostHog event and stays hidden until then (D40, rule 9). Approved wording (D46, Oct 21): `Loose Ends counts which features you use. Analytics never include what you paste.` with the opt-out link `Turn off analytics` |

### 2.1 App shell and navigation

| Field | Constraints |
|---|---|
| Product name | `Loose Ends`, consistent casing |
| Nav labels | `Today`, `Threads`, `Decisions`; Add button labelled `Add` |
| Account menu | `Settings`, `Export data`, `Sign out` |
| Review chip | Real pending count only |
| Demo banner | `Demo date: {Weekday Mon D, YYYY}`; demo (anonymous) accounts only (D55). *Proposed* (PRD Question #14): `Demo account with made-up data · Demo date: {Weekday Mon D, YYYY}` |

### 2.2 Add / Capture

| Field | Constraints |
|---|---|
| Page heading | `Drop something in` (D47). The global button stays `Add` (D1) |
| Mode tabs | `Paste`, `Upload`, `Quick add` |
| Text input | Label `Paste a message or document`, hint `Up to 30,000 characters.` (D47). Max 30,000 characters; counter visible from 27,000; over-limit blocks submit with the error copy; empty submit shows `Paste some text first.` (§2.13) |
| File drop area | PDF, TXT, MD; ≤ 10 MB; ≤ 30 pages; one file; type sniffed, not taken from extension. Hint `PDF, TXT or MD · up to 10 MB and 30 pages` (D52). A chosen file shows as a row with its name and size and a `Remove` button (D52). Extracted text over 30,000 characters is refused with `input_too_long` and its upload message, not truncated (D52). DOCX stays in F3 scope until the Oct 25 review decides D17; until it ships, a Word file is refused with its `unsupported_type` message (§2.13). *Was:* "PDF, TXT, MD, DOCX" |
| Source title | Optional, collapsed under `Add a title`; field label `Title (optional)` (D47); max 120 characters |
| Written-on date | Optional, collapsed under `When was this written?`; defaults to today with an `Assumed` label. Field label: `I assumed this was written today. Change it if it wasn't.` until the user sets a date, then `Written on` (D47). Dates outside 1900–2100 show the §2.13 field error |
| Quick-add field | Single line; max 2,000 characters; placeholder `e.g. Send Mike the proposal Friday` |
| Submit | `Review source` (paste/upload) or `Add` (quick add); disabled while invalid or submitting |
| AI provider notice (D42) | Conditional on Question #12 (PRD, due Oct 22). If the deployment uses the Gemini free tier: a plain-words notice on all three modes, visible before submit, saying the text is sent to Google, which may use it to improve its products, and that people at Google may read it. Wording pending user approval. If billing is enabled: no notice required here; Settings → Data and PRIVACY.md name Google as the AI provider |

### 2.3 Extraction progress

| Field | Constraints |
|---|---|
| Progress steps | `Reading…`, `Finding commitments…`, `Checking dates…`, shown only as the server reports each step |
| Slow state | After 45 s: `Still working. I'll show results here.` (D40); the page polls and can be left and revisited |
| Success | Transitions straight into the Review Tray heading `I found N things in this` |
| Failure | Error copy from §2.13; source is kept; `Try again` and `Back to Add`. `Try again` is offered for at most 3 retries per source; after that it is hidden and `Back to Add` stays (D48) |

### 2.4 Review Tray

| Field | Constraints |
|---|---|
| Groups | `Likely` (pre-checked), `Maybe` (unchecked), `Also noticed` (collapsed, unchecked) (D3) |
| Proposal card | Title, loop type, suggested next action (`Suggested`), counterparty, due date (+ `Assumed`), confidence label with reason, evidence quote |
| Inline edit | Title, loop type, date, counterparty; edited fields lose the `Suggested` label |
| Clarification | Inline above the groups; `Which of these is you?` + participant buttons + `None of them`; then `Remember "{name}" as you?` |
| Tray actions | `Accept selected`, `Reject all`; per-card `Reject` with inline `Rejected · Undo`. With nothing checked, `Accept selected` is disabled with the reason `Nothing selected.` (D47) |
| Waiting-on with no counterparty | The card's checkbox is disabled with the reason `I can't tell who this is waiting on, so it can't be added yet.` (D47) |
| Result | `N threads added · View in Today`; singular `1 thread added` (D47) |
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
| Explain card | Six sections for document sources; two for quick add; source lines with quote icon, interpretation lines labelled. Title `About this document` when the source has a brief, `About this` for the compact card (D52) |
| Not sure about | Template lines only, never model text (rule 6; D52): `The source suggests this but doesn't say it outright.` (`certainty = implied`), `This may not be a firm plan.` (`certainty = speculative`), `The source doesn't give this exact date. I worked it out.` (`due_certainty = inferred`) |
| Section headings | `Next action`, `Evidence`, `History` (D47) |
| Evidence | Quote, source, page/date, `Open source`, `Why?`. If the source was deleted, the source line reads `Source deleted` (D47) |
| History | Append-only timeline; corrections phrased `You changed …`. Event lines (D47): `You accepted this from your source.`, `Added from quick add.`, `You marked this done.` / `Loose Ends marked this done.`, `You resolved this.` / `Loose Ends resolved this.`, `You undid the last change.`, `You reopened this.`, `You snoozed this.`, `You edited this.`, `Status changed to {status}.`; fallback `Updated.` |
| Decision | Section heading `Decision` (D56). Shown when resolution is Decided, with the link `Ask why` to `/decisions?q=` (D57). Without a reason: `You didn't record a reason for this decision.` + `Add a reason now` (D58) |
| Interim Resolve… | Until F11 ships, `Resolve…` is disabled with the reason `Resolving with a decision isn't available yet.` (D47) |
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
| Header | Title, kind, written-on date (+ `Assumed`), added date. An upload with no title is labelled `Uploaded file` (D52) |
| Body | Normalized text; page markers for PDFs; highlighted span from `?evidence=` |
| Linked threads | Titles with status |
| Deleted state | `Original source deleted on {date}.`; the page is replaced by this message and links to the threads that keep their quotes |

### 2.10 Resolve / Decision Memory

| Field | Constraints |
|---|---|
| Choice | `Done`, `Decided`, `Not needed`; threads of kind `decision` get only `Decided` and `Not needed` (D6, D56) |
| Decided fields | `What did you decide?` (starts empty, because no options are stored to prefill from; editable; up to 300 characters) and `Want me to remember why?` textarea (optional; up to 2,000 characters). Over the limit: `Decisions can be up to 300 characters.` / `Reasons can be up to 2,000 characters.` inline under the field (D57; *was:* "no message is shown", D56) |
| Validation | Save with Decided and an empty decision: `Write what you decided, or choose another option.` under the decision field (D56) |
| Actions | `Save` and `Skip` equally prominent; Skip never re-prompts. `Cancel` closes the sheet without saving (D56) |
| Result | Thread shows Resolved with the decision; undo toast `Resolved: "{title}"` after Decided or Not needed (Done keeps `Marked done: "{title}"`), its Undo button labelled for screen readers `Undo resolve: {title}`. Undo after Decided restores the thread and deletes the decision it created (D44, D56) |

### 2.11 Decisions / Ask Why

| Field | Constraints |
|---|---|
| Ask box | Placeholder `Ask about a past decision`; button `Ask` (D57); max 300 characters; 50 asks/day. Empty question: `Write a question first.` inline (D57). Runs as a server action, not `POST /api/ask` (D57) |
| Deep link | `?q=` (for example from `Ask why` on Thread detail) prefills the box; the user presses `Ask`. Never asks automatically (D57) |
| Answer card | Labelled parts in fixed order: `You decided` · `You wrote:` · `From the source:` · `Interpretation:`; `Open thread`. Each cited decision's whole stored reason is shown verbatim under `You wrote:`, even when the model omits it (D33, D57) |
| No match | `I don't have a recorded decision about that.` |
| No reason | `You didn't record a reason for this decision.` + `Add a reason now` (D58): adds the reason once, only while it is empty, stored verbatim; written by a security-definer function that appends a `thread_events` row. Form copy and History line: *Proposed* in the S9b PR, pending user approval |
| Ask failed (D54) | `ask_failed` inline under the Ask box: `I couldn't answer that just now. Try asking again.` + `Try again`. The question stays in the box; no partial answer is shown. Every failure kind, including provider quota (429) |
| Decision list | Heading `Recorded decisions` (D57); newest first; empty state per content model §10. Load failure: `I couldn't load your decisions.` + `Try again` (D57) |

### 2.12 Settings and Data

| Field | Constraints |
|---|---|
| Profile | Section heading `Profile`. Display name, aliases (add/remove), timezone (IANA select), analytics toggle labelled `Analytics`, described by the notice sentence `Loose Ends counts which features you use. Analytics never include what you paste.` (ships with the first PostHog event, hidden until then; D40, D46). If settings fail to load: `Settings didn't load. Try again.` + `Try again` (D46) |
| Data | Retention toggle; sources list with two delete options; `Export data (JSON)`; `Delete account…` (D14) |
| Privacy explanation | Matches PRIVACY.md. Names Google (Gemini API) as the AI provider and, if the free tier is used, says Google may use pasted text and Ask-why context to improve its products and people may read it (D42) |
| SHOULD fields | Digest and type toggles only if F15/F17 ship |
| Sign out | Ends the session in this browser only; there is no "sign out everywhere" (D39). Confirms only after the session has ended |

### 2.13 Error copy (v1.1)

| Code | Message | Action | Retry? |
|---|---|---|---|
| `input_too_long`, paste | `That's {n} characters. The limit is 30,000 — trim it or split it into two pastes.` | Inline under the textarea | No |
| `unsupported_type`, wrong type (D52) | `Loose Ends can read PDF, TXT and MD files.` *Was:* `Loose Ends can read PDF, TXT, MD and DOCX files.` (untrue while DOCX is deferred, D17) | `Choose another file` | No |
| `unsupported_type`, Word file (D52; until DOCX ships, D17) | `I can't read Word files yet. Save it as a PDF, or paste the text instead.` | `Choose another file` | No |
| `unsupported_type`, damaged or locked PDF (D52) | `I couldn't open this PDF. It may be damaged or locked with a password.` | `Choose another file` | No |
| `unsupported_type`, empty file (D52) | `This file has no text in it.` | `Choose another file` | No |
| `input_too_long`, upload (D52) | `This document has {n} characters of text. The limit is 30,000.` The upload is refused, not truncated | `Choose another file` | No |
| `file_too_large` | `This file is {size} MB. The limit is 10 MB.` | `Choose another file` | No |
| `too_many_pages` | `This document has {n} pages. The limit is 30.` | `Choose another file` | No |
| `unsupported_scan` | `This looks like a scan. I can't read scans yet.` | `Paste the text instead` | No |
| `extraction_failed` | `Something went wrong reading this. Your text is saved.` | `Try again`, `Back to Add` | Yes |
| `retry_limit` (D48) | `I couldn't read this after {n} more tries. Your text is saved.` | `Back to Add`; `Try again` hidden | No |
| `ask_failed` (D54) | `I couldn't answer that just now. Try asking again.` | Inline under the Ask box, question kept; `Try again` | Yes |
| `extraction_slow` | `Still working. I'll show results here.` (D40) | Page polls | — |
| `rate_limited` | `You've reached today's limit of {limit} {sources/questions}. It resets at midnight (UTC).` (the limit counts per UTC day, so the reset is always shown in UTC, not the user's timezone; D30) | None | No |
| `invalid_transition` | `That change isn't possible any more. Refresh to see the latest.` | `Refresh` | No |
| `invalid_input` (D56), field `choice` | `Write what you decided, or choose another option.` | Inline under `What did you decide?` | No |
| `invalid_input` (D57), field `choice`, over 300 characters | `Decisions can be up to 300 characters.` | Inline under `What did you decide?` | No |
| `invalid_input` (D57), field `reason_user`, over 2,000 characters | `Reasons can be up to 2,000 characters.` | Inline under `Want me to remember why?` | No |
| `invalid_input` (D57), field `question` | `Write a question first.` | Inline under the Ask box | No |
| Decisions list fails to load (D57) | `I couldn't load your decisions.` | Page banner + `Try again` | Yes |
| Network / offline | `You're offline. Nothing was saved.` | `Try again` | Yes |
| Any other save failure | `That didn't save. Try again.` | `Try again` | Yes |
| `invalid_input` (D47), field `text` | `Paste some text first.` | Inline under the textarea | No |
| `invalid_input` (D47), field `title` | `Titles can be up to 120 characters.` | Inline under the title field | No |
| `invalid_input` (D47), field `written_on` | `Enter a real date between 1900 and 2100.` | Inline under the date field | No |
| `not_found` (D47; HTTP routes only, pages render the not-found page in §1.2) | `This doesn't exist or was deleted.` | `Go to Today` | No |
| `unauthenticated` (D47; HTTP routes only, pages redirect to `/sign-in`) | `Sign in to continue.` | Sign in | No |
| Today, Threads or Thread detail fail to load (D47) | `I couldn't load your threads.` | Page banner + `Try again` | Yes |

**Extraction failures (D43).** Every extraction failure shows `extraction_failed`, whatever the cause, including the AI provider's own quota (429); `rate_limited` is only the user's own daily limit. Before the error shows, the server retries once only when a retry can help (provider unavailable or malformed output), never on quota, a safety block, a rejected request or a config error. `Try again` starts a new attempt and is offered for up to 3 retries per source; after the third, it is hidden and `retry_limit` explains why (D48). *Was:* "`Try again` is always offered."

**Upload refusals (D52).** Upload refusals reuse documented codes, each with its own message: Word, damaged or locked and empty files return `unsupported_type`, and an upload over 30,000 characters returns `input_too_long`. Scans keep `unsupported_scan`.

**Sign in and onboarding (D39).** Sign-in errors appear under the email field, except offline, which is a page banner with `Try again`. The `?error=` codes come from `/auth/callback`; an unknown `?error=` code shows nothing. The `sign_in_rate_limited` code below is Supabase Auth's link-request limit and is separate from the app `rate_limited` code above (sources/questions per UTC day).

| Code | Message | Action | Retry? |
|---|---|---|---|
| Sign-in `invalid_email` | `Enter an email address, like name@example.com.` | Inline under the email field | No |
| `sign_in_rate_limited` | `Too many sign-in links were requested. Wait a few minutes, then try again.` | Inline under the email field | Later |
| Sign-in `send_failed` | `I couldn't send the link. Try again.` | Inline under the email field; `Email me a sign-in link` stays available | Yes |
| `?error=link_expired` | `That sign-in link has expired or was already used. Enter your email to get a new one.` | Email field | No; request a new link |
| `?error=link_other_browser` | `That link was opened in a different browser. Enter your email to get a new one, and open it in this browser.` | Email field | No; request a new link |
| `demo_unavailable`, budget spent (D55, *Proposed*) | `The demo is full for today. It opens again after midnight (UTC). You can still sign in with your email.` | `Try the demo` disabled; email field | Later |
| `demo_unavailable`, switched off (D55, *Proposed*) | `The demo isn't available right now. You can still sign in with your email.` | `Try the demo` disabled; email field | No |
| `demo_captcha_failed` (D55, *Proposed*) | `I couldn't check that you're a person. Try again.` | Under `Try the demo` | Yes |
| `demo_rate_limited` (D55, *Proposed*; Supabase's per-IP anonymous sign-in limit) | `Too many demos were started from this network. Try again later, or sign in with your email.` | Under `Try the demo` | Later |
| `demo_start_failed` (D55, *Proposed*) | `I couldn't start the demo. Try again.` | Under `Try the demo` | Yes |
| `?error=oauth_failed` | `Google sign-in didn't finish. Try again, or use your email.` | `Continue with Google` or the email field. Applies only while Google sign-in is switched on (D41) | Yes |
| Onboarding `too_many` | `That's more than 20 names and emails. Keep the ones people use most.` | Inline under the field | No |
| Onboarding `too_long` | `Each name or email can be up to 100 characters.` | Inline under the field | No |
| Onboarding save failure / offline | Generic rows above: `That didn't save. Try again.` / `You're offline. Nothing was saved.` | Page banner + `Try again` | Yes |

Errors appear next to the control that caused them (forms) or as an error banner at the top of the content column (page-level). Toasts are never used for errors.

### 2.14 State matrix (v1.1)

| Page | Loading | Empty | Error | Partial / other |
|---|---|---|---|---|
| Today | Skeleton rows (3) | `Nothing needs you right now.` | Page banner `I couldn't load your threads.` (D47) + `Try again` | Pending chip; Still relevant? prompt |
| Add | — | — | Field errors per §2.13 | Over-limit counter |
| Review / progress | Staged steps + skeleton cards | Zero-proposal state | Failure state | Slow state; clarification pending |
| Threads | Skeleton rows | Per filter | Page banner `I couldn't load your threads.` (D47) | — |
| Thread detail | Skeleton header + card | — | Not-found page; load failure banner `I couldn't load your threads.` (D47) | Source deleted; decision missing reason |
| Why panel | Inline spinner | — | `Couldn't load this explanation.` + retry | Source deleted |
| Source viewer | Skeleton text | — | Not-found page | Deleted state |
| Decisions | Skeleton list | Decision list empty state | Page banner `I couldn't load your decisions.` + `Try again` (D57); `Write a question first.` under the Ask box (D57); a failed ask shows `ask_failed` inline under the Ask box, question kept, no partial answer (D54, §2.13) | No match; no reason with `Add a reason now` (D58); `?q=` prefilled, not asked (D57) |
| Sign in (D39) | Send button disabled while sending; `Try the demo` pending while the demo account is created (D55) | — | Field errors and `?error=` messages per §2.13; demo errors under `Try the demo`; offline banner | Check-your-email state (§2.0); demo-unavailable state (D55); no-JavaScript message |
| Onboarding (D39) | — | — | Field errors per §2.13; save-failure and offline banners | Skip |
| Settings | Skeleton form | No sources: `You haven't added anything yet.` | Field / banner errors; load failure `Settings didn't load. Try again.` (D46) | Export in progress; deletion in progress |

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
- Ask Why lives on `/decisions`; the `Ask why` link on a thread's decision opens `/decisions?q=` prefilled with the thread title. The page does not ask until the user presses `Ask` (D57).
- No interface state claims success before the server confirms it.

### 3.2 Scroll behaviour

- Normal document scrolling; no nested scroll regions except the Why sheet body and the Source viewer when shown beside the tray on desktop.
- Sticky top bar and mobile bottom nav never cover focused content; add `scroll-padding` equal to their heights.
- Restore list scroll and filter on Back.
- Never auto-scroll past evidence, uncertainty labels, errors or confirmation text.
- Focus the first relevant field on `/add`, on opening a clarification prompt, and on the Resolve sheet's `What did you decide?` field when Decided is chosen (it starts empty, D56; the reason field gets focus only if the decision already has text). *Was:* the reason field.

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
7. **Reversible actions** (Done, Resolve, Dismiss, Snooze, Mark waiting, Edit, quick-add auto-create) run immediately with an 8 s undo toast and no confirmation. The Done toast reads `Marked done: "{title}"` + `Undo` (D47); the Resolve toast after Decided or Not needed reads `Resolved: "{title}"` + `Undo`, labelled `Undo resolve: {title}` for screen readers (D56). Undo restores the exact state before the action and appends an `undone` history event; the server accepts it up to 12 s after the action (8 s toast plus 4 s grace) (D44). Hover or focus pauses the toast timer, but the toast closes 11 s after the action at the latest, 1 s before the server window closes (D49, D51). On a very slow network an Undo sent near that limit can still reach the server after 12 s; it is refused with the §2.13 copy and Refresh, and the 1 s buffer makes this rare (D51). **Irreversible actions** (Forget permanently, Delete source, Delete source and everything derived, Delete account) require a confirmation dialog that lists exactly what is deleted, and have no undo (D8).
8. No interface state claims an action succeeded until the operation has succeeded.

## 4. Known gaps / implementation notes

- **Conflicting dates without F14:** a proposal that would change an existing thread's date shows both values and both quotes as an update proposal; never overwrite silently.
- **Scanned PDFs:** out of MVP scope; `unsupported_scan` copy applies.
- **SHOULD features** (dedupe, digest, forwarding, toggles, redaction) appear in the UI only if built after the day-14 checkpoint.
- **Trust Scorecard:** README and demo materials only.
- **Magic-link lifetime (release follow-up, D39):** the check-your-email copy says `The link works for 1 hour.` Before release, set the production Supabase project's email OTP expiry to 3600 seconds to match `supabase/config.toml`. The unit test checks only the local config.
- **Accessibility:** automated axe checks run in the Playwright suite on Today, Review Tray, Thread detail, Why panel and Settings; VoiceOver pass on the Review Tray weekly.
