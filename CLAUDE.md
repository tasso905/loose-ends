# CLAUDE.md — Loose Ends

Loose Ends turns messages and documents the user pastes in into a short list of open loops, each backed by the exact sentence it came from, and remembers why the user closed them. MVP for Build Fest: 30 days, Oct 2 → Oct 31, 2026.

## Source of truth

Read the relevant document before changing behaviour, copy or visuals. When they conflict, the order below wins, and the conflict is raised with the lead-program-manager agent rather than resolved silently.

1. `docs/PRD.md` (v1.1) — product, scope, schema, API, AI behaviour. Its **Decisions Log (D1–D60)** overrides older text anywhere. Entries marked *Proposed* take effect only after the user confirms them.
2. `docs/SITE_CONTRACT.md` (v1.1) — pages, routes, states, error copy, behaviour.
3. `docs/CONTENT_MODEL.md` (v1.1) — fields, constraints, user-facing glossary.
4. `docs/DESIGN_STANDARD.md` — visual standard: tokens, type, spacing, components, motion, microcopy.

Do not load these whole by default; open the section you need (they are long).

## Stack

Next.js App Router + TypeScript · Tailwind + shadcn/ui + Lucide · Supabase (Postgres, Auth, Storage, RLS) · Vercel AI SDK `generateObject` + Zod (deprecated in AI SDK 7, kept for now; D34) · `unpdf`, `mammoth` · `chrono-node` + `date-fns-tz` · Vitest, Playwright, `@axe-core/playwright` · Sentry, PostHog · Vercel hosting + Cron.

No separate backend, queue, vector DB, LangChain, Redis or ORM-managed migrations.

## Commands

| Task | Command |
| --- | --- |
| Local Supabase | `pnpm exec supabase start -x vector,logflare` (those two containers can fail health checks on macOS) |
| Dev server | `pnpm dev --hostname 127.0.0.1` (open 127.0.0.1:3000, not localhost) |
| Typecheck / lint | `pnpm typecheck` · `pnpm lint` |
| Unit + integration | `pnpm test` |
| Live Supabase checks (RLS, storage, deletion; needs local Supabase running) | `pnpm test:supabase` |
| E2E (recorded LLM fixtures) | `pnpm test:e2e` |
| Extraction + Ask-why eval (live model, costs money) | `pnpm eval` |
| New migration | `pnpm exec supabase migration new <name>` |

`pnpm dev`, `pnpm eval` and `supabase start` come from the PRD. The Supabase CLI is a devDependency, so it runs through `pnpm exec` (D34). The other script names are the expected convention; if `package.json` differs, update this table.

## Repository layout

```
app/                  Next.js routes (see SITE_CONTRACT §1.2 route map)
components/           UI (shadcn/ui based)
lib/ai/               provider config, extract(), askWhy()
lib/pipeline/         normalize, redact, verifyQuotes, resolveDates, score, dedupe
lib/threads/          transition(), attentionScore(), why()
lib/time.ts           getNow() — the only clock
prompts/              extract.v1.md, ask-why.v1.md (versioned)
supabase/migrations/  SQL, additive only during Build Fest
evals/fixtures/       synthetic inputs + golden outputs; evals/run.ts
tests/                unit, integration, e2e
docs/                 PRD, SITE_CONTRACT, CONTENT_MODEL, DESIGN_STANDARD, ARCHITECTURE, PRIVACY, AI_BEHAVIOR
```

## Non-negotiable rules

These encode the product's trust model. Breaking one is a bug even if tests pass.

