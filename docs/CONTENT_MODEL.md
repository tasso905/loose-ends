# Loose Ends — Content Model

**Version:** v1.1 — Oct 18, 2026 (reconciled with PRD v1.1, site contract v1.1 and the visual design standard; decision IDs D1 onward refer to the PRD Decisions Log)  
**Scope:** Minimal content model for the Must-Have MVP features.  
**Product principle:** AI proposes; the user reviews and decides. No evidence → no automatic reminder.  
**Core definition:** An *Open Loop* is a real-world situation with an unresolved action, dependency, decision, or consequence.

## Page and section order

### 0. Sign in and onboarding (v1.1)

| Field | Description | Constraints |
|---|---|---|
| Product name | Names the product | `Loose Ends` as the wordmark (DESIGN_STANDARD "Wordmark and favicon"), at the top of the page. It is not a heading. The sign-in page is also the first screen for new users and judges; there is no landing page (D38) |
| Pitch headline | Says what the product is for | Exactly `Tie up your loose ends.` (D38, Oct 19). The page's only h1, replacing the earlier "`Loose Ends` heading". Below the wordmark, above the subline |
| Pitch subline | Says how it works | Exactly `Paste in the mess. Get back what's still open, each with the sentence it came from.` (D38, Oct 19). Body text directly below the headline, above the email field. Order: wordmark → headline → subline → sign-in form → notices. No other marketing copy; no privacy or speed claims (rule 9) |
| Email field | Magic-link address | Label `Email`. Standard email validation; one field only. Invalid input shows `Enter an email address, like name@example.com.` (D39; all sign-in errors in SITE_CONTRACT §2.13) |
| Send link button | Requests a magic link | Label `Email me a sign-in link`; disabled while sending |
| Divider | Separates the two sign-in methods | `or`, between the email form and the Google button (D39). Shown only when Google sign-in is switched on (D41) |
| Google button | Identity-only Google sign-in | Label `Continue with Google`; no mailbox scopes. Conditional (D41): shown only if the Google OAuth setup and a manual check pass by Oct 24; otherwise hidden, and this row and the divider row are removed at the Oct 25 scope review |
| Check-your-email state | Confirms the link was sent | Heading `Check your email`. Body `I sent a sign-in link to {email}. Open it in this browser to sign in.` then `The link works for 1 hour.` (D39; tied to Supabase `otp_expiry = 3600`, so the setting and this line change together). Offers `Use a different email`; never claims sign-in succeeded |
| No-JavaScript message | Explains why sign-in can't work | `Signing in needs JavaScript. Turn it on in your browser, then reload this page.` (D39) |
| Aliases question | Helps tell "you" from others in pasted threads | "What name and emails do people use for you?"; field label `Names and emails`; hint `Separate them with commas. I use these to tell which tasks are yours.`; below it `Your sign-in email, {email}, is always included.`; actions `Save` and `Skip`. Up to 20 names and emails, each up to 100 characters (limits decided, D40), with the errors in SITE_CONTRACT §2.13 (D39). Skippable; signed-in email always saved as an alias |
| Sensitive-data note | Sets expectations before first paste | "Don't paste passwords or full account numbers."; shown on the sign-in page and in onboarding |
| Analytics notice | Explains event-only analytics | Plain statement + opt-out link; no content is ever sent. Ships with the first PostHog event and stays hidden until then (D40, rule 9). Approved wording (D46, Oct 21): `Loose Ends counts which features you use. Analytics never include what you paste.` Opt-out link: `Turn off analytics` |

### 1. App shell and navigation

| Field | Description | Constraints |
|---|---|---|
| Product name | Brand label | Fixed: `Loose Ends`; use consistently |
| Primary navigation | Main destinations | `Today`, `Threads`, `Decisions` (D1) |
| Global Add | Capture from anywhere | Button labelled `Add`; opens the Add page/sheet |
| Account menu | Account and data controls | `Settings`, `Export data`, `Sign out` |
| Review chip | Pending proposals | `N to review`; shown only when N ≥ 1; count is real pending proposals |
| Demo-date banner | Simulated clock indicator | Only in `DEMO_MODE` with a date set: `Demo date: Thu Oct 8, 2026` (D12) |

### 2. Add / Capture

