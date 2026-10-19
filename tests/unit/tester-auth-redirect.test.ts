/**
 * Lead-tester: adversarial checks on the `next` guard and every redirect builder used by the proxy,
 * /auth/callback, the sign-in action and onboarding (SITE_CONTRACT §1.2 "Signed-out access", D38).
 *
 * Property under test: whatever an attacker puts in `next`, every Location the app emits resolves to
 * the app's own origin, and never back into /sign-in, /auth or /onboarding.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_NEXT, onboardingPath, safeNext, signInPath } from "@/lib/auth/next";
import { decideRoute, postSignInDestination } from "@/lib/auth/routing";
import { callbackUrl, sameHostUrl, siteOrigin } from "@/lib/auth/signIn";

const APP = "https://app.loose-ends.test";
const NON_IDEMPOTENT = "/./%2F/evil.com";

const ATTACKS: string[] = [
  "//evil.com",
  "///evil.com",
  "////evil.com",
  "/\\evil.com",
  "/\\/evil.com",
  "\\/\\/evil.com",
  "/%2F%2Fevil.com",
  "/%2f%2fevil.com",
  "%2F%2Fevil.com",
  "/%252F%252Fevil.com",
  "/%25252F%25252Fevil.com",
  "/%2525252F%2525252Fevil.com", // quadruple: beyond the guard's three decode layers
  "/%5C%5Cevil.com",
  "/%255C%255Cevil.com",
  "/.//evil.com",
  "/./\\evil.com",
  "/a/..//evil.com",
  "/a/../..//evil.com",
  "/%2e%2e//evil.com",
  "/%2e//evil.com",
  "/./%2F/evil.com",
  "/\t/evil.com",
  "/\n/evil.com",
  "/\r\n/evil.com",
  "\t//evil.com",
  "/%09/evil.com",
  "/%0a/evil.com",
  "/%00/evil.com",
  "/\u0000/evil.com",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "/javascript:alert(1)//",
  "java\tscript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "https://evil.com",
  "https:evil.com",
  "http:/evil.com",
  "//evil.com@app.loose-ends.test",
  "/@evil.com",
  "//@evil.com",
  "/today@evil.com",
  "https://app.loose-ends.test@evil.com",
  "/／evil.com", // FULLWIDTH SOLIDUS after a real slash
  "／／evil.com",
  "/∕evil.com", // DIVISION SLASH
  "∕∕evil.com",
  "/　/evil.com", // ideographic space
  "/ /evil.com",
  "/ /evil.com",
  "/%E3%80%80/evil.com",
  `/${"a".repeat(5000)}`,
  `//evil.com/${"a".repeat(3000)}`,
];

/** Where a browser actually lands for a Location value served from APP. */
const land = (location: string) => new URL(location, `${APP}/sign-in?x=1`);

describe("safeNext under attack (tester)", () => {
  it.each(ATTACKS)("never leaves the origin: %j", (attack) => {
    const out = safeNext(attack);
    expect(out.startsWith("/")).toBe(true);
    expect(out.startsWith("//")).toBe(false);
    expect(out).not.toMatch(/\\/);
    expect(land(out).origin).toBe(APP);
  });

  it.each(ATTACKS)("signInPath and onboardingPath stay on-site and drop unsafe next: %j", (attack) => {
    for (const p of [signInPath(attack), signInPath(attack, { error: "link_expired" }), onboardingPath(attack)]) {
      expect(land(p).origin).toBe(APP);
      const carried = land(p).searchParams.get("next");
      if (carried !== null) expect(land(carried).origin).toBe(APP);
    }
  });

  it.each(ATTACKS)("callback destination stays on-site for first and returning users: %j", (attack) => {
    for (const onboarded of [true, false]) {
      const p = postSignInDestination({ onboarded, next: attack });
      expect(land(p).origin).toBe(APP);
    }
  });

  it.each(ATTACKS)("proxy: signed-in /sign-in?next=<attack> redirects on-site: %j", (attack) => {
    const d = decideRoute({ pathname: "/sign-in", search: `?${new URLSearchParams({ next: attack })}`, signedIn: true });
    expect(d.kind).toBe("redirect");
    if (d.kind === "redirect") expect(land(d.to).origin).toBe(APP);
  });

  it.each(ATTACKS)("magic-link callback URL keeps SITE_URL's origin: %j", (attack) => {
    const u = new URL(callbackUrl(APP, safeNext(attack)));
    expect(u.origin).toBe(APP);
    expect(u.pathname).toBe("/auth/callback");
    const n = u.searchParams.get("next");
    if (n !== null) expect(land(n).origin).toBe(APP);
  });

  it("idempotent: re-guarding the output never changes it (no decode-then-redirect chains)", () => {
    for (const a of [...ATTACKS.filter((x) => x !== NON_IDEMPOTENT), "/today", "/threads?filter=closed", "/decisions?q=why%20insurance"]) {
      const once = safeNext(a);
      expect(safeNext(once)).toBe(once);
      // The sign-in page reads `next` back through URLSearchParams; the round trip must be stable.
      const carried = new URL(signInPath(once), APP).searchParams.get("next") ?? DEFAULT_NEXT;
      expect(safeNext(carried)).toBe(once);
    }
  });

  // Defect (low): the guard checks decoded layers of the raw value but not of its normalised output.
  // "/./%2F/evil.com" passes and comes out as "/%2F/evil.com", which the guard itself rejects. Not
  // exploitable today (every consumer resolves it on-origin and the sign-in page re-guards it), but
  // any future hop that decodes the path once would see "///evil.com".
  it("the normalised output also passes the guard (dot segment + encoded slash)", () => {
    const once = safeNext(NON_IDEMPOTENT);
    expect(safeNext(once)).toBe(once);
  });

  it("over-long next falls back to /today", () => {
    expect(safeNext(`/threads?q=${"a".repeat(2100)}`)).toBe(DEFAULT_NEXT);
  });

  it("never returns into auth routes, including through dot segments and encoding", () => {
    for (const a of ["/sign-in", "/./sign-in", "/a/../sign-in", "/%73ign-in", "/auth/callback", "/x/../auth/callback?code=1", "/onboarding?next=/today", "/%6Fnboarding"]) {
      const out = new URL(safeNext(a), APP).pathname;
      expect(["/sign-in", "/auth/callback", "/onboarding"]).not.toContain(out);
    }
  });

  // Defect (low): a legitimate deep link whose query holds a literal "%" (for example Ask why with
  // "?q=why 20% raise") is rejected, because the guard decodes it again and the second decode throws.
  // The user lands on /today instead of the decision they asked about.
  it("keeps a legitimate query that contains an encoded percent sign", () => {
    expect(safeNext("/decisions?q=why%2020%25%20raise")).toBe("/decisions?q=why%2020%25%20raise");
  });
});

