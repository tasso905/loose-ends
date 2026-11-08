# Privacy: draft for the `/privacy` page

**Status: wording approved Nov 8, 2026 (user, "all good for privacy", after reading draft PR #46; relayed by the coordinator; D82).** The approval covers the wording of P1–P33 and of the one alternative noted under P11. Sentences marked *approved Nov 4* reuse wording first approved for the deletion dialogs (`lib/account/copy.ts`).

**Still blocks shipping (Nov 8).** Approving the wording doesn't confirm the facts. A row marked **Needs checking, blocks shipping** stays off the page until it is confirmed.
- **The user:** nothing. The support email came Nov 8 (P33).
- **The lead-tester:**
  - P4: that Supabase stores the Google name and picture.
  - P11–P13 and P31: that production really sends analytics events.
  - P17: that the current Gemini API terms still say what P17 says.
  - P25: a review of every `log(` call site.
  - P32: a browser check of the cookies.

Since the Nov 8 answers, P23, P24, P28, P29 and P33 no longer block, and P17's tier is confirmed. The user's words were "3 is done 4. free 5. build it later", "2. paid" and "use info@piscesparadigm.ca", relayed by the coordinator.

**How to read this file.** Each row is one sentence for the page, the code or migration it rests on, and whether it is confirmed. **Needs checking** means the code cannot confirm it. This file is written from the implementation on `main` (Nov 8, after PR #45), not from the PRD (rule 9). It must never use the three phrases rule 9 in CLAUDE.md bans. This file doesn't quote them, so a copy check can scan it.

The page shows the sections in this order, with the "Text" column only.

## 1. About this page

| # | Text (approved Nov 8) | Evidence | Check |
| --- | --- | --- | --- |
| P1 | This page says what Loose Ends stores, who else handles it, and what deleting removes. It describes what the app does today. | Rule 9 | — |
| P2 | Last updated: {date}. | Set when the page ships | — |

## 2. What Loose Ends stores

| # | Text (approved Nov 8) | Evidence | Check |
| --- | --- | --- | --- |
| P3 | Your email address, so you can sign in. | Supabase Auth `auth.users` | Confirmed |
| P4 | If you sign in with Google, Google shares your name, email address and profile picture. Loose Ends asks for nothing else from your Google account, and it can't read your Gmail, calendar or contacts. | Scopes `openid email profile` only (PRD F1; D76: the consent screen asked only for name, email and profile picture); no Gmail or calendar code (never-build list) | **Needs checking, blocks shipping (lead-tester):** that Supabase stores the name and picture in `auth.identities.identity_data`, as expected |
| P5 | Everything you add: text you paste, files you upload and the text read from them. | `public.sources.text_content`; files in the private `sources` bucket at `sources/{user id}/{source id}` (`app/add/actions.ts`, comment at line 73; migration `20261018184149_rls_and_storage.sql`) | Confirmed |
| P6 | What Loose Ends finds in it: suggestions, a summary of each document, the threads you accept, their quotes and history, and any decisions and reasons you record. | Tables `extraction_items`, `extractions`, `threads`, `evidence`, `thread_events`, `decisions` (migration `20261018184147_initial_schema.sql`) | Confirmed |
| P7 | Your settings: your name, the other names and emails you gave so Loose Ends can tell which tasks are yours, your timezone, and your analytics choice. | `profiles.display_name`, `profiles.aliases`, `profiles.timezone`; `user_settings.analytics_enabled` (migrations `20261018184147`, `20261020195158`) | Confirmed |
| P8 | Daily counts of how much you added and asked, for the daily limits. | `public.usage_counters` (per user, per UTC day) | Confirmed |
| P9 | Your text is kept until you delete it or your account. Nothing is deleted automatically. | No retention purge (D61); `user_settings.keep_source_text` defaults to true and nothing reads it to purge | Confirmed |
| P10 | Supabase, which runs sign-in, can record sign-in events, in the database and in its own logs. | `auth.audit_log_entries` (migration `20261104100000_auth_audit_purge.sql`); production Logs → Auth rows (Nov 7, D77) | Confirmed by observation |

## 3. Analytics

| # | Text (approved Nov 8) | Evidence | Check |
| --- | --- | --- | --- |
| P11 | If analytics is on, Loose Ends tells PostHog which features you use. Each event carries IDs, fixed categories and counts. It never includes what you paste, titles, quotes, names or reasons. | `lib/analytics/events.ts`: strict schemas, no free-text property; `lib/analytics/track.ts` | Confirmed in code. The user says `ANALYTICS_ENABLED=true` and `POSTHOG_KEY` are set in Vercel Production (Nov 8), so the page uses P11–P13, not the alternative "Loose Ends doesn't send analytics right now." (approved Nov 8, now unused). The Settings ship flag `SETTINGS_ANALYTICS_TOGGLE_SHIPPED` is already `true` on `main` (`lib/supabase/env.ts`, line 30). **Needs checking, blocks shipping (lead-tester):** that production really sends events |
| P12 | Analytics is on unless you turn it off in Settings. | `user_settings.analytics_enabled` defaults to true (migration `20261020195158`); opt-out (D40); toggle in Settings | Confirmed |
| P13 | Events are sent from the Loose Ends server, tied to your account ID only, with location lookup turned off. | `distinctId: userId`, `disableGeoip: true`, `$process_person_profile: false` (`lib/analytics/track.ts`) | Confirmed |

## 4. What the AI sees

| # | Text (approved Nov 8) | Evidence | Check |
| --- | --- | --- | --- |
| P14 | When you paste text or upload a file, Loose Ends sends its text to Google's Gemini API to find what's still open. With it go the names and emails you gave, your timezone, the date the text was written, and the titles of up to 30 of your open threads. | `buildExtractPrompt` (`lib/ai/extract.ts`, lines 73–83); `MAX_OPEN_THREADS_IN_CONTEXT = 30`; provider `google` (`lib/ai/provider.ts`) | Confirmed |
| P15 | When you ask why, Loose Ends sends your question and the recorded decisions that match it: each one's thread title, the person involved, what you decided, your reason, the date and its quotes. If nothing matches, nothing is sent. | `buildAskWhyPrompt` (`lib/ai/askWhy.ts`, lines 96–107); zero matches make no model call (`lib/decisions/ask.ts`, line 22; rule 7) | Confirmed |
| P16 | Loose Ends doesn't remove anything from your text before sending it, so don't paste passwords or full account numbers. | Redaction (F18) is not built: nothing in `lib/` or `app/` redacts. The second half is the approved notice (SITE_CONTRACT §2.0) | Confirmed |
| P17 | Loose Ends uses Gemini's paid tier. Google's terms for it say Google doesn't use what you send, or its answers, to improve its products. Google may keep them for a limited time to detect abuse, as its terms describe: [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms). | D81 (user, Nov 7); the paid tier was confirmed by the user in Google AI Studio on Nov 8 | Tier confirmed. **Needs checking, blocks shipping (lead-tester):** that the current Gemini API terms still say this |

## 5. Deleting

| # | Text (approved Nov 8) | Evidence | Check |
| --- | --- | --- | --- |
| P18 | **Forget permanently** deletes a thread, its history and any decision and reason, its quotes, the suggestion it came from, and any summary lines that quote it. A one-way fingerprint stays, so the same item isn't suggested again. | *Approved Nov 4* wording (`lib/account/copy.ts` `forgetDeletes`, `forgetStays`); `public.forget_thread` (migration `20261018220359`); `private.thread_suppression_hashes` (migration `20261104090000`) | Confirmed |
| P19 | **Delete source only** deletes the source's text and its file, its summary, and suggestions you haven't accepted. Threads you accepted from it keep their quotes. | *Approved Nov 4* (`sourceOnlyDeletes`, `sourceOnlyStays`); `public.delete_source` (migration `20261027122532`) | Confirmed |
| P20 | **Delete source and everything from it** also deletes every thread that came from it, with its quotes, history, decision and reason. A one-way fingerprint of each thread stays. | *Approved Nov 4* (`everythingDeletes`, `everythingStays`) | Confirmed |
| P21 | **Delete account** deletes every source and uploaded file, every thread, decision and reason, your settings and your sign-in. It also deletes the sign-in records in Supabase's database that name you. | *Approved Nov 4* (`accountDeletes`); `lib/account/deleteAccount.ts`; audit purge (migration `20261104100000`, D65); production SQL check returned 0 rows (D76) | Confirmed |
| P22 | If a file or sign-in record can't be removed straight away, Loose Ends tells you, and a daily job removes it. Until the sign-in records are gone, that job keeps your email address so it can find them. | Notices `accountDeleted*Remain` (`lib/account/copy.ts`, lines 104–106); `/api/cron/daily`, daily at 03:00 UTC (`vercel.json`, D67); `private.auth_audit_purges.email` (D65: told, not separately approved) | Confirmed |

## 6. What deleting can't reach

| # | Text (approved Nov 8) | Evidence | Check |
| --- | --- | --- | --- |
| P23 | Supabase's own platform logs keep records of requests, including your account ID. Loose Ends can't delete them. They expire on Supabase's schedule. | Seen in production Logs → Auth after a deletion (Nov 7, D77). Supabase's logs guide says only "Retention depends on your pricing plan" (https://supabase.com/docs/guides/platform/logs, checked by the coordinator Nov 8). The project is on the Free plan (user, Nov 8) | Confirmed. The text names no period, so it is true on any plan |
| P24 | Backups held by our hosting platform expire on its own schedule. | *Approved Nov 4* (`accountBackups`; PRD Privacy & Security). The project is on the Free plan (user, Nov 8). Supabase's backups guide says "We automatically back up all Pro, Team, and Enterprise Plan projects on a daily basis", lists no automatic backups for Free, and Storage objects are never in database backups (https://supabase.com/docs/guides/platform/backups, checked by the coordinator Nov 8) | Confirmed. The text names no period and is true whether or not backups exist |
| P25 | When something fails, the app logs it with IDs, codes and counts, not your content. Vercel keeps these logs for a limited time. | `lib/log.ts` writes to the console, which Vercel stores; the rule-9 convention is in the comment, not enforced by type. Some entries carry your user ID (for example `account_delete_sweep_failed`) | The retention half names no period, so it is true on any plan. **Needs checking, blocks shipping (lead-tester):** a review of every `log(` call site |
| P26 | Google, Vercel and PostHog keep what they received under their own terms. Deleting your account doesn't reach them. | Nothing in `lib/account/deleteAccount.ts` calls Google, Vercel or PostHog; the `account_deleted` event itself is sent to PostHog when you were opted in (`app/settings/data-actions.ts`) | Confirmed |

## 7. Export

| # | Text (approved Nov 8) | Evidence | Check |
| --- | --- | --- | --- |
| P27 | **Export data (JSON)** in Settings downloads one file with your sources and their text, suggestions, summaries, threads, quotes, history, decisions, settings, fingerprints and daily counts. Uploaded files aren't in it, but their text is. | `EXPORT_TABLES` (`lib/account/export.ts`, lines 11–22); `GET /api/export` (`app/api/export/route.ts`). `private.thread_suppression_hashes` is not exported (PR #38 known gap) | Confirmed |

## 8. Who else handles your data

| # | Text (approved Nov 8) | Evidence | Check |
| --- | --- | --- | --- |
| P28 | **Supabase:** database, sign-in, file storage and sign-in emails. | `@supabase/ssr`, `@supabase/supabase-js` (`package.json`); built-in email sender (D75) | Confirmed. The text names no region; if a later change names one, check it first |
| P29 | **Vercel:** hosting, the daily job and app logs. | `vercel.json`; `lib/log.ts` | Confirmed. The text names no region; if a later change names one, check it first |
| P30 | **Google:** the Gemini API reads what you add and what you ask (section 4), and Google sign-in, if you use it. | `@ai-sdk/google` (`lib/ai/provider.ts`); Google provider on in production (D76) | Confirmed |
| P31 | **PostHog (US):** analytics, if it is on (section 3). | `posthog-node`; US host `https://us.i.posthog.com` (`lib/supabase/env.ts`, D40) | **Needs checking, blocks shipping (lead-tester):** that production really sends events (see P11) |

Not on the page because they aren't used:
- **Sentry:** planned, not built. The user said "build it later" on Nov 8 (D84). There is no Sentry package or code on `main` (`package.json`). When Sentry ships, the change that ships it adds Sentry to this list and to the page, and the new wording needs the user's approval first (rule 9).
- **Resend:** not installed. Sign-in emails use Supabase's built-in sender (D75).

## 9. Cookies

| # | Text (approved Nov 8) | Evidence | Check |
| --- | --- | --- | --- |
| P32 | Loose Ends uses cookies only to keep you signed in, plus one that lasts two minutes and shows the notice after you delete your account. No advertising or tracking cookies. | `@supabase/ssr` session cookies; `le_account_deleted`, `maxAge: 120` (`app/settings/data-actions.ts`) | **Needs checking, blocks shipping (lead-tester):** a browser check that no other cookie is set |

## 10. Contact

| # | Text (approved Nov 8) | Evidence | Check |
| --- | --- | --- | --- |
| P33 | Questions or requests: info@piscesparadigm.ca. | Given by the user Nov 8 ("use info@piscesparadigm.ca"). The same address goes in Google's Branding page (SITE_CONTRACT §2.15) | Confirmed |
