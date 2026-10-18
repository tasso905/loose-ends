import { defineConfig } from "@playwright/test";

// E2E runs against recorded LLM fixtures (AI_PROVIDER=fake); never a live model.
export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://127.0.0.1:3000" },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    env: { AI_PROVIDER: "fake", AI_MODEL: "recorded" },
  },
});
