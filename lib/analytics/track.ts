import "server-only";
import { after } from "next/server";
import { PostHog } from "posthog-node";
import { z } from "zod";
import { log as defaultLog, type Logger } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { posthogSettings, SETTINGS_ANALYTICS_TOGGLE_SHIPPED } from "@/lib/supabase/env";
import { ANALYTICS_EVENTS, validateEvent, type AnalyticsEvent, type AnalyticsProps } from "./events";

/**
 * Server-only product analytics (PRD event taxonomy; D40; rule 9).
 *
 * `track()` returns immediately and never throws: validation, the opt-out lookup and the PostHog
 * request run in the background, kept alive past the response with Next's `after()` so a
 * serverless function does not freeze before the event is sent. Nothing is sent unless all hold:
 * the Settings toggle has shipped, ANALYTICS_ENABLED is "true", POSTHOG_KEY is set, and the user's
 * `user_settings.analytics_enabled` is true. Any doubt (lookup error, missing row) sends nothing.
 */

export interface CaptureMessage {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
  disableGeoip: boolean;
}
/** The one PostHog method used; tests pass a stub. */
export interface CaptureClient {
  captureImmediate(message: CaptureMessage): Promise<void>;
}

export type TrackOutcome = "sent" | "rejected" | "disabled" | "opted_out" | "failed";

export interface TrackerDeps {
  env?: Record<string, string | undefined>;
  shipped?: boolean;
  getClient?: (settings: { key: string; host: string }) => CaptureClient;
  /** Whether this user allows analytics. Must resolve false on any doubt. */
  isOptedIn?: (userId: string) => Promise<boolean>;
  /** Keeps background work alive after the response. */
  schedule?: (work: Promise<unknown>) => void;
  log?: Logger;
}

const UserId = z.uuid();
const ERROR_NAME = /^[A-Za-z_$][\w$.]{0,63}$/;
/** An error's class name only: messages can echo request bodies, so they are never logged. */
const errorName = (err: unknown) => (err instanceof Error && ERROR_NAME.test(err.name) ? err.name : "non_error_thrown");

/** Upper bound on one PostHog request; no retries (see posthogClient). */
export const POSTHOG_REQUEST_TIMEOUT_MS = 2500;

const clients = new Map<string, CaptureClient>();
function posthogClient({ key, host }: { key: string; host: string }): CaptureClient {
  const cacheKey = `${host}\n${key}`;
  let client = clients.get(cacheKey);
  if (!client) {
    // Serverless: no batching or timers; each event is sent by captureImmediate and awaited in after().
    // One attempt with a 2.5 s timeout and no retry, so a hung PostHog holds after() for at most
    // about 2.5 s (the SDK default is 10 s x 4 attempts). A dropped event is acceptable; a slow
    // function is not.
    const ph = new PostHog(key, {
      host,
      flushAt: 1,
      flushInterval: 0,
      disableGeoip: true,
      requestTimeout: POSTHOG_REQUEST_TIMEOUT_MS,
      fetchRetryCount: 0,
    });
    // captureImmediate swallows network errors and emits them here; log the class name only.
    if (typeof ph.on === "function") {
      ph.on("error", (err: unknown) => {
        try {
          defaultLog("analytics_capture_failed", { analytics_event: null, error: errorName(err) });
        } catch {
          // Never throw from the SDK's emitter.
        }
      });
    }
    client = ph;
    clients.set(cacheKey, client);
  }
  return client;
}

/** Reads the user's own `user_settings.analytics_enabled` through RLS. Fails closed. */
async function userAllowsAnalytics(userId: string): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("user_settings").select("analytics_enabled").eq("user_id", userId).maybeSingle();
    return !error && data?.analytics_enabled === true;
  } catch {
    return false;
  }
}

function scheduleAfter(work: Promise<unknown>): void {
  try {
    after(() => work);
  } catch {
    // Outside a request scope (scripts, tests): the work is already running and never rejects.
  }
}

export function createTracker(deps: TrackerDeps = {}) {
  const logger = deps.log ?? defaultLog;
  const schedule = deps.schedule ?? scheduleAfter;

  async function run(userId: string, event: string, props: unknown): Promise<TrackOutcome> {
    try {
      const checked = validateEvent(event, props);
      if (!checked.ok) {
        logger("analytics_rejected", { reason: checked.reason, analytics_event: checked.event, fields: checked.fields.join(",") });
        return "rejected";
      }
      if (!UserId.safeParse(userId).success) {
        logger("analytics_rejected", { reason: "invalid_user_id", analytics_event: checked.event, fields: "" });
        return "rejected";
      }
      const settings = posthogSettings(deps.env ?? process.env);
      if (!(deps.shipped ?? SETTINGS_ANALYTICS_TOGGLE_SHIPPED) || !settings) return "disabled";
      if (!(await (deps.isOptedIn ?? userAllowsAnalytics)(userId))) return "opted_out";

      const client = (deps.getClient ?? posthogClient)(settings);
      await client.captureImmediate({
        distinctId: userId,
        event: checked.event,
        // No person profile: events are counted by user ID only, with no person properties.
        properties: { ...checked.props, $process_person_profile: false },
        disableGeoip: true,
      });
      return "sent";
    } catch (err) {
      try {
        logger("analytics_capture_failed", { analytics_event: knownEventName(event), error: errorName(err) });
      } catch {
        // Logging must not throw into the request path either.
      }
      return "failed";
    }
  }

  return {
    /** Fire and forget. Never throws, never blocks the response. */
    track<E extends AnalyticsEvent>(userId: string, event: E, props: AnalyticsProps<E>): void {
      try {
        schedule(run(userId, event, props));
      } catch {
        // A failing scheduler must not reach the caller.
      }
    },
    /** Same pipeline, awaited; for tests and scripts. */
    trackAndWait: (userId: string, event: string, props: unknown): Promise<TrackOutcome> => run(userId, event, props),
  };
}

/** Only a known event name may appear in a log line; anything else could be caller-supplied text. */
function knownEventName(event: unknown): string | null {
  return typeof event === "string" && Object.hasOwn(ANALYTICS_EVENTS, event) ? event : null;
}

const defaultTracker = createTracker();

/** `track(userId, "thread_action", {...})`. Off unless shipped, configured and not opted out. */
export const track = defaultTracker.track;
