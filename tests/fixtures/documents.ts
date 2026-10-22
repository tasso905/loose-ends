import { imagePdf, textPdf } from "./pdf";

/**
 * Synthetic upload fixtures (no real issuer, person or account). The renewal notice is the demo's
 * "insurance PDF" (PRD Hackathon Demo Plan) with an invented insurer, and three issuer kinds cover
 * F3's "insurance, utility, government" text-layer criterion.
 */

export const RENEWAL_PAGES = [
  [
    "Harbor Mutual Insurance (synthetic example)",
    "Policy renewal notice for policy HM-000-TEST",
    "Your home policy renews on October 31, 2026.",
    "Your annual premium will change from $1,200 to $1,470.",
  ],
  [
    "What you need to do",
    "If you want to keep this policy, no action is needed and it will auto-renew.",
    "To cancel or change your cover, call us before October 31, 2026.",
    "If you do nothing, the new premium of $1,470 will be charged.",
  ],
];

export const UTILITY_PAGES = [
  [
    "Riverbend Water Utility (synthetic example)",
    "Account 0000-TEST statement for September",
    "Amount due: $86.40. Please pay by October 20, 2026.",
    "A late fee of $10 applies to payments received after the due date.",
  ],
];

export const GOVERNMENT_PAGES = [
  [
    "Department of Motor Vehicles of Example State (synthetic)",
    "Notice: your vehicle registration expires on November 15, 2026.",
    "Renew online or at any office before that date to avoid a $25 penalty.",
  ],
];

export const renewalPdf = () => textPdf(RENEWAL_PAGES);
export const utilityPdf = () => textPdf(UTILITY_PAGES);
export const governmentPdf = () => textPdf(GOVERNMENT_PAGES);
export const scannedPdf = () => imagePdf(2);

/** The text readDocument() produces for a textPdf: lines joined by \n, pages by a blank line. */
export const pdfText = (pages: string[][]) => pages.map((lines) => lines.join("\n")).join("\n\n");
