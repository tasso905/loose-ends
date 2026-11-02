import { z } from "zod";
import { Resolution, ThreadStatus } from "@/lib/schemas";
import { charCount, DECISION_CHOICE_MAX, DECISION_REASON_MAX, isBlankText } from "./transition";

/**
 * F11 Resolve sheet: input validation and copy (SITE_CONTRACT §2.10, CONTENT_MODEL §9,
 * DESIGN_STANDARD "Resolve sheet"). Client-safe.
 *
 * Documented copy: `How did this end?`, `Done`, `Decided`, `Not needed`, `What did you decide?`,
 * `Want me to remember why?`, `Save`, `Skip`; on Thread detail `Decision`, `You decided · {date}`
 * and `You wrote · {date}` (DESIGN_STANDARD Three voices and Ask Why answer card).
 *
 * APPROVED copy (S8 wording; user, D56):
 *   - undo toast after Decided or Not needed: `Resolved: "{title}"` (Done keeps the approved
 *     `Marked done: "{title}"`)
 *   - the sheet's close button: `Cancel`
 *   - Save with Decided and an empty decision: `Write what you decided, or choose another option.`
 *   - limits: a decision up to 300 characters, a reason up to 2,000 (enforced by maxLength)
 *
 * PROPOSED copy (not in the docs; needs the user's approval). Shown only to a request that gets
 * past maxLength (a forged one), so a normal user never sees them:
 *   - `Decisions can be up to 300 characters.`
 *   - `Reasons can be up to 2,000 characters.`
 */

export const RESOLVE_COPY = {
  heading: "How did this end?",
  options: { done: "Done", decided: "Decided", not_needed: "Not needed" } satisfies Record<Resolution, string>,
  choiceLabel: "What did you decide?",
  reasonLabel: "Want me to remember why?",
  save: "Save",
  skip: "Skip",
  /** APPROVED (D56). */
  cancel: "Cancel",
  /** APPROVED (D56). */
  choiceRequired: "Write what you decided, or choose another option.",
  /** PROPOSED. */
  choiceTooLong: "Decisions can be up to 300 characters.",
  /** PROPOSED. */
  reasonTooLong: "Reasons can be up to 2,000 characters.",
  /** APPROVED (D56). */
  resolvedToast: (title: string) => `Resolved: "${title}"`,
  /** APPROVED (D56; screen-reader label of the toast's Undo). */
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
  .refine((s) => !isBlankText(s), "blank")
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
