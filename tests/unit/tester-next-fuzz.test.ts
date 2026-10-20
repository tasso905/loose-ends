/**
 * Lead-tester: seeded fuzz of the `next` guard with stray-% mutations (R1 re-verification).
 * Property: whatever safeNext returns stays on-origin, is idempotent, and even a LENIENT decoder
 * (decodes every valid %XX, leaves junk alone, as permissive proxies do) applied up to 4 times
 * never turns it into a protocol-relative, backslash, control-character or auth-route path.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_NEXT, safeNext } from "@/lib/auth/next";

const TOKENS = [
  "/", "//", "%2F", "%2f", "%252F", "%25252F", "%5C", "%5c", "%255C", "\\", "%", "%%", "%2", "%z", "%zz", "%G1",
  "%E0%A4%A", "%C0%AF", "%E2%88%95", "%EF%BC%8F", "evil.com", "@", ":", ".", "..", "%2e", "%2E%2E", "%09", "%0a", "%00",
  "sign-in", "%73ign-in", "auth", "onboarding", "today", "?", "?q=", "#", "&", "x", "%25", "%2525", "%3F", "%23",
];

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function lenientDecode(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; ) {
    const m = /^%([0-9a-f]{2})/i.exec(s.slice(i));
    if (m) { bytes.push(parseInt(m[1]!, 16)); i += 3; continue; }
    for (const b of new TextEncoder().encode(s[i]!)) bytes.push(b);
    i += 1;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

const AUTH = /^\/(sign-in|auth|onboarding)(?![a-z0-9_])/i;
const APP = "https://app.loose-ends.test";

describe("safeNext fuzz: stray-% mutations (tester)", () => {
  const next = rng(20261019);
  const cases: string[] = [];
  for (let n = 0; n < 20000; n++) {
    let s = next() < 0.85 ? "/" : "";
    const len = 1 + Math.floor(next() * 8);
    for (let k = 0; k < len; k++) s += TOKENS[Math.floor(next() * TOKENS.length)];
    cases.push(s);
  }

  it("20,000 mutations: on-origin, idempotent, and safe under a lenient decoder", () => {
    const bad: string[] = [];
    let kept = 0;
    for (const c of cases) {
      const out = safeNext(c);
      if (out !== DEFAULT_NEXT) kept++;
      const problems: string[] = [];
      if (new URL(out, APP).origin !== APP) problems.push("origin");
      if (safeNext(out) !== out) problems.push("idempotent");
      let layer = out;
      for (let i = 0; i < 4; i++) {
        const path = layer.split(/[?#]/, 1)[0]!;
        if (path.startsWith("//") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path) || AUTH.test(path)) {
          problems.push(`layer${i}:${JSON.stringify(layer)}`);
          break;
        }
        if (new URL(layer, APP).origin !== APP) { problems.push(`layer${i}-origin`); break; }
        const d = lenientDecode(layer);
        if (d === layer) break;
        layer = d;
      }
      if (problems.length) bad.push(`${JSON.stringify(c)} -> ${JSON.stringify(out)} ${problems.join(",")}`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
    expect(kept).toBeGreaterThan(100); // the guard is not just rejecting everything
  });

  it("D7 cases still hold", () => {
    expect(safeNext("/decisions?q=why%2020%25%20raise")).toBe("/decisions?q=why%2020%25%20raise");
    expect(safeNext("/today?q=%")).toBe("/today?q=%");
    expect(safeNext("/decisions?q=50% off")).toBe("/decisions?q=50%%20off");
    expect(safeNext("/threads?filter=closed")).toBe("/threads?filter=closed");
    expect(safeNext("/authority")).toBe("/authority");
  });
});
