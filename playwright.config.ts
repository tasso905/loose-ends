import { defineConfig, devices } from "@playwright/test";
import { localSupabase } from "./tests/e2e/localSupabase";

// E2E runs against local Supabase (Auth + Mailpit) and recorded LLM fixtures (AI_PROVIDER=fake);
// never a live model and never a cloud project.
const sb = localSupabase();
// E2E_PORT lets a second checkout run E2E next to a dev server already on 3000.
const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PROD = Boolean(process.env.CI || process.env.E2E_PROD);
// Lead-tester: LE_E2E_POSTHOG_HOST points the server at tests/e2e/tester-analytics-capture.spec.ts's local
// catcher. Only a 127.0.0.1 URL is accepted, so E2E can never send to a real PostHog host.
const E2E_POSTHOG_HOST = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.LE_E2E_POSTHOG_HOST ?? "")
  ? process.env.LE_E2E_POSTHOG_HOST!
  : "http://127.0.0.1:9";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // CI (or E2E_PROD=1) tests the production build; locally `next dev` keeps the loop fast.
    command: PROD ? `pnpm build && pnpm start --hostname 127.0.0.1 --port ${PORT}` : `pnpm dev --hostname 127.0.0.1 --port ${PORT}`,
    url: `${BASE_URL}/sign-in`,
    reuseExistingServer: !process.env.CI,
    timeout: PROD ? 300_000 : 180_000,
    env: {
      AI_PROVIDER: "fake",
      AI_MODEL: "recorded",
      NEXT_PUBLIC_SUPABASE_URL: sb.url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: sb.anonKey,
      SITE_URL: BASE_URL,
      // Pinned to the shipping configuration (D41) so E2E does not depend on .env.local. Rendering the
      // button needs no Google credentials; the test intercepts the authorize request.
      NEXT_PUBLIC_AUTH_GOOGLE_ENABLED: "true",
      // Analytics shipped (D46): the notice and /settings need ANALYTICS_ENABLED and a key. The key is
      // a placeholder and the host an unreachable local port, so no event ever reaches PostHog
      // (a failed capture is logged by class name and never affects the request). LE_S1_GATE_ON=0
      // starts the server without them, for tester-settings-s1's gate-off checks.
      ...(process.env.LE_S1_GATE_ON === "0"
        ? {}
        : { ANALYTICS_ENABLED: "true", POSTHOG_KEY: "phc_e2e_placeholder", POSTHOG_HOST: E2E_POSTHOG_HOST }),
    },
  },
});
