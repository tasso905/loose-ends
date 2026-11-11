"use client";
import { useId, useState, useTransition } from "react";
import { editAction, type ActionField } from "@/app/threads/[id]/actions";
import { Input, inputClasses, Textarea } from "@/components/ui/input";
import { apiError, type ApiError } from "@/lib/errors";
import type { ThreadKind, ThreadStatus } from "@/lib/schemas";
import { ACTIONS_COPY as A, type EditFields } from "@/lib/threads/actions";
import { clampChars, EDIT_LIMITS, isBlankText } from "@/lib/threads/transition";
import { KIND_LABEL } from "@/lib/threads/view";
import { cn } from "@/lib/utils";
import { ActionSheet, Field } from "./ActionSheet";
import type { ActionDone } from "./MarkWaitingSheet";

/** The thread's current values as the form shows them: local dates (YYYY-MM-DD) and 24 h times, "" for none. */
export interface EditPrefill {
  title: string;
  kind: ThreadKind;
  nextAction: string;
  counterparty: string;
  dueDate: string;
  dueTime: string;
  waitingOn: string;
  expectedBy: string;
  snoozedUntil: string;
  /** Tomorrow, the earliest snooze date (as `Pick a date…`). */
  minSnoozeDate: string;
}

const KINDS: ThreadKind[] = ["commitment", "request", "waiting_on", "admin", "decision"];

const offline = () => (typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "save_failed") as "offline" | "save_failed";

/**
 * Edit (F9 "Edit any field"; SITE_CONTRACT §2.7 title editable): title, loop type, next action,
 * person or organization, due date and time; `Waiting on` and `Expected by` while waiting; the
 * snooze date while snoozed. Only changed fields are sent; text is stored as typed (rule 5); a date
 * the user sets is no longer `Assumed`. A waiting_on thread has no next action of the user's (D63),
 * so the field is not shown for it. A waiting thread keeps its waiting_on / non-waiting_on loop type
 * (that change goes through Mark waiting or Back to me). Closes only after the server confirms.
 */
