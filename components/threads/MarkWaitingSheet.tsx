"use client";
import { useId, useState, useTransition } from "react";
import { markWaitingAction } from "@/app/threads/[id]/actions";
import { Input } from "@/components/ui/input";
import { apiError, type ApiError } from "@/lib/errors";
import type { ThreadStatus } from "@/lib/schemas";
import { ACTIONS_COPY as A } from "@/lib/threads/actions";
import { clampChars, EDIT_LIMITS, isBlankText } from "@/lib/threads/transition";
import { ActionSheet, Field } from "./ActionSheet";

export interface ActionDone {
  eventId: number | null;
  /** performance.now() when the user pressed save: the undo toast's 11 s limit counts from here (D51). */
  actionAt: number;
  /** Edit: the title as saved, for the toast. */
  title?: string;
}

const offline = () => (typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "save_failed") as "offline" | "save_failed";

/**
 * Mark waiting form (SITE_CONTRACT §2.7): `Waiting on` (required, prefilled with the counterparty)
 * and `Expected by` (optional date). Open → waiting; closes only after the server confirms (rule 10).
 */
export function MarkWaitingSheet({
  threadId,
  status,
  counterparty,
  open,
  onClose,
  onDone,
  onClosed,
  surface = "detail",
}: {
  threadId: string;
  status: ThreadStatus;
  counterparty: string | null;
  open: boolean;
  onClose: () => void;
  onDone: (r: ActionDone) => void;
  onClosed?: () => void;
  surface?: "today" | "detail";
}) {
  const ids = useId();
  const [waitingOn, setWaitingOn] = useState(counterparty ?? "");
  const [expectedBy, setExpectedBy] = useState("");
  const [fieldError, setFieldError] = useState<{ field: "waitingOn" | "expectedBy"; message: string } | null>(null);
  const [error, setError] = useState<ApiError["error"] | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setWaitingOn(counterparty ?? "");
    setExpectedBy("");
    setFieldError(null);
    setError(null);
  }
  // Each open starts from the thread's current counterparty, set while rendering (no stale frame).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) reset();
  }

  function submit() {
    setError(null);
    setFieldError(null);
    if (isBlankText(waitingOn)) return setFieldError({ field: "waitingOn", message: A.waitingOnRequired });
    const actionAt = performance.now();
    startTransition(async () => {
      try {
        const res = await markWaitingAction({ threadId, fromStatus: status, waitingOn, expectedBy: expectedBy || null }, surface);
        if (!res.ok) {
          if (res.field === "waitingOn" || res.field === "expectedBy") return setFieldError({ field: res.field, message: res.error.message });
          return setError(res.error);
        }
        reset();
        onDone({ eventId: res.eventId, actionAt });
      } catch {
        setError(apiError(offline()).error);
      }
    });
  }

  const err = (f: "waitingOn" | "expectedBy") => (fieldError?.field === f ? fieldError.message : null);

  return (
    <ActionSheet
      open={open}
      title={A.markWaiting}
      submitLabel={A.markWaiting}
      pending={pending}
      error={error}
      onClose={() => {
        reset();
        onClose();
      }}
      onSubmit={submit}
      onClosed={onClosed}
    >
      <Field id={`${ids}-who`} label={A.waitingOn} error={err("waitingOn")}>
        <Input
          id={`${ids}-who`}
          value={waitingOn}
          onChange={(e) => setWaitingOn(clampChars(e.target.value, EDIT_LIMITS.waiting_on))}
          aria-invalid={err("waitingOn") ? true : undefined}
          aria-describedby={err("waitingOn") ? `${ids}-who-error` : undefined}
          required
        />
      </Field>
      <Field id={`${ids}-by`} label={A.expectedBy} error={err("expectedBy")}>
        <Input
          id={`${ids}-by`}
          type="date"
          value={expectedBy}
          onChange={(e) => setExpectedBy(e.target.value)}
          aria-invalid={err("expectedBy") ? true : undefined}
          aria-describedby={err("expectedBy") ? `${ids}-by-error` : undefined}
        />
      </Field>
    </ActionSheet>
  );
}
