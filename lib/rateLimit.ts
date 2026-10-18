/**
 * Daily rate limit (PRD Technical Architecture): 30 extractions and 50 asks per user per day,
 * counted by the `consume_usage` database function (UTC days). Any error is a denial, so a
 * database fault can never let an unmetered LLM call through.
 */
export type UsageKind = "extraction" | "ask";

export const DAILY_LIMITS: Record<UsageKind, number> = { extraction: 30, ask: 50 };

/** Timezone named in the `rate_limited` copy: counters reset at midnight UTC. */
export const RATE_LIMIT_TIMEZONE = "UTC";

/** The slice of a Supabase client this needs (keeps the function testable without a server). */
export interface RpcClient {
  rpc(fn: "consume_usage", args: { p_kind: UsageKind }): PromiseLike<{ data: unknown; error: unknown }>;
}

export async function consumeUsage(client: RpcClient, kind: UsageKind): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("consume_usage", { p_kind: kind });
    return !error && data === true;
  } catch {
    return false;
  }
}
