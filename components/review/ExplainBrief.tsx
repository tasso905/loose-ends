import { Quote } from "lucide-react";
import { z } from "zod";
import { sourceCaption, type SourceRef } from "@/lib/threads/view";
import { cn } from "@/lib/utils";

/**
 * The Explain card (F7; DESIGN_STANDARD "Explain card"; CONTENT_MODEL §6), rendered from the stored,
 * verified document brief only (rule 6: nothing is regenerated at view time). Used on Thread
 * detail and in the Review Tray zero state (F6: "Nothing here needs your attention" plus the brief).
 *
 * - Source lines show only their verified quote (Source fact voice, Plex Serif) under a `Quote`
 *   label naming the source and page; the model's paraphrase of a source line is never shown.
 * - Interpretation lines are labelled `Interpretation` (Interpretation voice).
 * - "Not sure about" sits on the Maybe fill and also lists `notSure` lines from the thread itself.
 * - "Worth considering" is not rendered: deferred to the Oct 25 scope review (D18; coordinator,
 *   Oct 21). The schema field and the stored lines are kept.
 * - Card title `About this document` is PROPOSED copy (DESIGN_STANDARD gives the card an h2 title
 *   but not its words).
 */

export const EXPLAIN_COPY = {
  /** PROPOSED. */
  title: "About this document",
  whatThisIs: "What this is",
  whatToDo: "What you need to do",
  byWhen: "By when",
  ifYouDont: "If you don't",
  worthConsidering: "Worth considering",
  notSureAbout: "Not sure about",
  interpretation: "Interpretation",
} as const;

const Line = z.object({
  text: z.string(),
  basis: z.enum(["source", "interpretation"]),
  quote: z.string().nullable(),
  page: z.number().int().positive().nullable().optional(),
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
type SectionKey = Exclude<keyof StoredBrief, "not_sure_about">;

/** D18 is undecided; the coordinator deferred the section for the Oct 23 slice. */
export const SHOW_WORTH_CONSIDERING = false;

const SECTIONS: Array<{ key: SectionKey; title: string }> = [
  { key: "what_this_is", title: EXPLAIN_COPY.whatThisIs },
  { key: "what_to_do", title: EXPLAIN_COPY.whatToDo },
  { key: "by_when", title: EXPLAIN_COPY.byWhen },
  { key: "if_you_dont", title: EXPLAIN_COPY.ifYouDont },
  ...(SHOW_WORTH_CONSIDERING ? [{ key: "worth_considering" as const, title: EXPLAIN_COPY.worthConsidering }] : []),
];

/** null when there is no brief, or nothing in it that can be shown. */
export function parseBrief(brief: unknown): StoredBrief | null {
  const parsed = StoredBrief.safeParse(brief);
  if (!parsed.success) return null;
  const b = parsed.data;
  // Rule 1: a source line without its verified quote is never shown.
  const clean = Object.fromEntries(
    (Object.keys(b) as Array<keyof StoredBrief>)
      .filter((k): k is SectionKey => k !== "not_sure_about")
      .map((key) => [key, b[key].filter((l) => l.basis === "interpretation" || (l.quote ?? "").trim() !== "")]),
  ) as Omit<StoredBrief, "not_sure_about">;
  const out = { ...clean, not_sure_about: b.not_sure_about };
  const empty = SECTIONS.every(({ key }) => out[key].length === 0) && out.not_sure_about.length === 0;
  return empty ? null : out;
}

/** Lines in order, without repeats (a brief and its item can both note the same doubt). */
export function mergeNotSure(...lists: Array<readonly string[] | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lists.flatMap((l) => l ?? [])) {
    const key = line.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(line.trim());
  }
  return out;
}

export function ExplainBrief({
  brief,
  source,
  notSure,
  className,
}: {
  brief: unknown;
  /** The brief's source, for the label above each quote; omitted: `Pasted text`. */
  source?: SourceRef | null;
  /** Extra "Not sure about" lines (the thread's own item and date notes). */
  notSure?: readonly string[];
  className?: string;
}) {
  const b = parseBrief(brief);
  if (!b) return null;
  const doubts = mergeNotSure(b.not_sure_about, notSure);
  return (
    <section aria-labelledby="explain-title" className={cn("rounded-card border border-le-border bg-le-surface p-4 sm:p-5", className)}>
      <h2 id="explain-title" className="text-h2 text-le-text">
        {EXPLAIN_COPY.title}
      </h2>
      <div className="mt-4 space-y-6">
        {SECTIONS.map(({ key, title }) =>
          b[key].length === 0 ? null : (
            <div key={key}>
              <h3 className="text-eyebrow text-le-text-tertiary uppercase">{title}</h3>
              <ul className="mt-3 space-y-3">
                {b[key].map((line, i) =>
                  line.basis === "source" ? (
                    <li key={i}>
                      <figure className="rounded-r-control border-l-2 border-(--le-evidence-rule) bg-(--le-evidence-bg) px-4 py-3">
                        <figcaption className="flex items-center gap-1 text-label text-le-text-secondary">
                          <Quote aria-hidden strokeWidth={1.75} className="size-3.5" />
                          {source === undefined ? "Pasted text" : sourceCaption(source, line.page ?? null)}
                        </figcaption>
                        <blockquote className="mt-1 font-serif text-body text-le-text">{line.quote}</blockquote>
                      </figure>
                    </li>
                  ) : (
                    <li key={i} className="border-l-2 border-dashed border-le-border-strong pl-3">
                      <p className="text-label text-le-text-secondary">{EXPLAIN_COPY.interpretation}</p>
                      <p className="text-body text-le-text-secondary">{line.text}</p>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ),
        )}
        {doubts.length > 0 ? <NotSureList lines={doubts} /> : null}
      </div>
    </section>
  );
}

export function NotSureList({ lines }: { lines: readonly string[] }) {
  return (
    <div className="rounded-control bg-(--le-maybe-bg) px-4 py-3">
      <h3 className="text-eyebrow text-le-text-secondary uppercase">{EXPLAIN_COPY.notSureAbout}</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-small text-le-text">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
