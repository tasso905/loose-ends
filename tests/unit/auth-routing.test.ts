import { describe, expect, it } from "vitest";
import { callbackErrorNotice, callbackLogReason, decideRoute, isPublicPath, postSignInDestination } from "@/lib/auth/routing";

const go = (pathname: string, signedIn: boolean, search = "") => decideRoute({ pathname, search, signedIn });

describe("decideRoute (SITE_CONTRACT §1.2 route map, D38)", () => {
  it("/ signed out → /sign-in with no next", () => {
    expect(go("/", false)).toEqual({ kind: "redirect", to: "/sign-in" });
    expect(go("/", false, "?next=/threads")).toEqual({ kind: "redirect", to: "/sign-in" });
  });
  it("/ signed in → /today", () => {
    expect(go("/", true)).toEqual({ kind: "redirect", to: "/today" });
  });

  it.each(["/today", "/add", "/threads", "/threads/abc", "/sources/x", "/decisions", "/settings", "/review/123"])(
    "signed-out %s → /sign-in?next=path",
    (p) => {
      expect(go(p, false)).toEqual({ kind: "redirect", to: `/sign-in?next=${encodeURIComponent(p)}` });
    },
  );

  it("keeps the query string in next", () => {
    expect(go("/threads", false, "?filter=closed")).toEqual({
      kind: "redirect",
      to: "/sign-in?next=%2Fthreads%3Ffilter%3Dclosed",
    });
    expect(go("/decisions", false, "?q=why%20insurance")).toEqual({
      kind: "redirect",
      to: `/sign-in?next=${encodeURIComponent("/decisions?q=why%20insurance")}`,
    });
  });

  it("signed-out /onboarding → /sign-in without next (the callback routes first sign-ins there)", () => {
    expect(go("/onboarding", false)).toEqual({ kind: "redirect", to: "/sign-in" });
  });

  it("signed-in users pass through Signed in routes", () => {
    for (const p of ["/today", "/threads", "/onboarding", "/settings"]) expect(go(p, true)).toEqual({ kind: "continue" });
  });

  it("public routes are open while signed out", () => {
    expect(go("/sign-in", false)).toEqual({ kind: "continue" });
    expect(go("/sign-in", false, "?sent=1")).toEqual({ kind: "continue" });
    expect(go("/auth/callback", false, "?code=x")).toEqual({ kind: "continue" });
  });

  it("/auth/callback is not redirected even when signed in (it finishes the handoff)", () => {
    expect(go("/auth/callback", true, "?code=x")).toEqual({ kind: "continue" });
  });

  it("signed-in /sign-in goes to a safe next or /today", () => {
    expect(go("/sign-in", true)).toEqual({ kind: "redirect", to: "/today" });
    expect(go("/sign-in", true, "?next=%2Fthreads")).toEqual({ kind: "redirect", to: "/threads" });
    expect(go("/sign-in", true, "?next=%2F%2Fevil.com")).toEqual({ kind: "redirect", to: "/today" });
  });

  it("API routes are never redirected (they return the JSON error envelope)", () => {
    expect(go("/api/threads", false)).toEqual({ kind: "continue" });
  });

  it("prefix matching is by segment, not by string prefix", () => {
    expect(isPublicPath("/sign-in")).toBe(true);
    expect(isPublicPath("/sign-inx")).toBe(false);
    expect(isPublicPath("/authority")).toBe(false);
    expect(go("/authority", false).kind).toBe("redirect");
  });
});

describe("postSignInDestination (auth callback)", () => {
  it("first sign-in → onboarding, carrying next", () => {
    expect(postSignInDestination({ onboarded: false, next: null })).toBe("/onboarding");
    expect(postSignInDestination({ onboarded: false, next: "/threads?filter=closed" })).toBe(
      "/onboarding?next=%2Fthreads%3Ffilter%3Dclosed",
    );
  });
  it("returning user → next or /today", () => {
    expect(postSignInDestination({ onboarded: true, next: "/decisions?q=x" })).toBe("/decisions?q=x");
    expect(postSignInDestination({ onboarded: true, next: null })).toBe("/today");
  });
  it("unsafe next → /today (and onboarding without next)", () => {
    expect(postSignInDestination({ onboarded: true, next: "//evil.com" })).toBe("/today");
    expect(postSignInDestination({ onboarded: false, next: "https://evil.com" })).toBe("/onboarding");
  });
});

describe("callbackErrorNotice", () => {
  it("email-link failures say the link expired", () => {
    expect(callbackErrorNotice("otp_expired", "access_denied")).toBe("link_expired");
    expect(callbackErrorNotice("flow_state_not_found", null)).toBe("link_expired");
    expect(callbackErrorNotice("bad_code_verifier", null)).toBe("link_expired");
  });
  it("other provider errors are an OAuth failure", () => {
    expect(callbackErrorNotice(null, "access_denied")).toBe("oauth_failed");
    expect(callbackErrorNotice("provider_email_needs_verification", null)).toBe("oauth_failed");
  });
});

describe("callbackLogReason (rule 9: enums only)", () => {
  it("passes known codes and maps everything else to other", () => {
    expect(callbackLogReason("otp_expired")).toBe("otp_expired");
    expect(callbackLogReason("pkce_code_verifier_not_found")).toBe("pkce_code_verifier_not_found");
    expect(callbackLogReason("sam@example.com")).toBe("other");
    expect(callbackLogReason("<script>")).toBe("other");
    expect(callbackLogReason(null)).toBe("other");
  });
});
