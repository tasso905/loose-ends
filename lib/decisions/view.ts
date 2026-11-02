import { z } from "zod";
import { charCount } from "@/lib/threads/transition";

/** Ask why input and answer view shapes (client-safe; the server side is lib/decisions/ask.ts). */

export const ASK_MAX = 300;

export const AskInput = z.object({
  question: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, "empty")
    .refine((s) => charCount(s) <= ASK_MAX, "too_long"),
});

export interface AnswerDecision {
  id: string;
  thread_id: string;
  thread_title: string;
  choice: string;
  decided_at: string;
  /** The whole stored reason, verbatim; null when none was recorded (Skip). */
  reason_user: string | null;
  /** Stored facts the answer cited, whole and verbatim. */
  facts: string[];
  /** Interpretation lines about this decision (model text, always labelled). */
  interpretations: string[];
}

export interface AskView {
  found: boolean;
  /** NO_RECORD_MESSAGE when nothing was found. */
  message: string | null;
  decisions: AnswerDecision[];
  /** Interpretation lines not tied to one decision. */
  interpretations: string[];
}