1. **No verified quote, no item.** Every displayed AI item has a server-verified verbatim quote (exact, or fuzzy ≥ 0.9). Unverified items are dropped and logged as `quote_unverified`.
2. **Proposals, not facts.** Nothing from paste/upload becomes a thread until the user accepts it. Only High-confidence quick-add items auto-create, always with an 8 s undo.
3. **Dates are deterministic.** `chrono-node` re-resolves every date; on disagreement keep chrono's value, mark `inferred`, add a "Not sure about" line. Never fill a missing date, amount or name.
4. **Low confidence never surfaces unasked.** Unaccepted Low items never appear in Today; Low-origin threads never appear in a digest (D4).
5. **Facts, user words and interpretation look different** — the "Three voices" in DESIGN_STANDARD.md. User text and decision reasons are stored and shown verbatim.
6. **No LLM at view time.** Why panel, surfacing reasons and confidence labels come from stored fields and templates.
7. **Ask why answers only from retrieved decisions.** Zero matches → "I don't have a recorded decision about that." with no LLM call; reject cited IDs outside the retrieved set.
8. **Delete means delete.** Forget permanently and source deletion hard-delete rows and storage objects, verified by tests.
9. **Privacy claims match implementation.** Never write "fully private", "zero retention" or "end-to-end encrypted". Analytics events carry IDs, enums and counts only, never content.
10. **Success only after success.** No UI claims an action worked before the server confirms it.

## Engineering conventions

- All time logic calls `getNow()` from `lib/time.ts`; never `new Date()` or `Date.now()` in app logic.
- All status changes go through `transition(thread, action)`; the PRD lifecycle transition table is the spec, and anything else returns `invalid_transition`.
- Every thread mutation appends a `thread_events` row with before/after values; history is never rewritten.
- RLS on every table (`user_id = auth.uid()`). Use the service role only in `cron/daily`, account deletion and inbound email.
- Validate every input with Zod. Error responses use `{error: {code, message, retryable}}` and the copy in SITE_CONTRACT §2.13.
- Changing a prompt, model or schema requires running `pnpm eval` and recording the result; bump the prompt version.
- Migrations are additive until Oct 31 — no dropped or renamed columns.
- Fixtures are synthetic only. Never commit real personal documents.

## UI conventions

- Use DESIGN_STANDARD.md tokens (`--le-*` in code) — no raw hex, px or ms values in components.
- IBM Plex Sans for UI, IBM Plex Serif only for verbatim source quotes. No italics.
- Icons: exactly the Lucide names in DESIGN_STANDARD.md's Iconography map, `strokeWidth={1.75}`.
- User-facing words come from the CONTENT_MODEL glossary: Done, Resolve…, Not needed, Dismiss, Forget permanently, Assumed, Interpretation, Suggested, You wrote, Likely / Maybe / Also noticed.
- Reversible actions: execute + 8 s undo toast. Irreversible actions: confirmation dialog, no undo (D8).
- WCAG 2.1 AA; never colour alone; `prefers-reduced-motion` respected; 44 px touch targets below 768 px.

## Agents

Three project subagents live in `.claude/agents/`. Delegate to them by name ("use the lead-tester agent to…") or with `@agent-<name>`.

| Agent | Owns | Use it when |
| --- | --- | --- |
| `lead-developer` | Architecture, pipeline, schema, API, UI implementation | Building or changing features, fixing bugs, reviewing code against the docs |
| `lead-tester` | Test strategy, unit/integration/E2E, evals, accessibility, acceptance checks | After any feature or fix; before merging; before each gate; when a prompt/model changes |
| `lead-program-manager` | Scope, schedule, gates, Decisions Log, doc consistency, status | Planning work, deciding cuts, resolving doc conflicts, gate reviews, status reports |

**Handoff loop:** program manager scopes the work against the MUST/SHOULD/NICE line → lead developer implements and lists the acceptance criteria touched → lead tester verifies independently and reports pass/fail with evidence → program manager updates status and the Decisions Log. The tester does not fix product code, and the developer does not mark their own work verified.

## Schedule and gates

**Re-planned Oct 18 (day 17).** The day-14 checkpoint (Oct 15) was not met because nothing had been built. Plan, assumptions and block owners: PRD "Re-plan, Oct 18" (D15–D27). The user confirmed the gate dates below on Oct 21 (D19, D45). Days count from Oct 2 = day 1.

