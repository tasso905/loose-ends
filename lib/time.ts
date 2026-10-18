/**
 * The only clock in Loose Ends (CLAUDE.md engineering conventions).
 *
 * App logic calls getNow(); it never calls `new Date()` or `Date.now()` directly
 * (enforced by ESLint outside this file).
 *
 * Precedence:
 *   1. A test override set with setNowForTests().
 *   2. The per-user demo date (`user_settings.demo_now`), honored only when DEMO_MODE=true.
 *   3. The real system clock.
 */

let testNow: Date | null = null;

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

export interface ClockContext {
  /** `user_settings.demo_now` for the signed-in user, if any. Ignored unless DEMO_MODE=true. */
  demoNow?: Date | string | null;
}

export function getNow(ctx?: ClockContext): Date {
  if (testNow) return new Date(testNow.getTime());
  if (ctx?.demoNow && isDemoMode()) {
    const demo = new Date(ctx.demoNow);
    if (!Number.isNaN(demo.getTime())) return demo;
  }
  return new Date();
}

/** True when the clock shown to the user is simulated, so the demo-date banner (D12) must render. */
export function isSimulatedClock(ctx?: ClockContext): boolean {
  return Boolean(ctx?.demoNow) && isDemoMode();
}

/** Freeze the clock for tests and evals. Pass null to restore the real clock. */
export function setNowForTests(now: Date | string | null): void {
  testNow = now === null ? null : new Date(now);
}

/** Parse an ISO timestamp from stored data or input. Throws on an invalid value. */
export function parseInstant(value: string | Date): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${String(value)}`);
  return d;
}
