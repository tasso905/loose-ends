/**
 * Lead-tester: independent checks on S1 analytics plumbing (D40, rule 9, rule 10).
 *
 * Uses the REAL posthog-node 5.55.0 client with a stubbed global fetch (no network), so the gate
 * checks count actual outgoing requests, and the payload checks read the exact gzip body the SDK
 * would send to PostHog. Synthetic data only.
 */
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const settingsRow = vi.hoisted(() => ({
  value: { data: { analytics_enabled: true } as unknown, error: null as unknown },
  calls: 0,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            settingsRow.calls++;
            return settingsRow.value;
          },
        }),
      }),
    }),
  }),
}));

const { validateEvent } = await import("@/lib/analytics/events");
const { createTracker, track } = await import("@/lib/analytics/track");

const UID = "00000000-0000-4000-8000-0000000000c1";
const TID = "20000000-0000-4000-8000-0000000000c1";
/** Content that must never leave the server. Fragments are checked separately. */
const SECRET = "Pay Dana $1,470 for the roof by Friday";
const FRAGMENTS = ["Dana", "1,470", "1470", "roof", "Friday"];
/** A content-bearing string that is also a valid identifier (passes naive key regexes). */
const SECRET_KEY = "Pay_Dana_1470_for_the_roof_by_Friday";

interface Sent {
  url: string;
  body: { api_key: string; batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[] };
}
let sent: Sent[] = [];
let fetchImpl: (url: string, init: RequestInit) => Promise<Response>;

async function decode(url: string, init: RequestInit): Promise<Sent> {
  const buf = Buffer.from(await new Response(init.body).arrayBuffer());
  const gz = new Headers(init.headers as HeadersInit).get("content-encoding") === "gzip";
  return { url, body: JSON.parse((gz ? gunzipSync(buf) : buf).toString()) };
}

let keySeq = 0;
/** posthog-node clients are cached per key; a fresh key per tracker keeps tests independent. */
const freshKey = () => `phc_tester_${++keySeq}_${Math.random().toString(36).slice(2, 8)}`;

