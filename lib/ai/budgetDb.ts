import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BudgetDb } from "./budget";

/**
 * The service-role client for DAILY_AI_BUDGET_USD, and nothing else (approved by the user Nov 4).
 * Only the check and the record can go through it: the client itself is never handed out, and any
 * other function name throws. A missing key throws too, which withBudget() treats as a failed
 * check, so the call is refused. Imported only by server actions.
 */
const ALLOWED: ReadonlySet<string> = new Set(["ai_budget_open", "record_ai_cost"]);

let client: ReturnType<typeof createAdminClient> | undefined;

export const serviceBudgetDb: BudgetDb = {
  rpc(fn, args) {
    if (!ALLOWED.has(fn)) throw new Error("not a budget function");
    client ??= createAdminClient();
    return client.rpc(fn, args);
  },
};
