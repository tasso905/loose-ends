import { z } from "zod";

/**
 * F7 "Not sure about" for a thread, from the stored proposal payload only (rule 6). PRD F7: the
 * section appears whenever any field has `certainty != explicit`. The payload's own lines (the
 * model's uncertainty notes and the date re-resolution notes) come first; when a non-explicit field
 * has no line of its own, a fixed template line says so.
 *
 * PROPOSED copy (not in the docs; needs the user's approval):
 *   implied item:      "The source suggests this but doesn't say it outright."
 *   speculative item:  "This may not be a firm plan."
 *   inferred due date: "The source doesn't give this exact date. I worked it out."
 */
export const NOT_SURE_FALLBACK = {
  implied: "The source suggests this but doesn't say it outright.",
  speculative: "This may not be a firm plan.",
  inferredDate: "The source doesn't give this exact date. I worked it out.",
} as const;

export const StoredOrigin = z
  .object({
    not_sure: z.array(z.string()).optional(),
    item: z
      .object({
        certainty: z.enum(["explicit", "implied", "speculative"]).optional(),
        uncertainty_notes: z.array(z.string()).optional(),
      })
      .loose()
      .optional(),
    date: z
      .object({
        due_certainty: z.enum(["explicit", "inferred", "none"]).optional(),
        not_sure: z.array(z.string()).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
export type StoredOrigin = z.infer<typeof StoredOrigin>;

export function threadNotSure(payload: StoredOrigin | null | undefined, thread: { due_certainty: string; due_at: string | null }): string[] {
  // Date notes describe the date as it was read; once the thread's date is no longer inferred
  // (the user set it), they no longer apply.
  const dateNotes = new Set(thread.due_certainty === "inferred" ? [] : (payload?.date?.not_sure ?? []));
  const out = (payload?.not_sure ?? []).filter((l) => !dateNotes.has(l));
  const certainty = payload?.item?.certainty;
  if ((certainty === "implied" || certainty === "speculative") && (payload?.item?.uncertainty_notes ?? []).length === 0) {
    out.push(NOT_SURE_FALLBACK[certainty]);
  }
  // The thread's current date decides: a user-edited date is no longer the model's inference.
  if (thread.due_at && thread.due_certainty === "inferred" && (payload?.date?.not_sure ?? []).length === 0) {
    out.push(NOT_SURE_FALLBACK.inferredDate);
  }
  return out;
}
