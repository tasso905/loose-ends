import { afterEach, describe, expect, it } from "vitest";
import { apiError, errorResponse, EXTRACTION_SLOW_MESSAGE } from "@/lib/errors";
import { getNow, isSimulatedClock, setNowForTests } from "@/lib/time";

describe("error envelope (SITE_CONTRACT §2.13)", () => {
  it("uses the contract copy and retry flags", () => {
    expect(apiError("input_too_long", { n: 31245 })).toEqual({
      error: {
        code: "input_too_long",
        message: "That's 31,245 characters. The limit is 30,000 — trim it or split it into two pastes.",
        retryable: false,
      },
    });
    expect(apiError("unsupported_type").error.message).toBe("Loose Ends can read PDF, TXT, MD and DOCX files.");
    expect(apiError("file_too_large", { sizeMb: 12.34 }).error.message).toBe("This file is 12.3 MB. The limit is 10 MB.");
    expect(apiError("too_many_pages", { n: 42 }).error.message).toBe("This document has 42 pages. The limit is 30.");
    expect(apiError("unsupported_scan").error.message).toBe("This looks like a scan. I can't read scans yet.");
    expect(apiError("extraction_failed").error).toEqual({
      code: "extraction_failed",
      message: "Something went wrong reading this. Your text is saved.",
      retryable: true,
    });
    expect(apiError("rate_limited", { limit: 30, kind: "sources", timezone: "America/New_York" }).error.message).toBe(
      "You've reached today's limit of 30 sources. It resets at midnight (America/New_York).",
    );
    expect(apiError("invalid_transition").error.message).toBe("That change isn't possible any more. Refresh to see the latest.");
    expect(apiError("offline").error).toMatchObject({ message: "You're offline. Nothing was saved.", retryable: true });
    expect(apiError("save_failed").error).toMatchObject({ message: "That didn't save. Try again.", retryable: true });
    expect(EXTRACTION_SLOW_MESSAGE).toBe("Still working — we'll show results here.");
  });

  it("errorResponse sets an HTTP status and JSON body", async () => {
    const res = errorResponse("invalid_transition");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(apiError("invalid_transition"));
  });
});

describe("getNow()", () => {
  const prevDemo = process.env.DEMO_MODE;
  afterEach(() => {
    setNowForTests(null);
    process.env.DEMO_MODE = prevDemo;
  });

  it("test override wins", () => {
    setNowForTests("2026-10-05T12:00:00Z");
    expect(getNow().toISOString()).toBe("2026-10-05T12:00:00.000Z");
  });

  it("demo date is honored only when DEMO_MODE=true", () => {
    process.env.DEMO_MODE = "false";
    const real = getNow({ demoNow: "2026-10-08T12:00:00Z" });
    expect(real.toISOString()).not.toBe("2026-10-08T12:00:00.000Z");
    expect(isSimulatedClock({ demoNow: "2026-10-08T12:00:00Z" })).toBe(false);

    process.env.DEMO_MODE = "true";
    expect(getNow({ demoNow: "2026-10-08T12:00:00Z" }).toISOString()).toBe("2026-10-08T12:00:00.000Z");
    expect(isSimulatedClock({ demoNow: "2026-10-08T12:00:00Z" })).toBe(true);
  });

  it("returns a copy, so callers cannot move the frozen clock", () => {
    setNowForTests("2026-10-05T12:00:00Z");
    getNow().setFullYear(1999);
    expect(getNow().getUTCFullYear()).toBe(2026);
  });
});
