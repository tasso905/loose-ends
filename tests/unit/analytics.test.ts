import { beforeEach, describe, expect, it, vi } from "vitest";

// No live PostHog: the SDK class is replaced by a stub that records its options and captures.
const posthog = vi.hoisted(() => ({
  instances: [] as { key: string; options: Record<string, unknown> }[],
  captureImmediate: vi.fn<(m: unknown) => Promise<void>>(async () => {}),
}));
vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(key: string, options: Record<string, unknown>) {
      posthog.instances.push({ key, options });
    }
    captureImmediate = posthog.captureImmediate;
  },
}));
vi.mock("server-only", () => ({}));
const settingsRow = vi.hoisted(() => ({ value: { data: { analytics_enabled: true } as unknown, error: null as unknown } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => settingsRow.value }) }) }),
  }),
}));

const { ANALYTICS_EVENTS, ANALYTICS_EVENT_NAMES, charCountBucket, validateEvent } = await import("@/lib/analytics/events");
const { createTracker, track } = await import("@/lib/analytics/track");
const { DEFAULT_POSTHOG_HOST, isAnalyticsEnabled, posthogSettings } = await import("@/lib/supabase/env");

const UID = "00000000-0000-4000-8000-00000000000a";
const TID = "20000000-0000-4000-8000-00000000000a";
const SECRET = "Pay Dana $1,470 for the roof by Friday";
const ON = { POSTHOG_KEY: "phc_test", ANALYTICS_ENABLED: "true" };

/** One valid property set per taxonomy event (PRD "Analytics & Success Metrics"). */
const VALID: Record<string, Record<string, unknown>> = {
  source_submitted: { kind: "upload", char_count_bucket: "2k_10k", file_type: "pdf" },
  extraction_completed: {
    extraction_id: TID,
    status: "succeeded",
    latency_ms: 4200,
    item_count: 3,
    band_counts: { high: 2, medium: 1, low: 0 },
  },
  proposals_shown: { extraction_id: TID, band_counts: { high: 1 } },
  proposal_reviewed: { item_id: TID, band: "medium", action: "edited", fields_edited: ["title", "due_at"] },
  clarification_answered: { choice_kind: "participant", alias_saved: true },
  thread_action: { thread_id: TID, action: "done", from_status: "open", to_status: "resolved", surface: "today" },
  undo_used: { action: "dismiss" },
  why_opened: { thread_id: TID, surface: "detail" },
  marked_wrong: { thread_id: TID, next_step: "edit" },
  not_useful: { thread_id: TID, surface: "digest" },
  resolve_saved: { resolution: "decided", reason_given: true },
  ask_submitted: { answer_found: true, parts_by_kind: { user_reason: 1, source_fact: 2 } },
  source_deleted: { cascade: true },
  data_exported: {},
  account_deleted: {},
  trust_rating: { score: 4 },
};

function harness(over: Partial<Parameters<typeof createTracker>[0]> = {}) {
  const logs: { event: string; props: Record<string, unknown> }[] = [];
  const capture = vi.fn<(m: unknown) => Promise<void>>(async () => {});
  const scheduled: Promise<unknown>[] = [];
  const t = createTracker({
    env: ON,
    shipped: true,
    isOptedIn: async () => true,
    getClient: () => ({ captureImmediate: capture }),
    schedule: (p) => void scheduled.push(p),
    log: (event, props) => void logs.push({ event, props }),
    ...over,
  });
  return { t, logs, capture, scheduled };
}

beforeEach(() => {
  posthog.instances.length = 0;
  posthog.captureImmediate.mockClear();
  settingsRow.value = { data: { analytics_enabled: true }, error: null };
});

