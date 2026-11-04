"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ellipsis, Trash2 } from "lucide-react";
import { forgetAction } from "@/app/threads/[id]/actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { DATA_COPY as C } from "@/lib/account/copy";
import { apiError } from "@/lib/errors";

/**
 * Thread detail's `More actions` overflow menu (SITE_CONTRACT §2.7, DESIGN_STANDARD "Overflow
 * menu") with `Forget permanently…` as its destructive item, which opens the confirmation (D8): what
 * is deleted, what stays (the suppression hash, D29), and the optional `Also delete source` when the
 * thread still has one. Forget runs only from the dialog; on success the thread is gone, so the
 * page moves to Threads. Errors stay in the dialog (rule 10). Other overflow items (Mark waiting,
 * Snooze, Edit, Dismiss, Reopen) join this menu when they ship.
 */
export function ForgetThread({ threadId, hasSource }: { threadId: string; hasSource: boolean }) {
  const router = useRouter();
  const ids = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [alsoSource, setAlsoSource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  // The thread is gone though a file failed: closing the dialog can't return to this page.
  const rowsGone = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    itemRef.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && e.target !== triggerRef.current) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  function closeMenu(focusTrigger: boolean) {
    setMenuOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }

  function openDialog() {
    setMenuOpen(false);
    setAlsoSource(false);
    setError(null);
    setDialogOpen(true);
  }

  function cancel() {
    setDialogOpen(false);
    if (rowsGone.current) router.replace("/threads");
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await forgetAction(threadId, hasSource && alsoSource);
        if (!res.ok) {
          if (res.error.code === "not_found") {
            // Already gone (another tab): nothing left to forget here.
            router.replace("/threads");
            return;
          }
          if (res.rowsGone) rowsGone.current = true;
          setError(res.error.message);
          return;
        }
        router.replace("/threads");
      } catch {
        setError(apiError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "save_failed").error.message);
      }
    });
  }

  return (
    <div className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="small"
        aria-label={C.moreActions}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? `${ids}-menu` : undefined}
        onClick={() => setMenuOpen((o) => !o)}
      >
        <Ellipsis aria-hidden strokeWidth={1.75} />
      </Button>
      {menuOpen ? (
        <div
          ref={menuRef}
          id={`${ids}-menu`}
          role="menu"
          aria-label={C.moreActions}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Tab") {
              e.preventDefault();
              closeMenu(true);
            }
          }}
          className="absolute right-0 z-10 mt-1 min-w-50 rounded-card border border-le-border bg-le-surface-raised py-1 shadow-(--le-shadow-modal)"
        >
          <button
            ref={itemRef}
            type="button"
            role="menuitem"
            onClick={openDialog}
            className="focus-ring flex h-9 w-full items-center gap-2 px-3 text-left text-body text-le-danger-fg hover:bg-le-danger-bg max-md:h-11"
          >
            <Trash2 aria-hidden strokeWidth={1.75} className="size-4" />
            {C.forgetMenu}
          </button>
        </div>
      ) : null}
      <ConfirmDialog
        open={dialogOpen}
        title={C.forgetTitle}
        deletes={hasSource && alsoSource ? [...C.forgetDeletes, `The source it came from: ${C.alsoDeleteSourceHint}`] : C.forgetDeletes}
        stays={C.forgetStays}
        confirmLabel={C.forgetButton}
        pending={pending}
        error={error}
        onCancel={cancel}
        onConfirm={confirm}
        onClosed={() => {
          if (!rowsGone.current) triggerRef.current?.focus();
        }}
      >
        {hasSource ? (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 text-body text-le-text">
            <input
              type="checkbox"
              checked={alsoSource}
              disabled={pending}
              onChange={(e) => setAlsoSource(e.target.checked)}
              className="mt-1 size-4 accent-(--le-danger-fg)"
            />
            <span>{C.alsoDeleteSource}</span>
          </label>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
