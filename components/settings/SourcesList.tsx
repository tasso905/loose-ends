"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { deleteSourceAction } from "@/app/settings/data-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { DATA_COPY as C } from "@/lib/account/copy";
import { apiError } from "@/lib/errors";

export interface SourceRow {
  id: string;
  name: string;
  added: string;
  hasFile: boolean;
}

type Pending = { source: SourceRow; everything: boolean } | null;

/**
 * Settings → Data sources list (SITE_CONTRACT §2.12, PRD F13, CONTENT_MODEL "Delete source"): two
 * delete options per source, each confirmed with what is deleted and what stays (D8; no undo). The
 * row leaves the list only after the server confirms (rule 10); then a status line says so and
 * focus moves to the list heading, since the button that had it is gone.
 */
export function SourcesList({ sources, headingId }: { sources: SourceRow[]; headingId: string }) {
  const router = useRouter();
  const [target, setTarget] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [pending, startTransition] = useTransition();
  const trigger = useRef<HTMLButtonElement | null>(null);

  const shown = sources.filter((s) => !gone.has(s.id));

  function open(source: SourceRow, everything: boolean, button: HTMLButtonElement) {
    trigger.current = button;
    setError(null);
    setTarget({ source, everything });
  }

  // Where focus goes once the dialog has closed: the trigger after Cancel, the list heading after a
  // deletion (the row and its button are gone).
  const focusAfter = useRef<"trigger" | "heading">("trigger");

  function cancel() {
    focusAfter.current = "trigger";
    setTarget(null);
  }

  function closed() {
    if (focusAfter.current === "heading") document.getElementById(headingId)?.focus();
    else trigger.current?.focus();
  }

  function confirm() {
    if (!target) return;
    const { source, everything } = target;
    setError(null);
    startTransition(async () => {
      try {
        const res = await deleteSourceAction(source.id, everything);
        if (!res.ok) {
          setError(res.error.message);
          return;
        }
        focusAfter.current = "heading";
        setGone((g) => new Set(g).add(source.id));
        setTarget(null);
        setStatus(everything ? C.everythingDeleted(res.threadsForgotten) : C.sourceDeleted);
        router.refresh();
      } catch {
        setError(apiError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "save_failed").error.message);
      }
    });
  }

  return (
    <div>
      <p role="status" className="text-body text-le-text empty:hidden">
        {status}
      </p>
      {shown.length === 0 ? (
        <p className="mt-2 text-body text-le-text-secondary">{C.noSources}</p>
      ) : (
        <ul className="mt-2 divide-y divide-le-border rounded-card border border-le-border bg-le-surface">
          {shown.map((s) => (
            <li key={s.id} className="p-4">
              <p className="text-body-strong text-le-text">{s.name}</p>
              <p className="mt-1 flex items-center gap-2 text-small text-le-text-secondary">
                <span>
                  {C.added} {s.added}
                </span>
                {s.hasFile ? (
                  <span className="inline-flex items-center gap-1">
                    · <FileText aria-hidden strokeWidth={1.75} className="size-3.5" />
                    {C.file}
                  </span>
                ) : null}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  aria-label={`${C.deleteSourceOnly}: ${s.name}`}
                  onClick={(e) => open(s, false, e.currentTarget)}
                >
                  {C.deleteSourceOnly}
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  aria-label={`${C.deleteEverything}: ${s.name}`}
                  onClick={(e) => open(s, true, e.currentTarget)}
                >
                  {C.deleteEverything}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={target !== null}
        title={target?.everything ? C.everythingTitle : C.sourceOnlyTitle}
        deletes={target?.everything ? C.everythingDeletes : C.sourceOnlyDeletes}
        stays={target?.everything ? C.everythingStays : C.sourceOnlyStays}
        confirmLabel={target?.everything ? C.deleteEverything : C.deleteSourceOnly}
        pending={pending}
        error={error}
        onCancel={cancel}
        onConfirm={confirm}
        onClosed={closed}
      >
        {target ? <p className="text-body-strong text-le-text">{target.source.name}</p> : null}
      </ConfirmDialog>
    </div>
  );
}