describe("event allow-list (PRD event taxonomy, rule 9)", () => {
  it("covers exactly the taxonomy events", () => {
    expect(ANALYTICS_EVENT_NAMES.sort()).toEqual(Object.keys(VALID).sort());
  });

  it.each(Object.keys(VALID))("%s: accepts its documented properties", (event) => {
    expect(validateEvent(event, VALID[event])).toMatchObject({ ok: true, event });
  });

  it.each(Object.keys(VALID))("%s: rejects free text in every property, and any extra property", (event) => {
    for (const key of Object.keys(VALID[event]!)) {
      const r = validateEvent(event, { ...VALID[event], [key]: SECRET });
      expect(r, `${event}.${key}`).toMatchObject({ ok: false, reason: "invalid_props" });
    }
    for (const extra of ["title", "quote", "reason", "name", "email", "text"]) {
      const r = validateEvent(event, { ...VALID[event], [extra]: SECRET });
      expect(r, `${event}+${extra}`).toMatchObject({ ok: false, reason: "invalid_props", fields: [extra] });
    }
  });

  it("rejects free text nested in count maps and arrays", () => {
    expect(validateEvent("extraction_completed", { ...VALID.extraction_completed, band_counts: { [SECRET]: 1 } }).ok).toBe(false);
    expect(validateEvent("extraction_completed", { ...VALID.extraction_completed, band_counts: { high: SECRET } }).ok).toBe(false);
    expect(validateEvent("proposal_reviewed", { ...VALID.proposal_reviewed, fields_edited: [SECRET] }).ok).toBe(false);
    expect(validateEvent("ask_submitted", { answer_found: true, parts_by_kind: { inference: 1, text: 2 } }).ok).toBe(false);
  });

  it("logs only allow-listed property names: an identifier-shaped content key is masked", () => {
    const KEY = "Pay_Dana_1470_for_the_roof_by_Friday";
    expect(validateEvent("undo_used", { action: "done", [KEY]: 1 })).toMatchObject({ fields: ["(invalid_key)"] });
    expect(validateEvent("proposals_shown", { extraction_id: TID, band_counts: { [KEY]: 1 } })).toMatchObject({
      fields: ["band_counts.(invalid_key)"],
    });
    expect(validateEvent("proposal_reviewed", { ...VALID.proposal_reviewed, fields_edited: ["title", KEY] })).toMatchObject({
      fields: ["fields_edited.1"],
    });
    expect(validateEvent("undo_used", { action: "done", title: 1 })).toMatchObject({ fields: ["title"] });
  });

  it("rejects non-UUID IDs, non-integer counts and unknown events", () => {
    expect(validateEvent("why_opened", { thread_id: "dana@example.com", surface: "today" }).ok).toBe(false);
    expect(validateEvent("trust_rating", { score: 4.5 }).ok).toBe(false);
    expect(validateEvent("trust_rating", { score: 6 }).ok).toBe(false);
    expect(validateEvent(SECRET, {})).toEqual({ ok: false, reason: "unknown_event", event: null, fields: [] });
    expect(validateEvent("__proto__", {})).toMatchObject({ ok: false, reason: "unknown_event" });
  });

  it("every schema is strict and has no free-string property", () => {
    for (const [event, schema] of Object.entries(ANALYTICS_EVENTS)) {
      expect(schema.safeParse({ ...VALID[event], zzz: 1 }).success, event).toBe(false);
    }
  });

  it("buckets character counts instead of sending them", () => {
    expect([0, 499, 500, 1999, 2000, 9999, 10_000, 30_000, 30_001].map(charCountBucket)).toEqual([
      "lt_500",
      "lt_500",
      "500_2k",
      "500_2k",
      "2k_10k",
      "2k_10k",
      "10k_30k",
      "10k_30k",
      "gt_30k",
    ]);
  });
});

describe("track() gating (D40)", () => {
  it("sends a validated event with the user ID only, no GeoIP and no person profile", async () => {
    const { t, capture } = harness();
    expect(await t.trackAndWait(UID, "thread_action", VALID.thread_action)).toBe("sent");
    expect(capture).toHaveBeenCalledWith({
      distinctId: UID,
      event: "thread_action",
      properties: { ...VALID.thread_action, $process_person_profile: false },
      disableGeoip: true,
    });
  });

  it.each([
    ["no key", { ANALYTICS_ENABLED: "true" }],
    ["blank key", { ANALYTICS_ENABLED: "true", POSTHOG_KEY: "  " }],
    ["flag unset", { POSTHOG_KEY: "phc_test" }],
    ["flag not exactly true", { POSTHOG_KEY: "phc_test", ANALYTICS_ENABLED: "TRUE" }],
  ])("sends nothing when %s", async (_label, env) => {
    const optIn = vi.fn(async () => true);
    const { t, capture } = harness({ env, isOptedIn: optIn });
    expect(await t.trackAndWait(UID, "undo_used", { action: "done" })).toBe("disabled");
    expect(capture).not.toHaveBeenCalled();
    expect(optIn).not.toHaveBeenCalled();
  });

  it("sends nothing while the Settings toggle has not shipped", async () => {
    const { t, capture } = harness({ shipped: false });
    expect(await t.trackAndWait(UID, "undo_used", { action: "done" })).toBe("disabled");
    expect(capture).not.toHaveBeenCalled();
  });

  it("sends nothing when the user opted out", async () => {
    const { t, capture } = harness({ isOptedIn: async () => false });
    expect(await t.trackAndWait(UID, "undo_used", { action: "done" })).toBe("opted_out");
    expect(capture).not.toHaveBeenCalled();
  });

  it("the default opt-out lookup reads user_settings and fails closed", async () => {
    const t = createTracker({ env: ON, shipped: true, getClient: () => ({ captureImmediate: posthog.captureImmediate }), schedule: () => {}, log: () => {} });
    expect(await t.trackAndWait(UID, "trust_rating", { score: 5 })).toBe("sent");
    for (const row of [
      { data: { analytics_enabled: false }, error: null },
      { data: null, error: null },
      { data: null, error: { code: "PGRST301", message: SECRET } },
    ]) {
      settingsRow.value = row;
      expect(await t.trackAndWait(UID, "trust_rating", { score: 5 })).toBe("opted_out");
    }
    expect(posthog.captureImmediate).toHaveBeenCalledTimes(1);
  });

  it("rejects and logs unknown events and free-text props without their values, even when disabled", async () => {
    const { t, logs, capture } = harness({ env: {} });
    expect(await t.trackAndWait(UID, SECRET, {})).toBe("rejected");
    expect(await t.trackAndWait(UID, "why_opened", { thread_id: TID, surface: "today", note: SECRET })).toBe("rejected");
    expect(await t.trackAndWait(UID, "why_opened", { thread_id: SECRET, surface: "today" })).toBe("rejected");
    expect(await t.trackAndWait("dana@example.com", "trust_rating", { score: 3 })).toBe("rejected");
    expect(capture).not.toHaveBeenCalled();
    expect(logs).toEqual([
      { event: "analytics_rejected", props: { reason: "unknown_event", event: null, fields: "" } },
      { event: "analytics_rejected", props: { reason: "invalid_props", event: "why_opened", fields: "note" } },
      { event: "analytics_rejected", props: { reason: "invalid_props", event: "why_opened", fields: "thread_id" } },
      { event: "analytics_rejected", props: { reason: "invalid_user_id", event: "trust_rating", fields: "" } },
    ]);
    expect(JSON.stringify(logs)).not.toContain("Dana");
    expect(JSON.stringify(logs)).not.toContain("dana@");
  });
});

