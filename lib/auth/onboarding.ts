import { z } from "zod";

/**
 * Onboarding aliases question (PRD F1, CONTENT_MODEL §0 and §11 "Display name / aliases").
 *
 * The answer is a comma- or newline-separated list of names and emails. Each entry is stored as
 * the user typed it (trimmed only; rule 5). The signed-in email is always an alias. The first
 * entry that is not an email becomes the display name; with none, the display name is unchanged.
 */

export const MAX_ALIASES = 20;
export const MAX_ALIAS_LENGTH = 100;
const MAX_ANSWER_LENGTH = 2_500;

const isEmail = (v: string) => z.email().safeParse(v).success;

/** IANA zone accepted by this runtime; the database trigger re-checks against pg_timezone_names. */
export function isValidTimeZone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function splitAliases(answer: string): string[] {
  return answer
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const OnboardingInput = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("skip"),
    timezone: z.string().optional(),
    next: z.string().max(2048).optional(),
  }),
  z.object({
    intent: z.literal("save"),
    answer: z
      .string()
      .max(MAX_ANSWER_LENGTH, { error: "too_long" })
      .transform(splitAliases)
      .pipe(
        z
          .array(z.string().max(MAX_ALIAS_LENGTH, { error: "too_long" }))
          .max(MAX_ALIASES, { error: "too_many" }),
      ),
    timezone: z.string().optional(),
    next: z.string().max(2048).optional(),
  }),
]);
export type OnboardingInput = z.infer<typeof OnboardingInput>;

/** Case-insensitive union that keeps the first spelling seen, signed-in email first. */
export function mergeAliases(email: string | null, existing: readonly string[], added: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of [...(email ? [email] : []), ...existing, ...added]) {
    const key = a.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a.trim());
  }
  return out;
}

export function displayNameFrom(added: readonly string[]): string | null {
  return added.find((a) => !isEmail(a)) ?? null;
}

export interface ProfilePatch {
  aliases: string[];
  display_name?: string;
  timezone?: string;
  onboarded_at: string;
}

/** Builds the profiles update for either intent. Pure, so the action stays thin. */
export function buildProfilePatch(
  input: OnboardingInput,
  ctx: { email: string | null; existingAliases: readonly string[]; nowIso: string },
): ProfilePatch {
  const added = input.intent === "save" ? input.answer : [];
  const patch: ProfilePatch = {
    aliases: mergeAliases(ctx.email, ctx.existingAliases, added),
    onboarded_at: ctx.nowIso,
  };
  const name = displayNameFrom(added);
  if (name) patch.display_name = name;
  if (input.timezone && isValidTimeZone(input.timezone)) patch.timezone = input.timezone;
  return patch;
}
