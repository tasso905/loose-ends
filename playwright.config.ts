import { defineConfig, devices } from "@playwright/test";
import { localSupabase } from "./tests/e2e/localSupabase";

// E2E runs against local Supabase (Auth + Mailpit) and recorded LLM fixtures (AI_PROVIDER=fake);
// never a live model and never a cloud project.
const sb = localSupabase();
const BASE_URL = "http://127.0.0.1:3000";
const PROD = Boolean(process.env.CI || process.env.E2E_PROD);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // CI (or E2E_PROD=1) tests the production build; locally `next dev` keeps the loop fast.
    command: PROD ? "pnpm build && pnpm start --hostname 127.0.0.1 --port 3000" : "pnpm dev --hostname 127.0.0.1 --port 3000",
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
    },
  },
});
