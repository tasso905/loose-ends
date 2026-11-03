"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PenLine } from "lucide-react";
import { NoReason } from "@/components/decisions/NoReason";
import { RESOLVE_COPY } from "@/lib/threads/resolve";

/**
 * The reason part of Thread detail's Decision block (SITE_CONTRACT §2.7 as amended by D58): the
 * user's reason verbatim in the You wrote voice, or `You didn't record a reason for this decision.`
 * with `Add a reason now` (the same form and action as Ask why). After the server confirms, the
 * reason shows here and the page refreshes so History gains its line.
 */
export function DecisionReason({ decisionId, reason, date }: { decisionId: string; reason: string | null; date: string }) {
  const router = useRouter();
  const [added, setAdded] = useState<string | null>(null);
  const shown = reason ?? added;
  if (shown === null) {
    return (
      <div className="mt-4">
        <NoReason
          decisionId={decisionId}
          onAdded={(text) => {
            setAdded(text);
            router.refresh();
          }}
        />
      </div>
    );
  }
  return (
    <figure id={`reason-${decisionId}`} tabIndex={-1} className="focus-ring mt-4 rounded-r-control border-l-2 border-le-border-strong pl-4">
      <figcaption className="flex items-center gap-1 text-label text-le-text-secondary">
        <PenLine aria-hidden strokeWidth={1.75} className="size-3.5" />
        {RESOLVE_COPY.youWrote} · {date}
      </figcaption>
      <blockquote className="mt-1 text-body whitespace-pre-wrap text-le-text">{shown}</blockquote>
    </figure>
  );
}
