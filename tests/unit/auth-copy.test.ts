import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAGIC_LINK_LIFETIME_SECONDS, ONBOARDING_COPY, SIGN_IN_COPY, signInErrorMessage } from "@/lib/auth/copy";

/** Reads `otp_expiry` from the [auth.email] table of supabase/config.toml. */
function configuredOtpExpirySeconds(): number {
  const toml = readFileSync(resolve(__dirname, "../../supabase/config.toml"), "utf8");
  const section = toml.split(/^\[auth\.email\]\s*$/m)[1]?.split(/^\[/m)[0];
  const match = section?.match(/^otp_expiry\s*=\s*(\d+)\s*$/m);
  if (!match) throw new Error("otp_expiry not found under [auth.email] in supabase/config.toml");
  return Number(match[1]);
}

describe("sign-in copy stays true (PRD F1)", () => {
  it("magic-link lifetime constant matches supabase/config.toml otp_expiry", () => {
    expect(MAGIC_LINK_LIFETIME_SECONDS).toBe(configuredOtpExpirySeconds());
  });

  it("the stated lifetime in hours matches otp_expiry", () => {
    const match = SIGN_IN_COPY.linkLifetime.match(/^The link works for (\d+) hours?\.$/);
    expect(match).not.toBeNull();
    expect(Number(match![1]) * 3600).toBe(configuredOtpExpirySeconds());
  });

  it("uses the approved wording", () => {
    expect(SIGN_IN_COPY.linkLifetime).toBe("The link works for 1 hour.");
    expect(signInErrorMessage("link_other_browser")).toBe(
      "That link was opened in a different browser. Enter your email to get a new one, and open it in this browser.",
    );
    expect(ONBOARDING_COPY.hint).toBe("Separate them with commas. I use these to tell which tasks are yours.");
  });
});
