import { Fragment, type ReactNode } from "react";

/** `**bold**` or `[text](url)`, the only inline markup in lib/privacy/copy.ts. */
const INLINE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

// Inline links inside a sentence (the WCAG 2.5.8 inline exception), so no 44px box.
const LINK_CLASS = "focus-ring rounded-control text-le-accent underline underline-offset-3 break-words";

/** Splits a sentence into text, `<strong>` and links. The link text is the link's accessible name. */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <strong key={m.index} className="font-medium text-le-text">
          {m[1]}
        </strong>,
      );
    } else {
      const href = m[3] ?? "";
      const external = /^https:\/\//.test(href);
      out.push(
        <a key={m.index} href={href} className={LINK_CLASS} {...(external ? { rel: "noreferrer" } : {})}>
          {m[2]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}

/** The visible text of a sentence, markup removed (tests and the banned-phrases check). */
export function plainText(text: string): string {
  return text.replace(INLINE, (_m, bold?: string, linkText?: string) => bold ?? linkText ?? "");
}
