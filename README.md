<!-- Temporary README (Oct 20). Loose Ends is no longer being submitted to Build Fest; it continues as a learning project with no deadline (PRD D62). The full README is normal project work. -->

# Loose Ends

**Tie up your loose ends.**

Loose Ends turns messages and documents you paste in into a short list of open loops, each backed by the exact sentence it came from, and remembers why you closed them.

**Status:** started for Build Fest (Oct 2026) and not submitted; now a learning project in active development, with no deadline.

- **Works today:** email-link sign-in, Google sign-in (optional, off by default locally) and onboarding.
- **Not built yet:** paste → review → threads, the core loop. Nothing is extracted from your text yet.

## AI provider and your data

Once extraction ships, pasted text, and later the decisions and quotes used to answer Ask why, are sent to the configured AI provider: Google Gemini (PRD D42). On Gemini's free tier, Google may use prompts and responses to improve its products, and people at Google may read them. **Contributors must use synthetic data only.** Never paste or commit real personal messages or documents.

## Prerequisites

- **Node.js 24.** This is the version CI uses. The repo has no `.nvmrc` or `engines` field.
- **pnpm 12.14.0.** Pinned in `package.json` (`packageManager`).
- **Docker Desktop.** Running, for local Supabase.

## Local setup

1. Install dependencies.

   ```sh
   pnpm install
   ```

2. Start local Supabase without the analytics and vector containers. They can fail health checks on macOS, and the app does not need them.

   ```sh
   pnpm exec supabase start -x vector,logflare
   ```

3. Create `.env.local` from the example.

   ```sh
   cp .env.example .env.local
   pnpm exec supabase status -o env
   ```

   Then set these values in `.env.local`:

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | `API_URL` from the status output (`http://127.0.0.1:54321`) |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `ANON_KEY` from the status output |
   | `SITE_URL` | `http://127.0.0.1:3000` |
   | `AI_PROVIDER` | `fake` (replays recorded fixtures, no network calls, no key needed) |
   | `AI_MODEL` | `recorded` |

4. Start the dev server on 127.0.0.1 and open <http://127.0.0.1:3000>.

   ```sh
   pnpm dev --hostname 127.0.0.1
   ```

   Use `127.0.0.1`, not `localhost`. Sign-in must return to the same origin it started from, and without `--hostname 127.0.0.1` the dev server blocks the page's scripts at that address, so the sign-in button stays disabled.

5. Sign-in emails go to Mailpit at <http://127.0.0.1:54324>.

## Optional

**Google sign-in.** This is off by default. Follow the comments above `[auth.external.google]` in `supabase/config.toml` and in `.env.example`:

- Put `SUPABASE_AUTH_EXTERNAL_GOOGLE_ENABLED`, `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` in `supabase/.env` (gitignored), then restart Supabase.
- Set `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED=true` in `.env.local`.

**Gemini.** Set `AI_PROVIDER=google`, `AI_MODEL=gemini-3.5-flash` and `AI_API_KEY` (a key from Google AI Studio) in `.env.local`. Live calls may count against your quota.

## Commands

| Task | Command |
| --- | --- |
| Dev server | `pnpm dev --hostname 127.0.0.1` |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Unit + integration tests | `pnpm test` |
| Live Supabase checks (needs local Supabase running) | `pnpm test:supabase` |
| E2E tests (recorded AI fixtures, local Supabase) | `pnpm test:e2e` |
| Extraction + Ask-why eval (live model, uses quota; reads `AI_PROVIDER`, `AI_MODEL` and `AI_API_KEY` from the shell environment, not `.env.local`) | `pnpm eval` |

`pnpm test:e2e` serves the app on 127.0.0.1:3000 and reuses a server already running there, so stop `pnpm dev` first.

## Project docs

- [docs/PRD.md](docs/PRD.md): product, scope, schema, API, AI behaviour and the Decisions Log.
- [docs/SITE_CONTRACT.md](docs/SITE_CONTRACT.md): pages, routes, states and error copy.
- [docs/CONTENT_MODEL.md](docs/CONTENT_MODEL.md): fields, constraints and the user-facing glossary.
- [docs/DESIGN_STANDARD.md](docs/DESIGN_STANDARD.md): visual standard (tokens, type, components, motion).
- [CLAUDE.md](CLAUDE.md): working rules, schedule, gates and agent roles.

## License

MIT. See [LICENSE](LICENSE).
