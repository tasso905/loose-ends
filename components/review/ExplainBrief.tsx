import { Quote } from "lucide-react";
import { z } from "zod";
import { cn } from "@/lib/utils";

/**
 * The stored, verified document brief shown in the Review Tray zero state (F6: "Nothing here needs
 * your attention" plus the brief if one exists). Source lines show only their verified quote (Source
 * fact voice); interpretation lines are labelled `Interpretation` (DESIGN_STANDARD "Three voices").
 * Rendered from stored fields only (rule 6). The full Explain card is F7.
 */

const Line = z.object({
  text: z.string(),
  basis: z.enum(["source", "interpretation"]),
  quote: z.string().nullable(),
});
const StoredBrief = z.object({
  what_this_is: z.array(Line).default([]),
  what_to_do: z.array(Line).default([]),
  by_when: z.array(Line).default([]),
  if_you_dont: z.array(Line).default([]),
  worth_considering: z.array(Line).default([]),
  not_sure_about: z.array(z.string()).default([]),
});
type StoredBrief = z.infer<typeof StoredBrief>;

const SECTIONS: Array<{ key: Exclude<keyof StoredBrief, "not_sure_about">; title: string }> = [
  { key: "what_this_is", title: "What this is" },
  { key: "what_to_do", title: "What you need to do" },
  { key: "by_when", title: "By when" },
  { key: "if_you_dont", title: "If you don't" },
  { key: "worth_considering", title: "Worth considering" },
];

/** null when there is no brief, or nothing in it that can be shown. */
export function parseBrief(brief: unknown): StoredBrief | null {
  const parsed = StoredBrief.safeParse(brief);
  if (!parsed.success) return null;
  const b = parsed.data;
  // Rule 1: a source line without its verified quote is never shown.
  const clean = Object.fromEntries(
    SECTIONS.map(({ key }) => [key, b[key].filter((l) => l.basis === "interpretation" || (l.quote ?? "").trim() !== "")]),
  ) as Omit<StoredBrief, "not_sure_about">;
  const out = { ...clean, not_sure_about: b.not_sure_about };
  const empty = SECTIONS.every(({ key }) => out[key].length === 0) && out.not_sure_about.length === 0;
  return empty ? null : out;
}

export function ExplainBrief({ brief, className }: { brief: unknown; className?: string }) {
  const b = parseBrief(brief);
  if (!b) return null;
  return (
    <section aria-label="About this document" className={cn("space-y-6 rounded-card border border-le-border bg-le-surface p-4 sm:p-5", className)}>
      {SECTIONS.map(({ key, title }) =>
        b[key].length === 0 ? null : (
          <div key={key}>
            <h2 className="text-eyebrow text-le-text-tertiary uppercase">{title}</h2>
            <ul className="mt-3 space-y-3">
              {b[key].map((line, i) =>
                line.basis === "source" ? (
                  <li key={i}>
                    <figure className="rounded-r-control border-l-2 border-(--le-evidence-rule) bg-(--le-evidence-bg) px-4 py-3">
                      <figcaption className="flex items-center gap-1 text-label text-le-text-secondary">
                        <Quote aria-hidden strokeWidth={1.75} className="size-3.5" />
                        Pasted text
                      </figcaption>
                      <blockquote className="mt-1 font-serif text-body text-le-text">{line.quote}</blockquote>
                    </figure>
                  </li>
                ) : (
                  <li key={i} className="border-l-2 border-dashed border-le-border-strong pl-3">
                    <p className="text-label text-le-text-secondary">Interpretation</p>
                    <p className="text-body text-le-text-secondary">{line.text}</p>
                  </li>
                ),
              )}
            </ul>
          </div>
        ),
      )}
      {b.not_sure_about.length > 0 ? (
        <div className="rounded-control bg-(--le-maybe-bg) px-4 py-3">
          <h2 className="text-eyebrow text-le-text-secondary uppercase">Not sure about</h2>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-small text-le-text">
            {b.not_sure_about.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
