/**
 * Structured server log. Rule 9: properties carry IDs, enums and counts only, never
 * source text, titles, quotes, names or reasons.
 */
export type LogEvent =
  | "quote_unverified"
  | "field_unverified"
  | "extraction_retry"
  | "ask_why_ref_rejected"
  | "ask_why_failed"
  | "account_delete_late_objects"
  | "account_delete_sweep_failed"
  | "sign_in_link_failed"
  | "auth_callback_failed"
  | "onboarding_save_failed";

export type LogProps = Record<string, string | number | boolean | null>;

export type Logger = (event: LogEvent, props: LogProps) => void;

export const log: Logger = (event, props) => {
  console.warn(JSON.stringify({ event, ...props }));
};
