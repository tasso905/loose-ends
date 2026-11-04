import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lead-tester (fix/self-host-fonts, tracing fix): lib/ai/provider.ts loads ./fake only when the fake
 * model is first called. With AI_PROVIDER=google the fake module (and its fixture-directory reads)
 * must never load; with AI_PROVIDER=fake replay still works, including multi-response recordings.
 */

const loads = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/ai/fake", async (importOriginal) => {
  loads.n++;
  return await importOriginal();
});

const MIKE = "Thanks Mike — I'll send you the revised proposal Friday. We should grab lunch sometime.";
const input = (sourceText: string) => ({
  sourceText,
  sourceKind: "paste" as const,
  referenceDate: "2026-10-05",
  referenceDateSource: "user" as const,
  timezone: "America/New_York",
  user: { displayName: "Sam", aliases: [] },
});

const geminiOk = (obj: unknown) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

beforeEach(() => {
  loads.n = 0;
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tester: fake provider is loaded lazily", () => {
  it("importing the provider, extract() and askWhy() does not load ./fake", async () => {
    await import("@/lib/ai/provider");
    await import("@/lib/ai/extract");
    await import("@/lib/ai/askWhy");
    await import("@/lib/extraction/service");
    expect(loads.n).toBe(0);
  });

  it("AI_PROVIDER=google: getModel + a full extract() call never load ./fake", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      return geminiOk({ source_summary: "s", participants: [], items: [], brief: null });
    });
    const { getModel } = await import("@/lib/ai/provider");
    const { extract } = await import("@/lib/ai/extract");
    const { model, provider } = getModel({ AI_PROVIDER: "google", AI_MODEL: "gemini-3.5-flash", AI_API_KEY: "tester-not-a-key" });
    expect(provider).toBe("google");
    const run = await extract(input("Synthetic note with no commitments, marker-LZ1."), { model, logger: () => {} });
    expect(run.output.items).toEqual([]);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatch(/generativelanguage\.googleapis\.com/);
    expect(loads.n).toBe(0);
  });

  it("AI_PROVIDER=fake: getModel alone does not load ./fake; the first call does, once, and replays the recording", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("fake provider must not touch the network");
    });
    const { getModel } = await import("@/lib/ai/provider");
    const { extract } = await import("@/lib/ai/extract");
    const { model, provider, label } = getModel({ AI_PROVIDER: "fake", AI_MODEL: "recorded" });
    expect({ provider, label }).toEqual({ provider: "fake", label: "fake:recorded" });
    expect(loads.n).toBe(0);
    const run = await extract(input(MIKE), { model, logger: () => {} });
    expect(run.output.items.map((i) => i.title)).toContain("Send revised proposal to Mike");
    await extract(input(MIKE), { model, logger: () => {} });
    expect(loads.n).toBe(1);
  });

  it("AI_PROVIDER=fake: a missing recording still surfaces as an extraction failure, not a hang or a crash", async () => {
    const { getModel } = await import("@/lib/ai/provider");
    const { extract } = await import("@/lib/ai/extract");
    const { model } = getModel({ AI_PROVIDER: "fake", AI_MODEL: "recorded" });
    const err = await extract(input("Synthetic text with no recording, marker-LZ2."), { model, logger: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("extraction_failed");
  });

  it("AI_PROVIDER=fake: retry-once recording still returns its second response on the retry (per-model state kept)", async () => {
    const rec = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/llm/retry-once.extract.json"), "utf8")) as { input: string };
    const { getModel } = await import("@/lib/ai/provider");
    const { extract } = await import("@/lib/ai/extract");
    const { model } = getModel({ AI_PROVIDER: "fake", AI_MODEL: "recorded" });
    const run = await extract(input(rec.input), { model, logger: () => {} });
    expect(run.attempts).toBe(2);
  });

  it("no product module imports ./fake statically", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    for (const d of ["app", "lib", "components"]) walk(join(process.cwd(), d));
    const offenders = files.filter((f) => /^\s*import\s[^;]*from\s+["'](?:\.\/fake|@\/lib\/ai\/fake|\.\.\/ai\/fake)["']/m.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
