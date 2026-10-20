import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isGoogleSignInEnabled } from "@/lib/supabase/env";

/** D41: Google is on only where explicitly configured; the committed Supabase config keeps it off. */
describe("Google sign-in flag (F1, D41)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is on only for the exact value "true"', () => {
    for (const v of ["", "false", "1", "TRUE", "yes"]) {
      vi.stubEnv("NEXT_PUBLIC_AUTH_GOOGLE_ENABLED", v);
      expect(isGoogleSignInEnabled()).toBe(false);
    }
    vi.stubEnv("NEXT_PUBLIC_AUTH_GOOGLE_ENABLED", "true");
    expect(isGoogleSignInEnabled()).toBe(true);
  });

  it("supabase/config.toml commits the Google provider off, with credentials from env only", () => {
    const toml = readFileSync(resolve(__dirname, "../../supabase/config.toml"), "utf8");
    const section = toml.split(/^\[auth\.external\.google\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
    // Switched on locally via SUPABASE_AUTH_EXTERNAL_GOOGLE_ENABLED in supabase/.env, never here,
    // so CI and contributors without credentials get a stack that does not advertise Google.
    expect(section).toMatch(/^enabled = false$/m);
    expect(section).toMatch(/^client_id = "env\(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID\)"$/m);
    expect(section).toMatch(/^secret = "env\(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET\)"$/m);
  });
});
