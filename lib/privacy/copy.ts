/**
 * Copy for the public `/privacy` page (D77, D82; SITE_CONTRACT §2.15).
 *
 * Every sentence is the "Text (approved Nov 8)" column of docs/PRIVACY.md, in order, under its section
 * headings. The user approved the wording of P1–P33 on Nov 8 (relayed by the coordinator).
 * tests/unit/privacy-copy.test.ts checks this file against the doc, so change both together.
 *
 * Inline markup is the doc's own: `**bold**` for the names of controls and providers, and
 * `[text](url)` for links. components/privacy/PrivacyText.tsx renders those two forms and nothing
 * else. The page reads no environment variable and no clock: everything below is fixed at build.
 */

/** P2. A fixed date, set when the text changes; not getNow(). */
export const PRIVACY_LAST_UPDATED = "Nov 8, 2026";

/** P33. Given by the user on Nov 8 (relayed). The ship-gate test fails while this is a placeholder. */
export const SUPPORT_EMAIL = "info@piscesparadigm.ca";

/**
 * P11–P13. "full" while production sends analytics (ANALYTICS_ENABLED and POSTHOG_KEY set in
 * Vercel Production; user, Nov 8). "off" replaces section 3 with ANALYTICS_OFF_TEXT and drops P31.
 */
export const ANALYTICS_COPY: "full" | "off" = "full";
export const ANALYTICS_OFF_TEXT = "Loose Ends doesn't send analytics right now.";

/** P17. Paid tier confirmed (D81; coordinator, Nov 8). */
export const GEMINI_TIER_TEXT =
  "Loose Ends uses Gemini's paid tier. Google's terms for it say Google doesn't use what you send, or its answers, to improve its products. Google may keep them for a limited time to detect abuse, as its terms describe: [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms).";

export interface PrivacySentence {
  id: string;
  text: string;
}
export interface PrivacySection {
  /** As in docs/PRIVACY.md, number included: P30 and P31 refer to sections by number. */
  heading: string;
  sentences: PrivacySentence[];
}

const ANALYTICS_FULL: PrivacySentence[] = [
  {
    id: "P11",
    text: "If analytics is on, Loose Ends tells PostHog which features you use. Each event carries IDs, fixed categories and counts. It never includes what you paste, titles, quotes, names or reasons.",
  },
  { id: "P12", text: "Analytics is on unless you turn it off in Settings." },
  {
    id: "P13",
    text: "Events are sent from the Loose Ends server, tied to your account ID only, with location lookup turned off.",
  },
];

