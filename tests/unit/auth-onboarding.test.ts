import { describe, expect, it } from "vitest";
import { signInErrorMessage } from "@/lib/auth/copy";
import { buildProfilePatch, displayNameFrom, isValidTimeZone, mergeAliases, OnboardingInput, splitAliases } from "@/lib/auth/onboarding";
import { callbackUrl, classifyOtpError, configuredSiteUrl, sameHostUrl, SignInInput, siteOrigin } from "@/lib/auth/signIn";
import { isAnalyticsEnabled } from "@/lib/supabase/env";

const NOW = "2026-10-19T12:00:00.000Z";

describe("onboarding aliases (PRD F1)", () => {
  it("splits on commas, semicolons and newlines and trims", () => {
    expect(splitAliases(" Sam , Sam Lee;\nsam@work.example ,, ")).toEqual(["Sam", "Sam Lee", "sam@work.example"]);
  });

  it("always keeps the signed-in email first, dedupes case-insensitively, keeps user spelling", () => {
    expect(mergeAliases("sam@example.com", ["sam@example.com"], ["Sam", "SAM@example.com", "sam"])).toEqual([
      "sam@example.com",
      "Sam",
    ]);
  });

  it("restores the signed-in email if it is missing", () => {
    expect(mergeAliases("sam@example.com", [], [])).toEqual(["sam@example.com"]);
  });

  it("display name is the first entry that is not an email", () => {
    expect(displayNameFrom(["sam@work.example", "Sam Lee", "Sammy"])).toBe("Sam Lee");
    expect(displayNameFrom(["sam@work.example"])).toBeNull();
  });

  it("save builds aliases, display name, timezone and onboarded_at", () => {
    const input = OnboardingInput.parse({ intent: "save", answer: "Sam Lee, sam@work.example", timezone: "America/New_York" });
    expect(buildProfilePatch(input, { email: "sam@example.com", existingAliases: ["sam@example.com"], nowIso: NOW })).toEqual({
      aliases: ["sam@example.com", "Sam Lee", "sam@work.example"],
      display_name: "Sam Lee",
      timezone: "America/New_York",
      onboarded_at: NOW,
    });
  });

  it("skip keeps the email alias, stores timezone and marks onboarding done without a display name", () => {
    const input = OnboardingInput.parse({ intent: "skip", timezone: "Europe/London" });
    expect(buildProfilePatch(input, { email: "sam@example.com", existingAliases: [], nowIso: NOW })).toEqual({
      aliases: ["sam@example.com"],
      timezone: "Europe/London",
      onboarded_at: NOW,
    });
  });

  it("ignores an invalid timezone instead of failing", () => {
    const input = OnboardingInput.parse({ intent: "skip", timezone: "Mars/Olympus" });
    expect(buildProfilePatch(input, { email: null, existingAliases: [], nowIso: NOW }).timezone).toBeUndefined();
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("rejects more than 20 aliases and over-long entries", () => {
    const many = Array.from({ length: 21 }, (_, i) => `Name ${i}`).join(",");
    const r1 = OnboardingInput.safeParse({ intent: "save", answer: many });
    expect(r1.success).toBe(false);
    expect(r1.error?.issues[0]?.message).toBe("too_many");
    const r2 = OnboardingInput.safeParse({ intent: "save", answer: "x".repeat(101) });
    expect(r2.error?.issues[0]?.message).toBe("too_long");
  });

  it("rejects an unknown intent", () => {
    expect(OnboardingInput.safeParse({ intent: "delete" }).success).toBe(false);
  });
});

describe("sign-in request", () => {
  it("validates one email address", () => {
    expect(SignInInput.safeParse({ email: " sam@example.com " }).data?.email).toBe("sam@example.com");
    expect(SignInInput.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(SignInInput.safeParse({ email: "" }).success).toBe(false);
  });

  it("maps Supabase errors", () => {
    expect(classifyOtpError({ status: 429, code: "over_email_send_rate_limit" })).toBe("sign_in_rate_limited");
    expect(classifyOtpError({ code: "over_request_rate_limit" })).toBe("sign_in_rate_limited");
    expect(classifyOtpError({ status: 400, code: "email_address_invalid" })).toBe("invalid_email");
    expect(classifyOtpError({ status: 500, code: "unexpected_failure" })).toBe("send_failed");
  });

  it("SITE_URL wins over the Host header for email links", () => {
    expect(siteOrigin("https://looseends.example/", "evil.com", "https")).toBe("https://looseends.example");
    expect(siteOrigin(undefined, "127.0.0.1:3000", null)).toBe("http://127.0.0.1:3000");
  });

  it("carries next through the magic link, omitting the default", () => {
    expect(callbackUrl("http://127.0.0.1:3000", "/threads?filter=closed")).toBe(
      "http://127.0.0.1:3000/auth/callback?next=%2Fthreads%3Ffilter%3Dclosed",
    );
    expect(callbackUrl("http://127.0.0.1:3000", "/today")).toBe("http://127.0.0.1:3000/auth/callback");
  });

  it("only known error codes produce a notice", () => {
    expect(signInErrorMessage("link_expired")).toMatch(/expired/);
    expect(signInErrorMessage("<script>")).toBeNull();
    expect(signInErrorMessage("toString")).toBeNull();
    expect(signInErrorMessage(null)).toBeNull();
  });
});

describe("sameHostUrl", () => {
  it("ignores Host and X-Forwarded-Host (D4)", () => {
    expect(sameHostUrl("/today", "http://127.0.0.1:3000/auth/callback", "evil.com", "https").href).toBe("http://127.0.0.1:3000/today");
  });
});

describe("configuredSiteUrl (D4, D5)", () => {
  it("uses SITE_URL's origin when set", () => {
    expect(configuredSiteUrl({ SITE_URL: "https://app.example/x/", NODE_ENV: "production" })).toBe("https://app.example");
  });
  it("is undefined outside production when unset", () => {
    expect(configuredSiteUrl({ NODE_ENV: "development" })).toBeUndefined();
  });
  it("fails closed in production when unset", () => {
    expect(() => configuredSiteUrl({ NODE_ENV: "production" })).toThrow(/SITE_URL/);
    expect(() => configuredSiteUrl({ SITE_URL: " ", NODE_ENV: "production" })).toThrow(/SITE_URL/);
  });
});

describe("isAnalyticsEnabled", () => {
  it("stays off while the Settings toggle has not shipped, even with a key and the flag", () => {
    expect(isAnalyticsEnabled({ POSTHOG_KEY: "phc_x", ANALYTICS_ENABLED: "true" })).toBe(false);
    expect(isAnalyticsEnabled({ POSTHOG_KEY: "phc_x" })).toBe(false);
  });
});
