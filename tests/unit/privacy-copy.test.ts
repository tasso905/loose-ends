import { readFileSync } from "node:fs";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "@/app/privacy/page";
import { plainText, renderInline } from "@/components/privacy/PrivacyText";
import {
  ANALYTICS_COPY,
  ANALYTICS_OFF_TEXT,
  BANNED_PRIVACY_PHRASES,
  PRIVACY_LAST_UPDATED,
  SUPPORT_EMAIL,
  privacySections,
} from "@/lib/privacy/copy";

const DOC = readFileSync(new URL("../../docs/PRIVACY.md", import.meta.url), "utf8");

/** Sections and P-rows of docs/PRIVACY.md: `## N. Heading`, then `| P# | Proposed text | … |`. */
function docSections() {
  const sections: { heading: string; rows: { id: string; text: string }[] }[] = [];
  for (const line of DOC.split("\n")) {
    const h = /^## (\d+\. .+)$/.exec(line);
    if (h?.[1]) sections.push({ heading: h[1].trim(), rows: [] });
    const r = /^\| (P\d+) \| (.+?) \| /.exec(line);
    if (r?.[1] && r[2] && sections.length) sections.at(-1)!.rows.push({ id: r[1], text: r[2] });
  }
  return sections;
}

/** The doc's {date} placeholder and plain P33 address, in the form the copy module holds them. */
const fill = (t: string) =>
  t.replace("{date}", PRIVACY_LAST_UPDATED).replace(SUPPORT_EMAIL, `[${SUPPORT_EMAIL}](mailto:${SUPPORT_EMAIL})`);

const html = (text: string) => renderToStaticMarkup(createElement(Fragment, null, ...renderInline(text)));

describe("/privacy copy matches docs/PRIVACY.md (D82)", () => {
  it("every table's second column is the approved text", () => {
    const headers = DOC.split("\n").filter((l) => l.startsWith("| # |"));
    expect(headers).toHaveLength(10);
    for (const h of headers) expect(h).toBe("| # | Text (approved Nov 8) | Evidence | Check |");
  });

  it("P33 in the doc is the address the page uses", () => {
    expect(DOC).toContain(`| P33 | Questions or requests: ${SUPPORT_EMAIL}. |`);
  });

  it("the doc has sections 1–10 and P1–P33", () => {
    const s = docSections();
    expect(s.map((x) => x.heading.split(".")[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(s.flatMap((x) => x.rows.map((r) => r.id))).toEqual(Array.from({ length: 33 }, (_, i) => `P${i + 1}`));
  });

  it("with full analytics, every heading and sentence is the doc's approved text, in order", () => {
    const page = privacySections("full").map((s) => ({ heading: s.heading, rows: s.sentences }));
    const doc = docSections().map((s) => ({ heading: s.heading, rows: s.rows.map((r) => ({ id: r.id, text: fill(r.text) })) }));
    expect(page).toEqual(doc);
  });

  it("the page ships the full analytics text (user, Nov 8)", () => {
    expect(ANALYTICS_COPY).toBe("full");
    expect(privacySections()).toEqual(privacySections("full"));
  });

  it("with analytics off, section 3 is the one replacement sentence and P31 is dropped", () => {
    const off = privacySections("off");
    const s3 = off.find((s) => s.heading === "3. Analytics")!;
    expect(s3.sentences.map((p) => p.text)).toEqual([ANALYTICS_OFF_TEXT]);
    expect(ANALYTICS_OFF_TEXT).toBe("Loose Ends doesn't send analytics right now."); // docs/PRIVACY.md P11 Check
    expect(DOC).toContain(`"${ANALYTICS_OFF_TEXT}"`);
    expect(off.flatMap((s) => s.sentences.map((p) => p.id))).not.toContain("P31");
  });

  it("P2 is a fixed date in the decision-date style", () => {
    expect(PRIVACY_LAST_UPDATED).toMatch(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}$/);
  });
});

describe("/privacy rendering", () => {
  it("bold becomes <strong>, links keep their text as the accessible name", () => {
    expect(html("**Delete account** deletes")).toBe('<strong class="font-medium text-le-text">Delete account</strong> deletes');
    const p17 = html(privacySections().flatMap((s) => s.sentences).find((p) => p.id === "P17")!.text);
    expect(p17).toMatch(/<a href="https:\/\/aistudio\.google\.com\/docs\/terms" class="[^"]*" rel="noreferrer">Gemini API Additional Terms of Service<\/a>\.$/);
  });

  it("P33 is a mailto link whose visible text is the address", () => {
    const p33 = privacySections().at(-1)!.sentences[0]!;
    expect(html(p33.text)).toMatch(new RegExp(`^Questions or requests: <a href="mailto:${SUPPORT_EMAIL}" class="[^"]*">${SUPPORT_EMAIL.replace(/\./g, "\\.")}</a>\\.$`));
    expect(plainText(p33.text)).toBe(`Questions or requests: ${SUPPORT_EMAIL}.`);
  });

  it("the page renders the heading, every section and no leftover markup", () => {
    const page = renderToStaticMarkup(createElement(PrivacyPage));
    expect(page).toContain('<h1 class="');
    expect(page).toContain(">Privacy</h1>");
    for (const s of privacySections()) expect(page).toContain(`>${s.heading.replace(/'/g, "&#x27;")}</h2>`);
    expect(page).not.toMatch(/\*\*|\]\(|\{date\}|\{support email\}/);
    expect(page).not.toMatch(/<(em|i)\b|italic/); // DESIGN_STANDARD: no italics
    expect(page).toContain('href="/sign-in"');
  });
});

describe("rule 9: no banned privacy phrase", () => {
  const pageText = privacySections("full")
    .concat(privacySections("off"))
    .flatMap((s) => [s.heading, ...s.sentences.map((p) => plainText(p.text))])
    .join("\n")
    .toLowerCase();
  it.each(BANNED_PRIVACY_PHRASES)("“%s” is not on the page or in docs/PRIVACY.md", (phrase) => {
    expect(pageText).not.toContain(phrase);
    expect(renderToStaticMarkup(createElement(PrivacyPage)).toLowerCase()).not.toContain(phrase);
    expect(DOC.toLowerCase()).not.toContain(phrase);
  });
});

describe("ship gate", () => {
  it("P33's support email is a real address, not a placeholder", () => {
    expect(SUPPORT_EMAIL).toMatch(/^[^\s@{}<>]+@[^\s@{}<>]+\.[a-z]{2,}$/i);
    expect(SUPPORT_EMAIL).not.toMatch(/example\.(com|org|net)$|placeholder|todo|\{/i);
  });
});