export function EditSheet({
  threadId,
  status,
  prefill,
  open,
  onClose,
  onDone,
  onClosed,
}: {
  threadId: string;
  status: ThreadStatus;
  prefill: EditPrefill;
  open: boolean;
  onClose: () => void;
  onDone: (r: ActionDone) => void;
  onClosed?: () => void;
}) {
  const ids = useId();
  const [v, setV] = useState(prefill);
  const [fieldError, setFieldError] = useState<{ field: ActionField; message: string } | null>(null);
  const [error, setError] = useState<ApiError["error"] | null>(null);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof EditPrefill>(k: K, value: EditPrefill[K]) => setV((s) => ({ ...s, [k]: value }));

  function reset() {
    setV(prefill);
    setFieldError(null);
    setError(null);
  }
  // Each open starts from the thread's current values (after a save, an Undo or a refresh), set
  // while rendering so the dialog never shows a frame of the previous form.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) reset();
  }

  function changes(): EditFields {
    const f: EditFields = {};
    if (v.title !== prefill.title) f.title = v.title;
    if (v.kind !== prefill.kind) f.kind = v.kind;
    if (v.nextAction !== prefill.nextAction) f.next_action = v.nextAction;
    if (v.counterparty !== prefill.counterparty) f.counterparty = v.counterparty;
    if (v.dueDate !== prefill.dueDate || (v.dueDate && v.dueTime !== prefill.dueTime)) {
      f.due = v.dueDate ? { date: v.dueDate, time: v.dueTime || null } : null;
    }
    if (status === "waiting") {
      if (v.waitingOn !== prefill.waitingOn) f.waiting_on = v.waitingOn;
      if (v.expectedBy !== prefill.expectedBy) f.expected_by = v.expectedBy || null;
    }
    if (status === "snoozed" && v.snoozedUntil !== prefill.snoozedUntil) f.snoozed_until = v.snoozedUntil;
    return f;
  }

  function submit() {
    setError(null);
    setFieldError(null);
    if (isBlankText(v.title)) return setFieldError({ field: "title", message: A.titleRequired });
    if (status === "waiting" && isBlankText(v.waitingOn)) return setFieldError({ field: "waiting_on", message: A.waitingOnRequired });
    const fields = changes();
    if (Object.keys(fields).length === 0) {
      // Nothing changed: nothing to save and nothing to claim.
      reset();
      onClose();
      return;
    }
    const actionAt = performance.now();
    startTransition(async () => {
      try {
        const res = await editAction({ threadId, fromStatus: status, fields });
        if (!res.ok) {
          if (res.field) return setFieldError({ field: res.field, message: res.error.message });
          return setError(res.error);
        }
        onDone({ eventId: res.eventId, actionAt, title: v.title });
      } catch {
        setError(apiError(offline()).error);
      }
    });
  }

  const err = (f: ActionField) => (fieldError?.field === f ? fieldError.message : null);
  const described = (f: ActionField, id: string) => (err(f) ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {});
  // A waiting thread cannot move to or from the waiting_on loop type here.
  const kinds = status === "waiting" ? KINDS.filter((k) => (k === "waiting_on") === (prefill.kind === "waiting_on")) : KINDS;

  return (
    <ActionSheet
      open={open}
      title={A.editHeading}
      submitLabel={A.editSave}
      pending={pending}
      error={error}
      onClose={() => {
        reset();
        onClose();
      }}
      onSubmit={submit}
      onClosed={onClosed}
    >
      <Field id={`${ids}-title`} label={A.title} error={err("title")}>
        <Input id={`${ids}-title`} value={v.title} onChange={(e) => set("title", clampChars(e.target.value, EDIT_LIMITS.title))} {...described("title", `${ids}-title`)} />
      </Field>
      <Field id={`${ids}-kind`} label={A.kind}>
        <select
          id={`${ids}-kind`}
          value={v.kind}
          onChange={(e) => set("kind", e.target.value as ThreadKind)}
          disabled={kinds.length === 1}
          className={cn(inputClasses, "h-11")}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      {v.kind !== "waiting_on" ? (
        <Field id={`${ids}-next`} label={A.nextAction}>
          <Textarea
            id={`${ids}-next`}
            value={v.nextAction}
            onChange={(e) => set("nextAction", clampChars(e.target.value, EDIT_LIMITS.next_action))}
            className="min-h-20"
          />
        </Field>
      ) : null}
      <Field id={`${ids}-who`} label={A.counterparty}>
        <Input id={`${ids}-who`} value={v.counterparty} onChange={(e) => set("counterparty", clampChars(e.target.value, EDIT_LIMITS.counterparty))} />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id={`${ids}-due`} label={A.dueDate} error={err("due")}>
          <Input id={`${ids}-due`} type="date" value={v.dueDate} onChange={(e) => set("dueDate", e.target.value)} {...described("due", `${ids}-due`)} />
        </Field>
        <Field id={`${ids}-time`} label={A.dueTime}>
          <Input id={`${ids}-time`} type="time" value={v.dueTime} onChange={(e) => set("dueTime", e.target.value)} disabled={!v.dueDate} />
        </Field>
      </div>
      {status === "waiting" ? (
        <>
          <Field id={`${ids}-waiting`} label={A.waitingOn} error={err("waiting_on")}>
            <Input
              id={`${ids}-waiting`}
              value={v.waitingOn}
              onChange={(e) => set("waitingOn", clampChars(e.target.value, EDIT_LIMITS.waiting_on))}
              {...described("waiting_on", `${ids}-waiting`)}
            />
          </Field>
          <Field id={`${ids}-expected`} label={A.expectedBy} error={err("expected_by")}>
            <Input id={`${ids}-expected`} type="date" value={v.expectedBy} onChange={(e) => set("expectedBy", e.target.value)} {...described("expected_by", `${ids}-expected`)} />
          </Field>
        </>
      ) : null}
      {status === "snoozed" ? (
        <Field id={`${ids}-snoozed`} label={A.snoozedUntil} error={err("snoozed_until")}>
          <Input
            id={`${ids}-snoozed`}
            type="date"
            min={prefill.minSnoozeDate}
            value={v.snoozedUntil}
            onChange={(e) => set("snoozedUntil", e.target.value)}
            {...described("snoozed_until", `${ids}-snoozed`)}
          />
        </Field>
      ) : null}
    </ActionSheet>
  );
}
