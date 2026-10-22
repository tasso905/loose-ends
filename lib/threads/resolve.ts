import { z } from "zod";
import { Resolution, ThreadStatus } from "@/lib/schemas";
import { charCount, DECISION_CHOICE_MAX, DECISION_REASON_MAX } from "./transition";

/**
 * F11 Resolve sheet: input validation and copy (SITE_CONTRACT §2.10, CONTENT_MODEL §9,
 * DESIGN_STANDARD "Resolve sheet"). Client-safe.
 *
 * Documented copy: `How did this end?`, `Done`, `Decided`, `Not needed`, `What did you decide?`,
 * `Want me to remember why?`, `Save`, `Skip`; on Thread detail `Decision`, `You decided · {date}`
 * and `You wrote · {date}` (DESIGN_STANDARD Three voices and Ask Why answer card).
 *
 * PROPOSED copy (not in the docs; needs the user's approval):
 *   - undo toast after Decided or Not needed: `Resolved: "{title}"` (Done keeps the approved
 *     `Marked done: "{title}"`)
 *   - the sheet's close button: `Cancel`
 *   - Save with Decided and an empty decision: `Write what you decided, or choose another option.`
 *   - limits: a decision up to 300 characters, a reason up to 2,000 (enforced by maxLength, so no
 *     message is shown)
 */

export const RESOLVE_COPY = {
  heading: "How did this end?",
  options: { done: "Done", decided: "Decided", not_needed: "Not needed" } satisfies Record<Resolution, string>,
  choiceLabel: "What did you decide?",
  reasonLabel: "Want me to remember why?",
  save: "Save",
  skip: "Skip",
  /** PROPOSED. */
  cancel: "Cancel",
  /** PROPOSED. */
  choiceRequired: "Write what you decided, or choose another option.",
  /** PROPOSED. */
  resolvedToast: (title: string) => `Resolved: "${title}"`,
  /** PROPOSED (screen-reader label of the toast's Undo). */
  undoLabel: (title: string) => `Undo resolve: ${title}`,
  decisionHeading: "Decision",
  youDecided: "You decided",
  youWrote: "You wrote",
} as const;

/** Which resolutions the sheet offers (D6: a decision thread's outcome is recorded, so no Done). */
export function resolutionsFor(kind: string): Resolution[] {
  return kind === "decision" ? ["decided", "not_needed"] : ["done", "decided", "not_needed"];
}

const Choice = z
  .string()
  .refine((s) => s.trim().length > 0, "blank")
  .refine((s) => charCount(s) <= DECISION_CHOICE_MAX, "too_long");
const Reason = z
  .string()
  .refine((s) => charCount(s) <= DECISION_REASON_MAX, "too_long")
  .nullable();

/** The server action's input. The decision is sent only with Decided, its text exactly as typed (rule 5). */
export const ResolveInput = z.discriminatedUnion("resolution", [
  z.object({ threadId: z.uuid(), fromStatus: ThreadStatus, resolution: z.literal("decided"), choice: Choice, reason: Reason }),
  z.object({ threadId: z.uuid(), fromStatus: ThreadStatus, resolution: z.literal("done") }),
  z.object({ threadId: z.uuid(), fromStatus: ThreadStatus, resolution: z.literal("not_needed") }),
]);
export type ResolveInput = z.input<typeof ResolveInput>;