export function privacySections(analytics: "full" | "off" = ANALYTICS_COPY): PrivacySection[] {
  const handlers: PrivacySentence[] = [
    { id: "P28", text: "**Supabase:** database, sign-in, file storage and sign-in emails." },
    { id: "P29", text: "**Vercel:** hosting, the daily job and app logs." },
    {
      id: "P30",
      text: "**Google:** the Gemini API reads what you add and what you ask (section 4), and Google sign-in, if you use it.",
    },
  ];
  if (analytics === "full") handlers.push({ id: "P31", text: "**PostHog (US):** analytics, if it is on (section 3)." });

  return [
    {
      heading: "1. About this page",
      sentences: [
        {
          id: "P1",
          text: "This page says what Loose Ends stores, who else handles it, and what deleting removes. It describes what the app does today.",
        },
        { id: "P2", text: `Last updated: ${PRIVACY_LAST_UPDATED}.` },
      ],
    },
    {
      heading: "2. What Loose Ends stores",
      sentences: [
        { id: "P3", text: "Your email address, so you can sign in." },
        {
          id: "P4",
          text: "If you sign in with Google, Google shares your name, email address and profile picture. Loose Ends asks for nothing else from your Google account, and it can't read your Gmail, calendar or contacts.",
        },
        { id: "P5", text: "Everything you add: text you paste, files you upload and the text read from them." },
        {
          id: "P6",
          text: "What Loose Ends finds in it: suggestions, a summary of each document, the threads you accept, their quotes and history, and any decisions and reasons you record.",
        },
        {
          id: "P7",
          text: "Your settings: your name, the other names and emails you gave so Loose Ends can tell which tasks are yours, your timezone, and your analytics choice.",
        },
        { id: "P8", text: "Daily counts of how much you added and asked, for the daily limits." },
        { id: "P9", text: "Your text is kept until you delete it or your account. Nothing is deleted automatically." },
        {
          id: "P10",
          text: "Supabase, which runs sign-in, can record sign-in events, in the database and in its own logs.",
        },
      ],
    },
    {
      heading: "3. Analytics",
      sentences: analytics === "full" ? ANALYTICS_FULL : [{ id: "P11", text: ANALYTICS_OFF_TEXT }],
    },
    {
      heading: "4. What the AI sees",
      sentences: [
        {
          id: "P14",
          text: "When you paste text or upload a file, Loose Ends sends its text to Google's Gemini API to find what's still open. With it go the names and emails you gave, your timezone, the date the text was written, and the titles of up to 30 of your open threads.",
        },
        {
          id: "P15",
          text: "When you ask why, Loose Ends sends your question and the recorded decisions that match it: each one's thread title, the person involved, what you decided, your reason, the date and its quotes. If nothing matches, nothing is sent.",
        },
        {
          id: "P16",
          text: "Loose Ends doesn't remove anything from your text before sending it, so don't paste passwords or full account numbers.",
        },
        { id: "P17", text: GEMINI_TIER_TEXT },
      ],
    },
    {
      heading: "5. Deleting",
      sentences: [
        {
          id: "P18",
          text: "**Forget permanently** deletes a thread, its history and any decision and reason, its quotes, the suggestion it came from, and any summary lines that quote it. A one-way fingerprint stays, so the same item isn't suggested again.",
        },
        {
          id: "P19",
          text: "**Delete source only** deletes the source's text and its file, its summary, and suggestions you haven't accepted. Threads you accepted from it keep their quotes.",
        },
        {
          id: "P20",
          text: "**Delete source and everything from it** also deletes every thread that came from it, with its quotes, history, decision and reason. A one-way fingerprint of each thread stays.",
        },
        {
          id: "P21",
          text: "**Delete account** deletes every source and uploaded file, every thread, decision and reason, your settings and your sign-in. It also deletes the sign-in records in Supabase's database that name you.",
        },
        {
          id: "P22",
          text: "If a file or sign-in record can't be removed straight away, Loose Ends tells you, and a daily job removes it. Until the sign-in records are gone, that job keeps your email address so it can find them.",
        },
      ],
    },
    {
      heading: "6. What deleting can't reach",
      sentences: [
        {
          id: "P23",
          text: "Supabase's own platform logs keep records of requests, including your account ID. Loose Ends can't delete them. They expire on Supabase's schedule.",
        },
        { id: "P24", text: "Backups held by our hosting platform expire on its own schedule." },
        {
          id: "P25",
          text: "When something fails, the app logs it with IDs, codes and counts, not your content. Vercel keeps these logs for a limited time.",
        },
        {
          id: "P26",
          text: "Google, Vercel and PostHog keep what they received under their own terms. Deleting your account doesn't reach them.",
        },
      ],
    },
    {
      heading: "7. Export",
      sentences: [
        {
          id: "P27",
          text: "**Export data (JSON)** in Settings downloads one file with your sources and their text, suggestions, summaries, threads, quotes, history, decisions, settings, fingerprints and daily counts. Uploaded files aren't in it, but their text is.",
        },
      ],
    },
    { heading: "8. Who else handles your data", sentences: handlers },
    {
      heading: "9. Cookies",
      sentences: [
        {
          id: "P32",
          text: "Loose Ends uses cookies only to keep you signed in, plus one that lasts two minutes and shows the notice after you delete your account. No advertising or tracking cookies.",
        },
      ],
    },
    {
      heading: "10. Contact",
      sentences: [{ id: "P33", text: `Questions or requests: [${SUPPORT_EMAIL}](mailto:${SUPPORT_EMAIL}).` }],
    },
  ];
}

export const PRIVACY_COPY = {
  heading: "Privacy", // SITE_CONTRACT §2.15 (PROPOSED there)
  title: "Privacy", // with the layout template: "Privacy · Loose Ends"
  linkLabel: "Privacy", // sign-in footer and Settings → Data (SITE_CONTRACT §2.0, §2.12; PROPOSED there)
} as const;

/** Rule 9 (CLAUDE.md): never on any page. */
export const BANNED_PRIVACY_PHRASES = ["fully private", "zero retention", "end-to-end encrypted"] as const;
