/**
 * Copy for Settings → Data and Forget permanently (S11). Strings marked DOC come from
 * SITE_CONTRACT §2.7/§2.12/§2.14 or CONTENT_MODEL §8; everything else is PROPOSED and needs the
 * user's approval (Decisions Log). Confirmations list exactly what is deleted (SITE_CONTRACT §3.6,
 * D8) and what remains (CONTENT_MODEL "Delete source"). Never claims more than the code does
 * (rule 9): the suppression hash stays, and platform backups expire on their own schedule (PRD
 * Privacy & Security).
 */

/** The word typed to confirm account deletion (DOC: CONTENT_MODEL "Delete account"). */
export const ACCOUNT_DELETE_WORD = "delete";

/** Set only by a successful account deletion; the sign-in page reads it once. */
export const ACCOUNT_DELETED_COOKIE = "le_account_deleted";
/** Its value: "1" everything is gone; otherwise the account is gone and this says what isn't, yet. */
export function accountDeletedCookieValue(remain: { signInRecords: boolean; files: boolean }): string {
  if (remain.signInRecords && remain.files) return "4";
  if (remain.files) return "3";
  return remain.signInRecords ? "2" : "1";
}
/** The notice for that cookie value, or null for anything else. */
export function accountDeletedNotice(value: string | null | undefined): string | null {
  if (value === "1") return DATA_COPY.accountDeleted;
  if (value === "2") return DATA_COPY.accountDeletedRecordsRemain;
  if (value === "3") return DATA_COPY.accountDeletedFilesRemain;
  if (value === "4") return DATA_COPY.accountDeletedBothRemain;
  return null;
}
/** Set only by the proxy, from that cookie, for the one document request that shows the notice. */
export const ACCOUNT_DELETED_HEADER = "x-le-account-deleted";

export const DATA_COPY = {
  // Settings page
  settingsTitle: "Settings",
  dataHeading: "Data", // DOC (§2.12 field name, anchor #data)
  sourcesHeading: "Your sources", // PROPOSED
  noSources: "You haven't added anything yet.", // DOC (§2.14)
  loadFailed: "Settings didn't load. Try again.", // DOC (D46)
  tryAgain: "Try again", // DOC
  added: "Added", // PROPOSED: "Added Oct 27"
  file: "File", // PROPOSED: marks a source with a stored file
  deleteSourceOnly: "Delete source only", // DOC
  deleteEverything: "Delete source and everything from it", // DOC
  exportButton: "Export data (JSON)", // DOC
  exportHint: "One file with everything you've added and every thread, decision and setting.", // PROPOSED
  exporting: "Preparing your export…", // PROPOSED (§2.14 "Export in progress")
  exportReady: "Your export has downloaded.", // PROPOSED
  exportFailed: "I couldn't prepare your export. Try again.", // PROPOSED
  deleteAccountButton: "Delete account…", // DOC
  accountHeading: "Account", // PROPOSED

  // Shared dialog parts
  cancel: "Cancel", // DOC (DESIGN_STANDARD confirmation dialogs)
  willDelete: "This deletes:", // PROPOSED
  willStay: "This stays:", // PROPOSED
  cannotUndo: "You can't undo this.", // PROPOSED

  // Delete source only
  sourceOnlyTitle: "Delete source only?", // PROPOSED
  sourceOnlyDeletes: [
    "The source's text, and its file if you uploaded one",
    "Its document summary",
    "Suggestions from it that you haven't accepted",
  ], // PROPOSED
  sourceOnlyStays: ["Threads you accepted from it, with their quotes. Their source line will read “Source deleted”."], // PROPOSED
  sourceDeleted: "Source deleted.", // PROPOSED (status after success)
  sourceFileRemains: "Your source was deleted, but its file hasn't been removed yet. Try again, or it will be removed automatically within a day.", // PROPOSED (S11-D2; rows gone, Storage failed)

  // Delete source and everything from it
  everythingTitle: "Delete source and everything from it?", // PROPOSED
  everythingDeletes: [
    "The source's text, and its file if you uploaded one",
    "Its document summary and all its suggestions",
    "Every thread that came from it, with its quotes, history, decision and reason",
  ], // PROPOSED
  everythingStays: ["A one-way fingerprint of each thread, so the same item isn't suggested again"], // PROPOSED (D29)
  everythingDeleted: (n: number) => (n === 1 ? "Source and 1 thread deleted." : `Source and ${n} threads deleted.`), // PROPOSED

  // Forget permanently (Thread detail)
  moreActions: "More actions", // DOC (§2.7, DESIGN_STANDARD overflow menu)
  forgetMenu: "Forget permanently…", // DOC
  forgetTitle: "Forget this thread permanently?", // PROPOSED
  forgetDeletes: [
    "This thread, its history and any decision and reason",
    "Its quotes",
    "The suggestion it came from, and any summary lines that quote it",
  ], // PROPOSED (D29, D35)
  forgetStays: ["A one-way fingerprint, so the same item isn't suggested again"], // PROPOSED (D29)
  alsoDeleteSource: "Also delete source", // DOC
  alsoDeleteSourceHint: "Its text and file, its summary, and its other suggestions. Other threads from it keep their quotes.", // PROPOSED
  forgetButton: "Forget permanently", // DOC (glossary)
  forgetFileRemains: "This thread was forgotten, but a file hasn't been removed yet. Try again, or it will be removed automatically within a day.", // PROPOSED (S11-D2 pattern; rows gone, Storage failed)

  // Delete account
  accountTitle: "Delete your account?", // PROPOSED
  accountDeletes: ["Every source and uploaded file", "Every thread, decision and reason", "Your settings and your sign-in"], // PROPOSED
  accountBackups: "Backups held by our hosting platform expire on its own schedule.", // PROPOSED (PRD Privacy & Security wording)
  accountConfirmLabel: "Type delete to confirm", // PROPOSED (CONTENT_MODEL: confirmation requires typing `delete`)
  accountConfirmError: "Type delete to confirm.", // PROPOSED
  accountButton: "Delete account", // PROPOSED
  accountDeleteUnconfirmed: "I couldn't confirm whether your account was deleted. Try again in a few minutes.", // PROPOSED (Auth didn't answer; being signed out proves nothing, S11-D7; rule 10)
  accountDeleted: "Your account and everything in it were deleted.", // PROPOSED (sign-in page after deletion)
  // PROPOSED: the account is gone but the final file sweep or the audit log purge failed; no retry is possible (rules 9, 10).
  accountDeletedRecordsRemain: "Your account was deleted. Sign-in records with your email address are still stored and will be removed automatically.",
  accountDeletedFilesRemain: "Your account was deleted. Some of your files are still stored and will be removed automatically.",
  accountDeletedBothRemain: "Your account was deleted. Some of your files and sign-in records with your email address are still stored and will be removed automatically.",
} as const;