beforeEach(() => {
  sent = [];
  settingsRow.value = { data: { analytics_enabled: true }, error: null };
  settingsRow.calls = 0;
  fetchImpl = async (url, init) => {
    sent.push(await decode(url, init));
    return new Response("{}", { status: 200 });
  };
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => fetchImpl(url, init));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function tracker(over: Parameters<typeof createTracker>[0] = {}) {
  const logs: { event: string; props: Record<string, unknown> }[] = [];
  const t = createTracker({
    env: { POSTHOG_KEY: freshKey(), ANALYTICS_ENABLED: "true" },
    shipped: true,
    isOptedIn: async () => true,
    schedule: () => {},
    log: (event, props) => void logs.push({ event, props }),
    ...over,
  });
  return { t, logs };
}

const leaks = (v: unknown) => {
  const s = JSON.stringify(v) ?? "";
  return [SECRET, SECRET_KEY, ...FRAGMENTS].filter((f) => s.includes(f));
};

// ---------------------------------------------------------------------------------------------
describe("rule 9: content cannot reach a PostHog request", () => {
  const VALID_UNDO = { action: "done" };

  /** Every attempt must be either rejected, or sent with no content anywhere in the real request body. */
  const attempts: [string, string, () => unknown][] = [
    ["extra prop", "undo_used", () => ({ ...VALID_UNDO, title: SECRET })],
    ["$set person props", "undo_used", () => ({ ...VALID_UNDO, $set: { name: SECRET } })],
    ["$set_once", "undo_used", () => ({ ...VALID_UNDO, $set_once: { email: "dana@example.com" } })],
    ["$ip", "undo_used", () => ({ ...VALID_UNDO, $ip: "203.0.113.7" })],
    ["$current_url", "undo_used", () => ({ ...VALID_UNDO, $current_url: `https://x/?q=${SECRET}` })],
    ["$process_person_profile override", "undo_used", () => ({ ...VALID_UNDO, $process_person_profile: true })],
    ["$geoip_disable override", "undo_used", () => ({ ...VALID_UNDO, $geoip_disable: false })],
    ["$groups", "undo_used", () => ({ ...VALID_UNDO, $groups: { company: SECRET } })],
    ["distinct_id prop", "undo_used", () => ({ ...VALID_UNDO, distinct_id: SECRET })],
    ["JSON __proto__ own key", "undo_used", () => JSON.parse(`{"action":"done","__proto__":{"title":"${SECRET}"}}`)],
    ["inherited prop via prototype", "undo_used", () => Object.assign(Object.create({ title: SECRET, $set: { n: SECRET } }), VALID_UNDO)],
    ["toJSON on input", "undo_used", () => ({ ...VALID_UNDO, toJSON: () => ({ title: SECRET }) })],
    [
      "non-enumerable toJSON on input",
      "undo_used",
      () => Object.defineProperty({ ...VALID_UNDO }, "toJSON", { value: () => ({ title: SECRET }), enumerable: false }),
    ],
    [
      "getter that changes after validation",
      "undo_used",
      () => {
        let n = 0;
        return {
          get action() {
            return n++ === 0 ? "done" : SECRET;
          },
        };
      },
    ],
    [
      "proxy hiding keys from ownKeys",
      "undo_used",
      () =>
        new Proxy({ action: "done", title: SECRET } as Record<string, unknown>, {
          ownKeys: () => ["action"],
          getOwnPropertyDescriptor: (t, k) => (k === "action" ? Reflect.getOwnPropertyDescriptor(t, k) : undefined),
        }),
    ],
    ["symbol key", "undo_used", () => ({ ...VALID_UNDO, [Symbol(SECRET)]: SECRET })],
    ["String object enum", "undo_used", () => ({ action: new String("done") })],
    ["enum padded very long", "undo_used", () => ({ action: "done" + " ".repeat(100_000) + SECRET })],
    ["enum with suffix", "undo_used", () => ({ action: `done ${SECRET}` })],
    ["count map: content key", "proposals_shown", () => ({ extraction_id: TID, band_counts: { [SECRET_KEY]: 1 } })],
    ["count map: __proto__ key", "proposals_shown", () => ({ extraction_id: TID, band_counts: JSON.parse(`{"__proto__":{"x":"${SECRET}"}}`) })],
    ["count map: nested object", "proposals_shown", () => ({ extraction_id: TID, band_counts: { high: { text: SECRET } } })],
    ["count map: array", "proposals_shown", () => ({ extraction_id: TID, band_counts: [SECRET] })],
    ["count map: inherited key", "proposals_shown", () => ({ extraction_id: TID, band_counts: Object.assign(Object.create({ [SECRET_KEY]: 1 }), { high: 1 }) })],
    ["array: content element", "proposal_reviewed", () => ({ item_id: TID, band: "high", action: "edited", fields_edited: ["title", SECRET] })],
    [
      "array: own extra prop",
      "proposal_reviewed",
      () => ({ item_id: TID, band: "high", action: "edited", fields_edited: Object.assign(["title"], { note: SECRET }) }),
    ],
    [
      "array: toJSON",
      "proposal_reviewed",
      () => ({ item_id: TID, band: "high", action: "edited", fields_edited: Object.assign(["title"], { toJSON: () => [SECRET] }) }),
    ],
    ["array: nested array", "proposal_reviewed", () => ({ item_id: TID, band: "high", action: "edited", fields_edited: [["title", SECRET]] })],
    ["array: oversize", "proposal_reviewed", () => ({ item_id: TID, band: "high", action: "edited", fields_edited: Array(10_000).fill("title") })],
    ["uuid with appended text", "why_opened", () => ({ thread_id: `${TID} ${SECRET}`, surface: "today" })],
    ["uuid with newline", "why_opened", () => ({ thread_id: `${TID}\n${SECRET}`, surface: "today" })],
    ["uuid-shaped object", "why_opened", () => ({ thread_id: { toString: () => TID, text: SECRET }, surface: "today" })],
    ["count as string", "trust_rating", () => ({ score: "4" })],
    ["count NaN", "extraction_completed", () => ({ extraction_id: TID, status: "succeeded", latency_ms: NaN, item_count: 1, band_counts: {} })],
    ["count Infinity", "extraction_completed", () => ({ extraction_id: TID, status: "succeeded", latency_ms: Infinity, item_count: 1, band_counts: {} })],
    ["count BigInt", "trust_rating", () => ({ score: 4n })],
    ["boolean as string", "resolve_saved", () => ({ resolution: "decided", reason_given: SECRET })],
    ["empty-props event with content", "data_exported", () => ({ reason: SECRET })],
    ["cascade with content", "source_deleted", () => ({ cascade: true, source_title: SECRET })],
  ];

  it.each(attempts)("%s (%s)", async (_label, event, make) => {
    const { t, logs } = tracker();
    const outcome = await t.trackAndWait(UID, event, make());
    expect(["rejected", "sent", "failed"]).toContain(outcome);
    expect(leaks(sent), "request body").toEqual([]);
    expect(leaks(logs), "server logs").toEqual([]);
    for (const req of sent) {
      for (const e of req.body.batch) {
        expect(e.distinct_id).toBe(UID);
        expect(e.properties.$process_person_profile).toBe(false);
        expect(e.properties.$geoip_disable).toBe(true);
        for (const k of ["$set", "$set_once", "$ip", "$current_url", "$groups", "title", "__proto__"]) {
          expect(Object.hasOwn(e.properties, k), k).toBe(false);
        }
      }
    }
  });

  it.each([
    ["constructor"],
    ["toString"],
    ["hasOwnProperty"],
    ["__proto__"],
    ["valueOf"],
    ["thread_action "],
    ["Thread_Action"],
    ["$identify"],
    ["$set"],
    ["$exception"],
    [SECRET],
    ["x".repeat(100_000)],
  ])("event name %# is not in the allow-list and sends nothing", async (name) => {
    const { t, logs } = tracker();
    expect(await t.trackAndWait(UID, name, {})).toBe("rejected");
    expect(sent).toEqual([]);
    expect(logs).toEqual([{ event: "analytics_rejected", props: { reason: "unknown_event", analytics_event: null, fields: "" } }]);
  });

  it.each([
    ["email", "dana@example.com"],
    ["name", "Dana"],
    ["content", SECRET],
    ["uuid + text", `${UID} Dana`],
    ["uuid with spaces", ` ${UID} `],
    ["number", 42],
    ["object", { id: UID, name: "Dana" }],
    ["empty", ""],
  ])("distinctId must be a UUID: %s is rejected", async (_l, id) => {
    const { t, logs } = tracker();
    expect(await t.trackAndWait(id as string, "trust_rating", { score: 3 })).toBe("rejected");
    expect(sent).toEqual([]);
    expect(leaks(logs)).toEqual([]);
  });

  it("a rejected very long enum is rejected quickly (no pathological validation time)", async () => {
    const { t } = tracker();
    const start = performance.now();
    expect(await t.trackAndWait(UID, "undo_used", { action: "d".repeat(5_000_000) })).toBe("rejected");
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("the accepted request body carries only allow-listed keys plus SDK metadata", async () => {
    const { t } = tracker();
    const props = { thread_id: TID, action: "resolve", from_status: "open", to_status: "resolved", surface: "detail" };
    expect(await t.trackAndWait(UID, "thread_action", props)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://us.i.posthog.com/batch/");
    const p = sent[0]!.body.batch[0]!.properties;
    expect(Object.keys(p).sort()).toEqual(
      [...Object.keys(props), "$process_person_profile", "$lib", "$lib_version", "$is_server", "$geoip_disable"].sort(),
    );
    expect(sent[0]!.body.batch[0]!.event).toBe("thread_action");
  });

  it("an input with inherited enumerable keys is rejected outright (strict sees the prototype chain)", async () => {
    const { t, logs } = tracker();
    const input = Object.assign(Object.create({ title: SECRET }), { action: "done" });
    expect(await t.trackAndWait(UID, "undo_used", input)).toBe("rejected");
    expect(sent).toEqual([]);
    expect(logs[0]!.props.fields).toBe("title");
  });

  it("a content-shaped valid UUID is the only free-form channel, and it is checked for format", () => {
    // Documenting the residual channel: any RFC UUID passes. Callers must pass row IDs, never derived values.
    expect(validateEvent("why_opened", { thread_id: "dada0000-0000-4000-8000-000000001470", surface: "today" }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("rule 9: content cannot reach the server logs", () => {
  it("an unknown property whose name is content-like is logged by name", async () => {
    const { t, logs } = tracker();
    expect(await t.trackAndWait(UID, "undo_used", { action: "done", "Dana owes $1,470": 1 })).toBe("rejected");
    // Names with spaces/punctuation are masked.
    expect(logs[0]!.props.fields).toBe("(invalid_key)");
  });

  // Regression guard (D3, fixed in 8092143): identifier-shaped content keys used to be logged verbatim.
  it("a content-bearing identifier-shaped key does not reach the log line", async () => {
    const { t, logs } = tracker();
    await t.trackAndWait(UID, "undo_used", { action: "done", [SECRET_KEY]: 1 });
    await t.trackAndWait(UID, "proposals_shown", { extraction_id: TID, band_counts: { [SECRET_KEY]: 1 } });
    await t.trackAndWait(UID, "undo_used", Object.assign(Object.create({ [SECRET_KEY]: 1 }), { action: "done" }));
    for (const k of ["Dana", "roof_1470", "Friday", "x".repeat(64), "1470a", "__proto__", "constructor", "toString", "$set"])
      await t.trackAndWait(UID, "undo_used", JSON.parse(JSON.stringify({ action: "done", [k]: 1 })));
    await t.trackAndWait(UID, "proposal_reviewed", { item_id: TID, band: "high", action: "edited", fields_edited: ["title", SECRET_KEY] });
    await t.trackAndWait(UID, "ask_submitted", { answer_found: true, parts_by_kind: { [SECRET_KEY]: { [SECRET_KEY]: 1 } } });
    expect(logs.length).toBeGreaterThan(10);
    expect(leaks(logs)).toEqual([]);
  });

  it("an error message never reaches the log; only a valid class name does", async () => {
    const err = new Error(SECRET);
    const { t, logs } = tracker({ getClient: () => ({ captureImmediate: async () => Promise.reject(err) }) });
    expect(await t.trackAndWait(UID, "data_exported", {})).toBe("failed");
    expect(logs).toEqual([{ event: "analytics_capture_failed", props: { analytics_event: "data_exported", error: "Error" } }]);
    const weird = Object.assign(new Error("x"), { name: SECRET });
    const b = tracker({ getClient: () => ({ captureImmediate: async () => Promise.reject(weird) }) });
    await b.t.trackAndWait(UID, "data_exported", {});
    expect(b.logs[0]!.props.error).toBe("non_error_thrown");
    const thrownString = tracker({ getClient: () => ({ captureImmediate: async () => Promise.reject(SECRET) }) });
    await thrownString.t.trackAndWait(UID, "data_exported", {});
    expect(leaks(thrownString.logs)).toEqual([]);
  });

  it("the default logger writes nothing but the event and the given props (console spy)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const t = createTracker({ env: { POSTHOG_KEY: freshKey(), ANALYTICS_ENABLED: "true" }, shipped: true, isOptedIn: async () => true, schedule: () => {} });
      await t.trackAndWait(UID, "undo_used", { action: SECRET, note: SECRET });
      await t.trackAndWait(SECRET, "undo_used", { action: "done" });
      fetchImpl = async () => {
        throw new Error(`socket hang up ${SECRET}`);
      };
      await t.trackAndWait(UID, "undo_used", { action: "done" });
      const all = [...warn.mock.calls, ...error.mock.calls, ...log.mock.calls];
      expect(all.length).toBeGreaterThan(0);
      expect(leaks(all.map((c) => c.map(String)))).toEqual([]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
describe("gates: zero network calls unless all four gates are open (D40)", () => {
  const FLAGS: [string, string | undefined][] = [
    ["unset", undefined],
    ['"true"', "true"],
    ['"TRUE"', "TRUE"],
    ['"1"', "1"],
    ['" true"', " true"],
    ['"yes"', "yes"],
  ];
  const KEYS: [string, string | undefined][] = [
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["set", "phc_gate"],
  ];
  const combos: [string, boolean, string | undefined, string | undefined, boolean][] = [];
  for (const shipped of [false, true])
    for (const [fl, flag] of FLAGS)
      for (const [kl, key] of KEYS)
        for (const optIn of [false, true]) combos.push([`shipped=${shipped} flag=${fl} key=${kl} optIn=${optIn}`, shipped, flag, key, optIn]);

  it.each(combos)("%s", async (_l, shipped, flag, key, optIn) => {
    const env: Record<string, string | undefined> = {};
    if (flag !== undefined) env.ANALYTICS_ENABLED = flag;
    if (key !== undefined) env.POSTHOG_KEY = key === "phc_gate" ? freshKey() : key;
    const { t } = tracker({ env, shipped, isOptedIn: async () => optIn });
    const outcome = await t.trackAndWait(UID, "trust_rating", { score: 5 });
    const allOpen = shipped && flag === "true" && key === "phc_gate" && optIn;
    expect(sent.length).toBe(allOpen ? 1 : 0);
    expect(outcome).toBe(allOpen ? "sent" : shipped && flag === "true" && key === "phc_gate" ? "opted_out" : "disabled");
  });

  it("the default lookup (user_settings through RLS) fails closed: false, null row, error, throw", async () => {
    for (const value of [
      { data: { analytics_enabled: false }, error: null },
      { data: { analytics_enabled: null }, error: null },
      { data: { analytics_enabled: "true" }, error: null },
      { data: null, error: null },
      { data: { analytics_enabled: true }, error: { code: "PGRST301" } },
    ]) {
      settingsRow.value = value;
      const t = createTracker({ env: { POSTHOG_KEY: freshKey(), ANALYTICS_ENABLED: "true" }, shipped: true, schedule: () => {}, log: () => {} });
      expect(await t.trackAndWait(UID, "trust_rating", { score: 5 }), JSON.stringify(value)).toBe("opted_out");
    }
    expect(sent).toEqual([]);
  });

  it("the shipped default export track() sends nothing even with ANALYTICS_ENABLED and POSTHOG_KEY set in process.env", async () => {
    vi.stubEnv("ANALYTICS_ENABLED", "true");
    vi.stubEnv("POSTHOG_KEY", freshKey());
    track(UID, "trust_rating", { score: 5 });
    track(UID, "thread_action", { thread_id: TID, action: "done", from_status: "open", to_status: "resolved", surface: "today" });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);
    expect(settingsRow.calls).toBe(0); // not even the opt-out lookup runs while unshipped
  });

  it("gated off, the opt-out lookup is never queried (no DB round trip per event)", async () => {
    const isOptedIn = vi.fn(async () => true);
    const { t } = tracker({ env: {}, isOptedIn });
    await t.trackAndWait(UID, "trust_rating", { score: 5 });
    expect(isOptedIn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
describe("failure isolation: capture cannot throw into or delay the request", () => {
  const timeTrack = (t: ReturnType<typeof createTracker>) => {
    const start = performance.now();
    let threw = false;
    try {
      t.track(UID, "trust_rating", { score: 5 });
    } catch {
      threw = true;
    }
    return { ms: performance.now() - start, threw };
  };

  it("track() returns synchronously while the opt-out lookup never resolves", () => {
    const { t } = tracker({ isOptedIn: () => new Promise<boolean>(() => {}) });
    const r = timeTrack(t);
    expect(r.threw).toBe(false);
    expect(r.ms).toBeLessThan(20);
  });

  it("track() returns synchronously while fetch never resolves", () => {
    fetchImpl = () => new Promise<Response>(() => {});
    const r = timeTrack(tracker().t);
    expect(r.threw).toBe(false);
    expect(r.ms).toBeLessThan(20);
  });

  it("track() returns synchronously and never throws for hostile input", () => {
    const { t } = tracker();
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error(SECRET);
        },
        ownKeys: () => {
          throw new Error(SECRET);
        },
      },
    );
    expect(() => t.track(UID, "undo_used", hostile as never)).not.toThrow();
    expect(() => t.track(null as never, null as never, null as never)).not.toThrow();
    expect(() => t.track(UID, "undo_used", undefined as never)).not.toThrow();
  });

  it("the scheduled background promise never rejects, for network error, HTTP 500 and 413", async () => {
    for (const impl of [
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => new Response("err", { status: 500 }),
      async () => new Response("too large", { status: 413 }),
    ]) {
      fetchImpl = impl;
      const scheduled: Promise<unknown>[] = [];
      const { t } = tracker({ schedule: (p) => void scheduled.push(p) });
      t.track(UID, "trust_rating", { score: 5 });
      expect(scheduled).toHaveLength(1);
      await expect(scheduled[0]).resolves.toMatch(/^(sent|failed)$/);
    }
  }, 30_000);

  it("a hung PostHog request is abandoned by the SDK timeout, so after() work is bounded", async () => {
    fetchImpl = (_url, init) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const scheduled: Promise<unknown>[] = [];
    const { t } = tracker({ schedule: (p) => void scheduled.push(p) });
    const start = performance.now();
    t.track(UID, "trust_rating", { score: 5 });
    const outcome = await scheduled[0];
    const ms = performance.now() - start;
    expect(["sent", "failed"]).toContain(outcome);
    // S1 fix: requestTimeout 2500, fetchRetryCount 0, so one attempt of about 2.5 s.
    expect(ms).toBeLessThan(4_000);
  }, 20_000);

  async function consoleLinesFor(run: () => Promise<unknown>): Promise<string[]> {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run();
      return [...warn.mock.calls, ...error.mock.calls].map((c) => c.map(String).join(" "));
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }
  const failingCapture = () => {
    fetchImpl = async () => {
      throw Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { name: "FetchError" });
    };
    const t = createTracker({ env: { POSTHOG_KEY: freshKey(), ANALYTICS_ENABLED: "true" }, shipped: true, isOptedIn: async () => true, schedule: () => {} });
    return t.trackAndWait(UID, "trust_rating", { score: 2 });
  };

  it("an SDK-swallowed network error is logged by class name only (S1 fix: error emitter)", async () => {
    const lines = await consoleLinesFor(failingCapture);
    expect(lines.map((l) => JSON.parse(l).error)).toContain("PostHogFetchNetworkError");
    expect(leaks(lines)).toEqual([]);
  });

  // DEFECT D4 (pinned): lib/log.ts writes JSON.stringify({ event, ...props }), and every analytics log
  // call passes a prop named `event` (the analytics event name or null). The prop overwrites the log
  // event, so production lines read {"event":null,"error":"PostHogFetchNetworkError"} with no
  // "analytics_capture_failed" / "analytics_rejected" name to search or alert on.
  it("analytics log lines keep their log event name", async () => {
    const lines = await consoleLinesFor(async () => {
      await failingCapture();
      const t = createTracker({ env: {}, shipped: true, isOptedIn: async () => true, schedule: () => {} });
      await t.trackAndWait(UID, "undo_used", { action: "done", title: 1 });
    });
    const names = lines.map((l) => JSON.parse(l).event);
    expect(names).toContain("analytics_capture_failed");
    expect(names).toContain("analytics_rejected");
  });

  it("produces no unhandled rejection when everything fails at once", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      fetchImpl = async () => {
        throw new Error("down");
      };
      const scheduled: Promise<unknown>[] = [];
      const { t } = tracker({
        schedule: (p) => void scheduled.push(p),
        log: () => {
          throw new Error("logger down");
        },
      });
      for (let i = 0; i < 5; i++) t.track(UID, "trust_rating", { score: 5 });
      await Promise.all(scheduled);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 30_000);
});
