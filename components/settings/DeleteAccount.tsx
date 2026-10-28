"use client";
import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteAccountAction } from "@/app/settings/data-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FieldError } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ACCOUNT_DELETE_WORD, DATA_COPY as C } from "@/lib/account/copy";
import { apiError } from "@/lib/errors";

/**
 * `Delete account…` (D14; CONTENT_MODEL "Delete account": typing `delete` confirms; backup expiry
 * explained honestly). Irreversible, no undo (D8). On success the session is already ended and
 * the browser goes to sign-in, which says the account was deleted (rule 10).
 */
export function DeleteAccount() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const matches = word.trim().toLowerCase() === ACCOUNT_DELETE_WORD;

  function cancel() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function confirm() {
    setError(null);
    setFieldError(null);
    startTransition(async () => {
      try {
        const res = await deleteAccountAction(word);
        if (!res.ok) {
          if (res.field === "confirm") setFieldError(res.error.message);
          else setError(res.error.message);
          return;
        }
        router.replace("/sign-in");
        router.refresh();
      } catch {
        setError(apiError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "save_failed").error.message);
      }
    });
  }

  return (
    <>
      <Button
        ref={triggerRef}
        variant="secondary"
        onClick={() => {
          setWord("");
          setError(null);
          setFieldError(null);
          setOpen(true);
        }}
        className="text-le-danger-fg"
      >
        {C.deleteAccountButton}
      </Button>
      <ConfirmDialog
        open={open}
        title={C.accountTitle}
        deletes={C.accountDeletes}
        confirmLabel={C.accountButton}
        pending={pending}
        error={error}
        confirmDisabled={!matches}
        onCancel={cancel}
        onConfirm={confirm}
      >
        <p className="text-body text-le-text-secondary">{C.accountBackups}</p>
        <label htmlFor={`${ids}-word`} className="mt-4 block text-label text-le-text">
          {C.accountConfirmLabel}
        </label>
        <Input
          id={`${ids}-word`}
          value={word}
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          onChange={(e) => setWord(e.target.value.slice(0, 20))}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${ids}-word-error` : undefined}
          className="mt-2"
        />
        {fieldError ? <FieldError id={`${ids}-word-error`}>{fieldError}</FieldError> : null}
      </ConfirmDialog>
    </>
  );
}
