"use server";
import { z } from "zod";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";

const Input = z.strictObject({ enabled: z.boolean() });

export type AnalyticsSettingResult = { ok: true; enabled: boolean } | { ok: false; code: "save_failed" };

/**
 * Settings → Profile analytics toggle (D40). Writes the user's own `user_settings.analytics_enabled`
 * through RLS and reports success only after the row is updated (rule 10).
 */
export async function setAnalyticsEnabled(input: { enabled: boolean }): Promise<AnalyticsSettingResult> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, code: "save_failed" };

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, code: "save_failed" };

  const { data, error } = await supabase
    .from("user_settings")
    .update({ analytics_enabled: parsed.data.enabled })
    .eq("user_id", auth.user.id)
    .select("analytics_enabled");
  if (error || !data || data.length !== 1) {
    log("analytics_setting_save_failed", { code: error?.code ?? null, rows: data?.length ?? 0 });
    return { ok: false, code: "save_failed" };
  }
  return { ok: true, enabled: data[0]!.analytics_enabled === true };
}
