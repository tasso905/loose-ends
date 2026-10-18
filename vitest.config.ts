import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    // Integration tests boot an in-process Postgres (PGlite) per test; allow for a loaded machine.
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