describe("malformed-escape handling (tester, re-verification)", () => {
  // Defect (low-medium, regression from the D7 fix): decodeLayers() now stops at the first malformed
  // escape instead of rejecting, so one stray "%" anywhere (even in the query) switches off every
  // decoded-layer check. Encoded "//", "\\", control characters and auth routes then pass unchanged.
  // Not exploitable through today's sinks (browsers keep %2F encoded in a path on our origin), but it
  // breaks the guard's stated invariant for any later hop that decodes leniently. Suggested fix: on a
  // malformed escape, escape the stray "%" (replace(/%(?![0-9a-f]{2})/gi, "%25")) and keep decoding.
  const SMUGGLED = [
    "/%2F%2Fevil.com%",
    "/%2F%2Fevil.com/%zz",
    "/%2F/evil.com?x=%",
    "/%5C%5Cevil.com%",
    "/%09/evil%",
    "/x%E0%A4%A/%2F%2Fevil",
  ];
  it.each(SMUGGLED)("a stray %% does not let an encoded off-site path through: %j", (v) => {
    expect(safeNext(v)).toBe(DEFAULT_NEXT);
  });

  it("a stray %% does not let an encoded auth route through", () => {
    expect(safeNext("/%73ign-in%")).toBe(DEFAULT_NEXT);
  });

  it("legitimate literal percent signs in a query are kept (D7)", () => {
    expect(safeNext("/decisions?q=why%2020%25%20raise")).toBe("/decisions?q=why%2020%25%20raise");
    expect(safeNext("/today?q=%")).toBe("/today?q=%");
  });
});

describe("Host-header spoofing (tester)", () => {
  it("magic-link origin: SITE_URL wins over Host and X-Forwarded-Host", () => {
    expect(siteOrigin(APP, "evil.com", "https")).toBe(APP);
    expect(siteOrigin(`${APP}/`, "evil.com", "http")).toBe(APP);
  });

  it("without SITE_URL the magic-link origin follows the (spoofable) Host header", () => {
    // Documents current behaviour: production MUST set SITE_URL, and Supabase's redirect allow-list
    // is the second line of defence. See the report.
    expect(siteOrigin(undefined, "evil.com", "https")).toBe("https://evil.com");
  });

  // Defect (low-medium, hardening): proxy and /auth/callback redirects are built from
  // X-Forwarded-Host / Host even when SITE_URL is configured, so a forged header yields an
  // absolute Location on another origin. Redirects should use SITE_URL when set (or be relative).
  it("same-site redirects ignore a forged X-Forwarded-Host", () => {
    const u = sameHostUrl("/today", `${APP}/auth/callback?code=x`, "evil.com", "https");
    expect(u.origin).toBe(APP);
  });
});

describe("rule 9: callback log reasons are enums only (tester, D3)", () => {
  it("free text from the query never reaches the log", async () => {
    const { callbackLogReason } = await import("@/lib/auth/routing");
    for (const v of ["jane.doe@example.com", "otp_expired jane@example.com", "<script>", "a".repeat(40), "", null, undefined]) {
      expect(callbackLogReason(v)).toBe("other");
    }
    expect(callbackLogReason("otp_expired")).toBe("otp_expired");
    expect(callbackLogReason("pkce_code_verifier_not_found")).toBe("pkce_code_verifier_not_found");
  });
});