describe("track() never throws into the request path", () => {
  it("swallows capture errors and logs only the error class name", async () => {
    const err = Object.assign(new Error(`request failed: ${SECRET}`), { name: "PostHogFetchHttpError" });
    const { t, logs } = harness({ getClient: () => ({ captureImmediate: async () => Promise.reject(err) }) });
    expect(await t.trackAndWait(UID, "resolve_saved", VALID.resolve_saved)).toBe("failed");
    expect(logs).toEqual([{ event: "analytics_capture_failed", props: { event: "resolve_saved", error: "PostHogFetchHttpError" } }]);
    expect(JSON.stringify(logs)).not.toContain("Dana");
  });

  it("swallows synchronous throws from the client, the opt-out lookup, the logger and the scheduler", async () => {
    const boom = () => {
      throw new Error(SECRET);
    };
    const a = harness({ getClient: boom });
    expect(await a.t.trackAndWait(UID, "data_exported", {})).toBe("failed");
    expect(a.logs[0]).toEqual({ event: "analytics_capture_failed", props: { event: "data_exported", error: "Error" } });

    const b = harness({ isOptedIn: async () => boom(), log: boom });
    expect(await b.t.trackAndWait(UID, "data_exported", {})).toBe("failed");

    const c = harness({ schedule: boom });
    expect(() => c.t.track(UID, "data_exported", {})).not.toThrow();
  });

  it("track() returns before the capture finishes and hands the work to the scheduler", async () => {
    let release!: () => void;
    const capture = vi.fn(() => new Promise<void>((r) => (release = r)));
    const { t, scheduled } = harness({ getClient: () => ({ captureImmediate: capture }) });
    expect(t.track(UID, "account_deleted", {})).toBeUndefined();
    expect(scheduled).toHaveLength(1);
    await vi.waitFor(() => expect(capture).toHaveBeenCalled());
    release();
    await expect(scheduled[0]).resolves.toBe("sent");
  });

  it("the default track() is a silent no-op outside a request scope and with analytics off", () => {
    expect(() => track(UID, "trust_rating", { score: 4 })).not.toThrow();
    expect(posthog.instances).toHaveLength(0);
  });
});

describe("PostHog client and settings", () => {
  it("defaults to the US cloud host (D40) and configures serverless flushing", async () => {
    expect(DEFAULT_POSTHOG_HOST).toBe("https://us.i.posthog.com");
    expect(posthogSettings(ON)).toEqual({ key: "phc_test", host: DEFAULT_POSTHOG_HOST });
    expect(posthogSettings({ ...ON, POSTHOG_HOST: "https://eu.i.posthog.com" })?.host).toBe("https://eu.i.posthog.com");

    const t = createTracker({ env: { ...ON, POSTHOG_KEY: "phc_default_client" }, shipped: true, isOptedIn: async () => true, schedule: () => {}, log: () => {} });
    expect(await t.trackAndWait(UID, "trust_rating", { score: 4 })).toBe("sent");
    expect(posthog.instances).toEqual([
      {
        key: "phc_default_client",
        options: expect.objectContaining({ host: DEFAULT_POSTHOG_HOST, flushAt: 1, flushInterval: 0, disableGeoip: true, requestTimeout: 2500, fetchRetryCount: 0 }),
      },
    ]);
    expect(posthog.captureImmediate).toHaveBeenCalledTimes(1);
  });

  it("isAnalyticsEnabled needs the shipped toggle, the flag and a key", () => {
    expect(isAnalyticsEnabled(ON)).toBe(false); // not shipped in S1
    expect(isAnalyticsEnabled(ON, true)).toBe(true);
    expect(isAnalyticsEnabled({ POSTHOG_KEY: "phc_test" }, true)).toBe(false);
    expect(isAnalyticsEnabled({ ANALYTICS_ENABLED: "true" }, true)).toBe(false);
  });
});
