import { describe, expect, it } from "vitest";
import { DEFAULT_NEXT, onboardingPath, safeNext, signInPath } from "@/lib/auth/next";

describe("safeNext: same-site relative paths only (SITE_CONTRACT §1.2, D38)", () => {
  it.each([
    ["/today", "/today"],
    ["/threads?filter=closed", "/threads?filter=closed"],
    ["/threads/3f0c2b6e-0000-4000-8000-000000000000?panel=why", "/threads/3f0c2b6e-0000-4000-8000-000000000000?panel=why"],
    ["/decisions?q=why did I cancel the gym", "/decisions?q=why%20did%20I%20cancel%20the%20gym"],
    ["/decisions?q=why%20insurance", "/decisions?q=why%20insurance"],
    ["/sources/abc?evidence=e1#quote", "/sources/abc?evidence=e1#quote"],
    ["/settings#data", "/settings#data"],
    ["/add?mode=upload", "/add?mode=upload"],
  ])("keeps %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    // protocol-relative and absolute
    "//evil.com",
    "//evil.com/today",
    "///evil.com",
    "https://evil.com",
    "http://127.0.0.1:3000/today",
    "javascript:alert(1)",
    "data:text/html,hi",
    "evil.com",
    "today",
    // backslash variants (browsers treat \ as /)
    "/\\evil.com",
    "\\\\evil.com",
    "/\\/evil.com",
    "\\/evil.com",
    // encoded variants
    "/%2F%2Fevil.com",
    "%2F%2Fevil.com",
    "/%5Cevil.com",
    "/%5C%5Cevil.com",
    "%2F%5Cevil.com",
    "/%252F%252Fevil.com", // double-encoded
    "/%25252F%25252Fevil.com", // triple-encoded
    "https%3A%2F%2Fevil.com",
    // whitespace / control characters that parsers strip
    "/\t/evil.com",
    "/\n/evil.com",
    "/%09/evil.com",
    "/%0d%0a/evil.com",
    " /today",
    "/ /evil.com",
    // empty and absent
    "",
    null,
    undefined,
    // loops back into auth
    "/sign-in",
    "/sign-in?next=/today",
    "/auth/callback?code=x",
    "/onboarding",
    "/",
    // dot segments that normalise into "//host"
    "/.//evil.com",
    "/..//evil.com",
    "/a/..//evil.com",
    "/%2e//evil.com",
  ])("rejects %j", (input) => {
    expect(safeNext(input as string | null | undefined)).toBe(DEFAULT_NEXT);
  });

  it("a stray % is kept as a literal, but an undecodable escape run is rejected (R1)", () => {
    expect(safeNext("/decisions?q=why%2020%25%20raise")).toBe("/decisions?q=why%2020%25%20raise");
    expect(safeNext("/today?q=%")).toBe("/today?q=%");
    expect(safeNext("/%E0%A4%A")).toBe(DEFAULT_NEXT);
    expect(safeNext("/%2F%2Fevil.com%")).toBe(DEFAULT_NEXT);
    expect(safeNext("/sign-in%")).toBe(DEFAULT_NEXT);
    expect(safeNext("/authority")).toBe("/authority");
  });

  it("rejects over-long values", () => {
    expect(safeNext(`/today?x=${"a".repeat(3000)}`)).toBe(DEFAULT_NEXT);
  });

  it("never returns anything that resolves off-site", () => {
    const tricky = ["//evil.com", "/\\evil.com", "/%2F%2Fevil.com", "/.//evil.com", "/..//evil.com", "/./\\evil.com"];
    for (const t of tricky) {
      const out = safeNext(t);
      expect(new URL(out, "https://loose-ends.example").origin).toBe("https://loose-ends.example");
    }
  });
});

describe("signInPath / onboardingPath", () => {
  it("carries a deep link as an encoded next param", () => {
    expect(signInPath("/threads?filter=closed")).toBe("/sign-in?next=%2Fthreads%3Ffilter%3Dclosed");
  });
  it("keeps an explicit /today and drops unsafe values", () => {
    expect(signInPath("/today")).toBe("/sign-in?next=%2Ftoday");
    expect(signInPath("//evil.com")).toBe("/sign-in");
    expect(signInPath(null, { sent: "1" })).toBe("/sign-in?sent=1");
  });
  it("adds extra params before next", () => {
    expect(signInPath("/threads", { error: "link_expired" })).toBe("/sign-in?error=link_expired&next=%2Fthreads");
  });
  it("round-trips through URLSearchParams back to the same path", () => {
    const deep = "/decisions?q=why insurance&x=1";
    const url = new URL(signInPath(deep), "http://h");
    expect(safeNext(url.searchParams.get("next"))).toBe(safeNext(deep));
  });
  it("onboardingPath carries next", () => {
    expect(onboardingPath("/threads")).toBe("/onboarding?next=%2Fthreads");
    expect(onboardingPath(null)).toBe("/onboarding");
  });
});