| Field | Description | Constraints |
|---|---|---|
| Page heading | Invites the user to capture source material | `Drop something in` (D47) |
| Mode tabs | Choose input type | `Paste`, `Upload`, `Quick add` |
| Text input | Pasted source text | Label `Paste a message or document`, hint `Up to 30,000 characters.` (D47). Max 30,000 characters; live count near the limit; preserve original text; validate rather than silently truncate |
| File picker | Upload source documents | PDF, TXT, MD, DOCX; max 10 MB and 30 pages; one file at a time; text-layer files only for MVP |
| Source title | Optional human-readable source name | Optional, under the disclosure `Add a title`, field label `Title (optional)` (D47); max 120 characters; user-editable |
| Written-on date | Date associated with the source | Optional; default to today only when visibly labelled `Assumed`; ISO date internally. Field label `I assumed this was written today. Change it if it wasn't.` until the user sets a date, then `Written on` (D47); valid range 1900–2100 |
| Quick-add text | A brief note or commitment entered directly | Single line; max 2,000 characters; preserve user wording |
| AI provider notice | Tells the user where their text goes before they send it | Conditional (D42, PRD Question #12): required on Paste, Upload and Quick add if the deployment uses the Gemini free tier; plain words that the text goes to Google, which may use it to improve its products, and that people at Google may read it. Wording pending user approval. Never claim the data is not used or not read |
| Submit / progress / error | Starts extraction and communicates state | `Review source` (paste/upload) or `Add` (quick add); progress tied to real pipeline steps; errors from the error copy table (site contract §2.13) |

### 3. Extraction and Review Tray

| Field | Description | Constraints |
|---|---|---|
| Tray heading and count | Explains that suggestions need review | `I found N things in this`; count only actual proposals |
| Groups | Proposals by confidence | `Likely` (High, pre-checked), `Maybe` (Medium, unchecked), `Also noticed` (Low, collapsed, unchecked); Ignore never shown (D3) |
| Proposal title | Short label for a candidate open loop | Prefer source wording; aim for 3–10 words; max 80 characters |
| Loop type | Candidate category | `Commitment`, `Request`, `Waiting on`, `Admin`, or `Decision`; set by the type → kind mapping (D5); user can change |
| Suggested next action | What the user may need to do | Specific, actionable, concise; labelled `Suggested` |
| Counterparty | Person or organization involved | Optional; use only when supported by source; flag ambiguous identity |
| Due date | Candidate date or deadline | Explicit dates plain; inferred dates carry an `Assumed` chip with the resolution explained; never invent a precise date. A month-day with no year is in the past only if it falls within 30 days before the written-on date, otherwise the next occurrence (D28) |
| Confidence label | Strength of extraction | Dot + word + reason, e.g. `Likely · Clear commitment with a date`; colour never the only signal |
| Evidence quote | Verbatim source excerpt supporting the proposal | Must match source exactly; include page/location when available; if no verifiable quote, the item is not shown |
| Review choice | User disposition of proposal | `Accept`, `Edit`, or `Reject`; `Accept selected` and `Reject all` at tray level. Disabled reasons (D47): `Nothing selected.` (Accept selected, nothing checked); `I can't tell who this is waiting on, so it can't be added yet.` (a waiting-on card with no counterparty) |
| Clarification | Resolve ambiguous roles (e.g. "Which of these is you?") | Ask only when a high-value item has an unknown owner; list detected names + `None of them`; offer `Remember "{name}" as you?` afterwards |
| Review result | Outcome of review | Accepted/edited proposals become threads; rejected proposals are stored for suppression and never treated as commitments; summary line `2 threads added · View in Today`; singular `1 thread added` (D47) |
| Zero-proposal state | Nothing found | `Nothing here needs your attention`, plus the document brief if one exists |

### 4. Today

| Field | Description | Constraints |
|---|---|---|
| Greeting | Daily orientation | User's local date, e.g. `Sunday, October 18`; no name-based cheerfulness |
| Count line | Small, true count | `2 things are worth your attention`; omitted when zero; never "You have N reminders" |
| Worth your attention | Items requiring attention | At most 5; deterministic ranking; score ≥ 0.3; never unaccepted Low proposals (D4) |
| Thread title | Identifies the open loop | Brief; understandable without source context |
| Reason line | Why it is here | Deterministic, grounded in source, e.g. `You told Mike "Friday" on Oct 5 · Why?` |
| Due chip | Timing cue | `Due tomorrow`, `Fri Oct 9`, `3 days overdue`; `Assumed` chip for inferred dates |
| Quick actions | Common actions from the row | `Done` (or `Resolve…` for decision threads), `Snooze`, `Why?`; reversible with undo (D6, D8) |
| Waiting on others | Items blocked on someone else | Collapsed with count; a thread surfaces into the attention list when past `expected_by` |
| Coming up | Next 14 days | Collapsed with count |
| Recently resolved | Last 7 days | Collapsed with count |
| Still relevant? | Stale-thread prompt | Shown once on threads > 30 days overdue: `Resolve`, `Dismiss`, `Keep` |
| Empty state | Nothing needs attention | `Nothing needs you right now.` + one secondary action (`Add something`) |

### 5. Threads index (v1.1)

| Field | Description | Constraints |
|---|---|---|
| Page heading | Names the collection | `Threads` |
| Filter | Active vs closed | `Active` (Open, Waiting, Snoozed) and `Closed` (Resolved, Dismissed) (D7) |
| Row | One thread | Status icon + word, title, due chip; sorted by due date, undated last |
| Empty state | Nothing in the filter | Active: `No open threads. Add something to get started.` Closed: `Nothing closed yet.` |

### 6. Life Thread detail

| Field | Description | Constraints |
|---|---|---|
| Thread title | Name of the real-world situation | User-editable; concise |
| Loop type | Classification | Same allowed values as Review Tray |
| Status | Current lifecycle state | `Open`, `Waiting`, `Snoozed`, `Resolved`, `Dismissed`; overdue is derived, never a status (D2) |
| Section headings | Labels on Thread detail | `Next action`, `Evidence`, `History` (D47) |
| Next action | Next unresolved action | Specific; user-editable; `Suggested` label until the user edits or accepts it |
| Due date and certainty | When action is due, if known | Explicit, assumed (inferred), or none; never fabricate |
| Counterparty / waiting-on | Person or entity involved | Optional; grounded in source or user correction; `expected by` date when waiting |
| Confidence label | Origin confidence | Same dot + word + reason as the tray |
| Explain card | Brief explanation of the situation | Sections: What this is · What you need to do · By when · If you don't · Worth considering · Not sure about; each line is a source fact (quote) or labelled `Interpretation`; quick-add threads show only What to do and By when |
| Evidence | Traceability to original source | Verified quote, source name, page/date; `Open source` link. Source line reads `Source deleted` once the source is deleted (D47) |
| Why? entry | Opens the Why panel | Present on Thread detail and every Today row |
| Thread history | Chronological updates and actions | Timestamped; append-only; corrections read `You changed the date from Oct 9 to Oct 12`. Event lines (D47): `You accepted this from your source.`, `Added from quick add.`, `You marked this done.` / `Loose Ends marked this done.`, `You resolved this.` / `Loose Ends resolved this.`, `You undid the last change.`, `You reopened this.`, `You snoozed this.`, `You edited this.`, `Status changed to {status}.`; fallback `Updated.` |
| Decision | If resolved as Decided | Choice, `You wrote` reason, date |
| Actions | Manage thread | `Done`, `Resolve…`, `Mark waiting`, `Snooze`, `Edit`, `Dismiss`, `Reopen`, `Forget permanently`; only Forget is confirmed (D8). Done shows the toast `Marked done: "{title}"` + `Undo` (D47). Undo restores the state before the action and adds an `undone` history line; the toast lasts 8 s and the server accepts the undo up to 12 s (D44). Until F11 ships, `Resolve…` is disabled with `Resolving with a decision isn't available yet.` (D47) |

### 7. Why panel (v1.1, F8)

| Field | Description | Constraints |
|---|---|---|
| Panel title | Names the question | `Why am I seeing this?` |
| Quote in context | The evidence with surroundings | Verified quote highlighted inside ±200 characters of source context; source name and date |
| Reasoning steps | How the system read it | Deterministic templates, e.g. `I read "Friday" as Fri Oct 9 (message dated Mon Oct 5).` |
| Why now | Surfacing reason | e.g. `It's still open. It's due tomorrow.` |
| Corrections | User edits win | `You changed the date from Oct 9 to Oct 12`; AI's original value never shown as current |
| Deleted-source state | Source purged | `Original source deleted on {date}.` Quote still shown |
| Actions | Correct or inspect | `This is wrong` (→ Edit or Dismiss), `Open source` (hidden when deleted) |

### 8. Source viewer (v1.1)

| Field | Description | Constraints |
|---|---|---|
| Header | Identifies the source | Title (or `Pasted text`), kind, written-on date (with `Assumed` if defaulted), added date |
| Body | The source text | Normalized text; PDFs shown with page markers; quoted span highlighted and scrolled into view |
| Linked threads | What came from this source | List of thread titles with status |
| Actions | Manage source | `Back to thread`, `Delete source…` |

### 9. Resolve and Decision Memory

| Field | Description | Constraints |
|---|---|---|
| Sheet heading | Asks how it ended | `How did this end?` |
| Resolution choice | How the loop ended | `Done`, `Decided`, or `Not needed` (D10); user-selected |
| Decision | Outcome or choice | Shown when Decided; prefilled from the thread, editable; preserve user's wording |
| Remember why? | Optional prompt to save rationale | `Want me to remember why?`; Skip is one tap and equally prominent; never re-prompted |
| User reason | User's explanation for the decision | Preserve verbatim; optional |
| AI summary | Condensed rationale, if generated | Optional; labelled AI-generated; never replaces original wording |
| Resolution date/context | When and in what context it was resolved | Timestamp; context facts snapshotted with evidence IDs |

### 10. Decisions and Ask Why

| Field | Description | Constraints |
|---|---|---|
| Page heading | Names the destination | `Decisions` |
| Question input | User asks about a past decision | Placeholder `Ask about a past decision`; scoped to stored decisions |
| Grounded answer | Response from saved decisions | Parts labelled `You decided` (date) · `You wrote:` (verbatim, in quotes) · `From the source:` · `Interpretation:` |
| Context link | Opens the supporting record | `Open thread` |
| No-recorded-decision state | No match | `I don't have a recorded decision about that.`; no LLM call |
| No-recorded-reason state | Decision exists without a reason | Say so plainly; offer `Add a reason now` |
| Decision list | All decisions, newest first | Choice, thread title, date; empty state `Decisions you record when resolving threads will appear here.` |

### 11. Settings and Data

| Field | Description | Constraints |
|---|---|---|
| Display name / aliases | Helps resolve references such as "you" | User-controlled list; add/remove |
| Timezone | Correct interpretation of dates and reminders | User-selectable; IANA identifier internally |
| Analytics | Event-only analytics | Toggle labelled `Analytics` in the `Profile` section, on by default (opt-out); its description is the notice sentence `Loose Ends counts which features you use. Analytics never include what you paste.` Load failure: `Settings didn't load. Try again.` (D46). Ships with the first PostHog event and stays hidden until then (D40) |
| Retain original source | Controls source retention | Toggle, on by default; explain effect before changing |
| Sources list | Every source the user added | Title, kind, date, derived thread count |
| Delete source | Per-source deletion | Two options: `Delete source only` (threads keep quotes) or `Delete source and everything from it`; confirmation lists what is deleted and what remains |
| Forget thread | Permanently removes a thread and associated data: the thread, its evidence, history and decision, the proposal it came from (payload, title and quote), and any Explain-card lines that quote it, even if the source is kept (D35). Only a one-way suppression hash remains, so the same item is not proposed again (D29) | From Thread detail; confirmation with optional `Also delete source`; the confirmation lists what is deleted |
| Export data | Download user's data | JSON; threads, evidence/provenance, decisions, sources metadata |
| Delete account | Removes all data and storage (D14) | Confirmation requires typing `delete`; explains backup expiry honestly |
| Privacy/data explanation | Explains storage and use | Matches PRIVACY.md; no unimplemented promises. Names Google (Gemini API) as the AI provider; free-tier terms disclosed if used (D42) |
| Sign out | Ends account session in this browser | Local-only: other browsers and devices stay signed in; there is no "sign out everywhere" (D39). Confirms only after the session has ended |
| SHOULD-only fields | Digest on/off and hour; per-type toggles | Shown only if F15/F17 ship |

## Glossary (user-facing terms, D10)

| Use | Never use | Meaning |
|---|---|---|
| Done | Complete, Finished | One-tap resolution with `resolution = done` |
| Resolve… | Close | Opens the Resolve sheet |
| Not needed | No longer needed | Resolution where the loop stopped mattering |
| Dismiss | Delete, Hide | It was never a real loop; kept as suppression record |
| Forget permanently | Delete thread | Irreversible hard delete |
| Assumed | Inferred, Guessed | Date or field the system resolved without explicit text |
| Interpretation | AI says, Insight | AI reasoning not stated in the source |
| Suggested | AI-generated, Recommended | AI-proposed value the user has not confirmed |
| You wrote | Your note | User's verbatim words |
| Likely / Maybe / Also noticed | High / Medium / Low, percentages | Confidence labels |

## Remaining gaps / deferred

- **Duplicate/conflicting proposals (F14):** deferred unless the day-14 checkpoint was green. Even without F14, a proposal that would change an existing thread's date must show both values and both quotes; never silently overwrite.
- **Daily digest / forwarding / type toggles / redaction:** SHOULD features; their settings fields appear only if built.
- **Trust scorecard:** README and demo materials only, not a user-facing page.

## MVP flow

`Sign in → Onboarding → Add → Review Tray → Today → Thread detail (Why panel, Source viewer) → Resolve / Decision Memory → Decisions / Ask Why → Settings & Data`

## Content and trust rules

1. AI-generated proposals and fields are visibly labelled `Suggested` or `Interpretation` until the user accepts or edits them.
2. Evidence excerpts are verbatim and traceable to their source.
3. Explicit and assumed dates are visually distinguishable; uncertain dates remain uncertain.
4. Unaccepted low-confidence proposals are never auto-accepted, ranked or notified.
5. User-provided wording and decision rationale are preserved; AI summaries are supplemental.
6. Errors, empty states, and missing rationale are communicated honestly.
7. Reversible actions use undo; irreversible actions use confirmation (D8).