| Gate | Date | Exit criteria |
| --- | --- | --- |
| Core-loop checkpoint (replaces day 14) | Fri Oct 23 | In production: magic link → paste → review → accept → thread → Done. Text-layer PDF → Explain card; scanned PDF shows the unsupported message. Quote, date, band and `transition()` unit tests pass. RLS test passes. `pnpm eval` runs on ≥ 20 fixtures |
| Feature freeze (was Oct 22) | Mon Oct 26 | Resolve + Ask why work, including the zero-match path. Today ranks and caps at 5. Why panel renders from stored fields. Forget, source deletion, account deletion and export are verified by tests. Demo is ready: `Try the demo` with seed, clock and banner, guard rails and 24 h cleanup (D55; one production site, no separate demo deployment). Rate limit and budget cap are on. Cuts are recorded. Fixes only after this |
| Eval gate (was Oct 27) | Wed Oct 28 | 40-fixture eval passes thresholds; Ask-why 0 fabrications; axe checks pass; E2E demo flow passes; scorecard generated |
| Submission | Sat Oct 31 | README, ARCHITECTURE, AI_BEHAVIOR, PRIVACY, CONTRIBUTING, LICENSE merged; privacy copy check passes; 5 rehearsals under 2:30; video recorded. Target send Oct 30 |

**Cuts applied: none yet.** The user overrode the day-14 rule on Oct 18 (D24; D16 suspended), so F14–F18 stay in scope. The proposed cuts DOCX (D17), Explain card "Worth considering" (D18) and the MUST trims (D20: "Which of these is you?", "Still relevant?") are deferred, not decided. Google sign-in (D20(a)) is settled by D41: kept behind a flag and switched on only if the user's OAuth setup and a manual check pass by Oct 24; otherwise email link only. A SHOULD feature's UI stays hidden and unclaimed (including redaction) until the lead-tester verifies it.

**Scope review: Sun Oct 25 (day 24, D25).** The user decides cuts from one week of progress, applying the cut order and never-cut list below unchanged. The same review decides D17, D18 and D20(b)–(c), records the Google outcome (D41) and may reconsider the Mon Oct 26 freeze date (confirmed Oct 21, D45), which falls the next day. Weekday labels were corrected on Oct 22 (D53): the review is a Sunday and the freeze a Monday; the dates are unchanged.

**Build order (D26):** MUST and never-cut work first. Then SHOULD work in reverse cut order: "Worth considering" → DOCX → F14 dedupe → F17 toggles → F15 digest → F16 forwarding last. F18 redaction goes in with the F5 pipeline work where it fits. SHOULD work never displaces a MUST block.

**LLM provider (D42):** Google Gemini via `@ai-sdk/google` (`AI_PROVIDER=google`, model pinned in `AI_MODEL`), chosen Oct 20. Free tier during development and eval, with synthetic fixtures only; free vs. paid for the public demo is decided at deployment (Gemini's free tier may use prompts to improve Google's products, so the privacy copy must say so if it stays). Tests and E2E use the fake recorded-fixture provider. **License:** MIT (D23).

**Cut order (applied at the Oct 25 review):** F16 forwarding → F15 digest → F17 toggles → F14 dedupe → DOCX → Explain card "Worth considering", then the D20 items. Anything beyond that touches a MUST and goes to the user. **Never cut:** quote verification, date re-resolution, review tray, Why panel, delete.

**Eval thresholds:** recall ≥ 80%, precision ≥ 75%, date accuracy ≥ 95%, owner accuracy ≥ 90%, band accuracy ≥ 85%, unverified quotes shown = 0, Ask-why fabrications = 0.

## Never build in the MVP

Gmail/Outlook/calendar integrations, a chat interface, native apps or push notifications, projects/tags/priorities/subtasks/kanban, and any autonomous action (auto-send, auto-complete, drafted replies).
