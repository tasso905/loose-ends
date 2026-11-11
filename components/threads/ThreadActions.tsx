"use client";
import { useCallback, useContext, useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, CircleSlash, Ellipsis, Hourglass, Moon, Pencil, RotateCcw, Trash2, type LucideIcon } from "lucide-react";
import { markDoneAction, simpleAction, snoozeAction, undoAction, type ThreadActionResult } from "@/app/threads/[id]/actions";
import { Spinner } from "@/components/auth/Spinner";
import { ErrorBanner, FieldError } from "@/components/Notice";
import { UndoToast, type ToastData } from "@/components/toast/UndoToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DATA_COPY } from "@/lib/account/copy";
import { cn } from "@/lib/utils";
import { apiError, type ApiError } from "@/lib/errors";
import type { ThreadKind, ThreadStatus } from "@/lib/schemas";
import { ACTIONS_COPY as A, availableActions, type SimpleAction, type SnoozeChoice, type SnoozeMenuDates } from "@/lib/threads/actions";
import { RESOLVE_COPY } from "@/lib/threads/resolve";
import { canResolve, THREADS_COPY as C } from "@/lib/threads/view";
import { ActionHostContext } from "./ActionHost";
import { EditSheet, type EditPrefill } from "./EditSheet";
import { ForgetDialog } from "./ForgetThread";
import { MarkWaitingSheet, type ActionDone } from "./MarkWaitingSheet";
import { MenuPopover, type MenuItemSpec } from "./MenuPopover";
import { ResolveSheet, type Resolved } from "./ResolveSheet";

/**
 * Thread actions (SITE_CONTRACT §2.7, CONTENT_MODEL §6, PRD F9 and the lifecycle table).
 *
 * Thread detail offers, in this order and only where the lifecycle table allows: Done (not on
 * decision threads, D6), Resolve…, Reopen (closed threads), Mark waiting, Back to me (waiting),
 * Wake now (snoozed), Snooze, Edit, Dismiss. The first three are buttons; the rest sit in the
 * `More actions` overflow menu with `Forget permanently…` last (DESIGN_STANDARD Overflow menu).
 * Today rows (`compact`) show Done or Resolve… and Snooze as small ghost buttons.
 *
 * Reversible actions run at once with an 8 s Undo toast and no confirmation (D8): Done, Resolve,
 * Mark waiting, Snooze, Dismiss, Edit. Back to me, Wake now and Reopen are not in D8's list and
 * show no toast; the page shows the new status. Forget permanently is confirmed and has no undo.
 * The page re-renders from the server only after the server confirms (rule 10). Errors show as a
 * page banner, never in the toast (§2.13); invalid_transition offers Refresh. `?sheet=resolve`
 * opens the Resolve sheet (§1.2).
 */

const failure = (code: "save_failed") => apiError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : code).error;

/** Monotonic ms for the toast's hard limit; called from click handlers, never in render. */
const actionClock = () => performance.now();

type Key = "done" | "resolve" | "reopen" | "markWaiting" | "backToMe" | "wake" | "snooze" | "edit" | "dismiss";
const ORDER: Key[] = ["done", "resolve", "reopen", "markWaiting", "backToMe", "wake", "snooze", "edit", "dismiss"];
const LABEL: Record<Key, string> = {
  done: C.done,
  resolve: C.resolve,
  reopen: A.reopen,
  markWaiting: A.markWaiting,
  backToMe: A.backToMe,
  wake: A.wakeNow,
  snooze: A.snooze,
  edit: A.edit,
  dismiss: A.dismiss,
};
/** DESIGN_STANDARD Iconography map; Back to me and Wake now have no mapped icon, so none. */
const ICON: Partial<Record<Key, LucideIcon>> = {
  done: Check,
  reopen: RotateCcw,
  markWaiting: Hourglass,
  snooze: Moon,
  edit: Pencil,
  dismiss: CircleSlash,
};

type Popover = { anchor: "more" | "snooze"; view: "main" | "snooze" | "pick" } | null;

/** The element, unless a responsive class hides it on this layout (both layouts are rendered). */
function visible<T extends HTMLElement>(el: T | null): T | null {
  return el && el.getClientRects().length > 0 ? el : null;
}

export function ThreadActions({
  threadId,
  title,
  status,
  kind,
  openResolve = false,
  compact = false,
  surface = "detail",
  focusTargetId = "thread-status",
  counterparty = null,
  snoozeDates,
  edit,
  forget,
}: {
  threadId: string;
  title: string;
  status: ThreadStatus;
  kind: ThreadKind;
  openResolve?: boolean;
  /** Today rows: small ghost buttons whose names include the thread title (DESIGN_STANDARD Thread row). */
  compact?: boolean;
  surface?: "today" | "detail";
  /** Where focus goes when the action takes the buttons away (Thread detail: the status line). */
  focusTargetId?: string;
  /** Prefills `Waiting on` (SITE_CONTRACT §2.7 Mark waiting form). */
  counterparty?: string | null;
  /** The Snooze menu's dates, computed on the server with getNow() in the user's timezone. Snooze is offered only with them. */
  snoozeDates?: SnoozeMenuDates;
  /** Thread detail: Edit's form values. Edit is offered only with them. */
  edit?: EditPrefill;
  /** Thread detail: `Forget permanently…` in More actions. */
  forget?: { hasSource: boolean };
}) {
  const router = useRouter();
  const ids = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ApiError["error"] | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const toastId = useRef(0);
  // The action a retryable error's `Try again` repeats (never an Undo: it would be outside its window).
  const retry = useRef<(() => void) | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  function retryWith(fn: () => void) {
    retry.current = fn;
    setCanRetry(true);
  }
  // On Today the row leaves after an action; the host keeps its toast and Undo errors (ActionHost).
  const host = useContext(ActionHostContext);
  function showToast(t: Omit<ToastData, "id">) {
    if (host) return host.showToast(t);
    toastId.current += 1;
    setToast({ ...t, id: toastId.current });
  }
  function undoFailed(e: ApiError["error"]) {
    if (host) return host.showError(e);
    retry.current = null;
    setCanRetry(false);
    focusErrorOnRender.current = true;
    setError(e);
  }
  const doneRef = useRef<HTMLButtonElement>(null);
  const resolveRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const snoozeRef = useRef<HTMLButtonElement>(null);
  const markWaitingRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const [sheetOpen, setSheetOpen] = useState(() => openResolve && canResolve({ status }));
  const [form, setForm] = useState<"waiting" | "edit" | null>(null);
  const [forgetOpen, setForgetOpen] = useState(false);
  const [popover, setPopover] = useState<Popover>(null);
  const [pickDate, setPickDate] = useState("");
  const [pickError, setPickError] = useState<string | null>(null);
  // Set by a successful Undo: the first action comes back only after router.refresh() re-renders
  // with the server's status, so the focus move waits for that render.
  const focusDoneOnReturn = useRef(false);
  // Set by a refused or failed Undo: the toast (which held focus) closes, so focus moves to the
  // error banner once it renders, or the status line without one; never <body> (T-U1).
  const focusErrorOnRender = useRef(false);
  const bannerRef = useRef<HTMLDivElement>(null);

  const focusStatus = useCallback(() => document.getElementById(focusTargetId)?.focus(), [focusTargetId]);

  /** After the server confirmed: re-render from it, move focus off the buttons that may leave, offer Undo. */
  function succeeded(eventId: number | null, toastCopy: { message: string; undoLabel: string } | null, actionAt: number) {
    router.refresh();
    focusStatus();
    if (toastCopy && eventId !== null) {
      showToast({ message: toastCopy.message, onUndo: () => undo(eventId), undoLabel: toastCopy.undoLabel, actionAt, restoreFocus: focusStatus });
    }
  }

  function done() {
    setError(null);
    retryWith(done);
    // The toast's 11 s hard limit counts from the action, which is before the server's event time.
    const actionAt = actionClock();
    startTransition(async () => {
      try {
        const res = await markDoneAction(threadId, status, surface);
        if (!res.ok) return setError(res.error);
        // The Done button leaves the page; focus goes to the status line, not into the toast, so the
        // 8 s timer runs unless the user moves to the toast.
        succeeded(res.eventId, { message: C.doneToast(title), undoLabel: `Undo done: ${title}` }, actionAt);
      } catch {
        setError(failure("save_failed"));
      }
    });
  }

  /** Dismiss, Back to me, Wake now, Reopen. Only Dismiss offers Undo (D8's list). */
  function simple(action: SimpleAction) {
    setError(null);
    setPopover(null);
    retryWith(() => simple(action));
    const actionAt = actionClock();
    startTransition(async () => {
      try {
        const res = await simpleAction({ threadId, fromStatus: status, action }, surface);
        if (!res.ok) return setError(res.error);
        succeeded(res.eventId, action === "dismiss" ? { message: A.dismissToast(title), undoLabel: A.dismissUndo(title) } : null, actionAt);
      } catch {
        setError(failure("save_failed"));
      }
    });
  }

  function snooze(choice: SnoozeChoice) {
    setError(null);
    setPickError(null);
    retryWith(() => snooze(choice));
    const actionAt = actionClock();
    startTransition(async () => {
      let res: ThreadActionResult;
      try {
        res = await snoozeAction({ threadId, fromStatus: status, choice }, surface);
      } catch {
        setPopover(null);
        return setError(failure("save_failed"));
      }
      if (!res.ok) {
        // A date the server refused stays in the picker, next to the field.
        if (res.field === "date" && choice.preset === "date") return setPickError(res.error.message);
        setPopover(null);
        return setError(res.error);
      }
      setPopover(null);
      succeeded(res.eventId, { message: A.snoozeToast(title), undoLabel: A.snoozeUndo(title) }, actionAt);
    });
  }

  function resolved(r: Resolved) {
    // Resolve… leaves the page; focus goes to the status line, as after Done. The page behind the
    // modal is inert until the dialog has closed, so the move waits for that (effect below).
    focusOnClose.current = "status";
    setSheetOpen(false);
    router.refresh();
    showToast({
      message: r.resolution === "done" ? C.doneToast(title) : RESOLVE_COPY.resolvedToast(title),
      onUndo: () => undo(r.eventId),
      undoLabel: RESOLVE_COPY.undoLabel(title),
      actionAt: r.actionAt,
      restoreFocus: focusStatus,
    });
  }

  // Focus moves once the dialog has really closed (the page behind a modal dialog is inert, so
  // focusing it earlier does nothing). The sheet's own effect closes it first. Cancel returns focus
  // to Resolve…; a save moves it to the status line (Resolve… is about to leave the page).
  const focusOnClose = useRef<"resolve" | "status" | null>(null);
  function closeSheet() {
    focusOnClose.current = "resolve";
    setSheetOpen(false);
  }
  useEffect(() => {
    if (sheetOpen || !focusOnClose.current) return;
    const target = focusOnClose.current;
    focusOnClose.current = null;
    if (target === "resolve") (visible(resolveRef.current) ?? moreRef.current)?.focus();
    else focusStatus();
  }, [sheetOpen, focusStatus]);

  // Mark waiting and Edit: Cancel returns focus to the button that opened the form (or More actions,
  // when it came from the menu); a save moves it to the status line.
  const formSaved = useRef(false);
  function formDone(r: ActionDone, copy: { message: string; undoLabel: string }) {
    formSaved.current = true;
    setForm(null);
    succeededAfterClose.current = () => succeeded(r.eventId, copy, r.actionAt);
  }
  // The toast and refresh wait until the dialog has closed, so focus can leave it.
  const succeededAfterClose = useRef<(() => void) | null>(null);
  function formClosed(opener: React.RefObject<HTMLButtonElement | null>) {
    if (formSaved.current) {
      formSaved.current = false;
      const run = succeededAfterClose.current;
      succeededAfterClose.current = null;
      run?.();
      return;
    }
    (visible(opener.current) ?? moreRef.current)?.focus();
  }

  async function undo(eventId: number) {
    setError(null);
    try {
      const res = await undoAction(threadId, eventId);
      if (!res.ok) return undoFailed(res.error);
      // The first action comes back after the refresh; until then focus waits on the status line,
      // never <body>. If it is already there and enabled, it takes focus now.
      // Only Done or Resolve…: a closed thread's Reopen is still on the page until the refresh lands,
      // and focusing it would leave focus on a button that is about to go.
      const back = visible(doneRef.current) ?? visible(resolveRef.current);
      if (back && !back.disabled) {
        back.focus();
      } else {
        focusDoneOnReturn.current = true;
        focusStatus();
      }
      router.refresh();
    } catch {
      undoFailed(failure("save_failed"));
    }
  }

  useEffect(() => {
    if (!focusErrorOnRender.current) return;
    focusErrorOnRender.current = false;
    (bannerRef.current ?? document.getElementById(focusTargetId))?.focus();
  }, [error, focusTargetId]);

  const showResolve = canResolve({ status });
  useEffect(() => {
    // After an Undo the first action comes back: Done, or Resolve… on a decision thread.
    // It waits until the button is enabled: Done is disabled while its own action is pending.
    const target = visible(doneRef.current) ?? visible(resolveRef.current);
    if (focusDoneOnReturn.current && target && !target.disabled) {
      focusDoneOnReturn.current = false;
      target.focus();
    }
  }, [showResolve, status, pending]);

  const av = availableActions({ status, kind });
  const offered = ORDER.filter((k) => av[k] && (k !== "snooze" || snoozeDates) && (k !== "edit" || edit));
  // Desktop: the first three as buttons (§2.7). Below 768 px: only Done and Snooze (§3.4; Resolve…
  // stands in for Done on a decision thread, D6). Everything else is in More actions. Both layouts
  // are rendered and switched with CSS (md:), so the server and the first client render agree.
  const quick = (k: Key) => k === "done" || k === "snooze" || (k === "resolve" && !offered.includes("done"));
  const desktopButtons = compact ? offered.filter((k) => k === "done" || k === "resolve" || k === "snooze") : offered.slice(0, 3);
  const mobileButtons = compact ? desktopButtons : offered.filter(quick);
  const buttons = offered.filter((k) => desktopButtons.includes(k) || mobileButtons.includes(k));
  const overflow = compact ? [] : offered.filter((k) => !desktopButtons.includes(k) || !mobileButtons.includes(k));
  /** Hides an element on the layout where it does not belong: `on` lists where it shows. */
  const only = (desktop: boolean, mobile: boolean) => (desktop && !mobile ? "max-md:hidden" : mobile && !desktop ? "md:hidden" : undefined);

  function press(k: Key) {
    switch (k) {
      case "done":
        return done();
      case "resolve":
        return setSheetOpen(true);
      case "markWaiting":
        setPopover(null);
        return setForm("waiting");
      case "edit":
        setPopover(null);
        return setForm("edit");
      case "snooze":
        setPickDate("");
        setPickError(null);
        return setPopover((p) => (p?.anchor === "snooze" ? null : { anchor: "snooze", view: "snooze" }));
      case "dismiss":
        return simple("dismiss");
      case "backToMe":
        return simple("back_to_me");
      case "wake":
        return simple("wake");
      case "reopen":
        return simple("reopen");
    }
  }

  const refFor = (k: Key): React.Ref<HTMLButtonElement> | undefined => {
    if (k === "done") return doneRef;
    if (k === "resolve") return resolveRef;
    if (k === "snooze") return snoozeRef;
    if (k === "markWaiting") return markWaitingRef;
    if (k === "edit") return editRef;
    return undefined;
  };

  const anchorRef = useRef<"more" | "snooze" | null>(null);
  useEffect(() => {
    anchorRef.current = popover?.anchor ?? null;
  }, [popover]);
  const dismissPopover = useCallback((returnFocus: boolean) => {
    const anchor = anchorRef.current;
    setPopover(null);
    if (returnFocus && anchor) (anchor === "more" ? moreRef : snoozeRef).current?.focus();
  }, []);

  const snoozeItems: MenuItemSpec[] = snoozeDates
    ? [
        { key: "tomorrow", label: A.tomorrow, detail: snoozeDates.tomorrow, onSelect: () => snooze({ preset: "tomorrow" }), disabled: pending },
        { key: "next_monday", label: A.nextMonday, detail: snoozeDates.nextMonday, onSelect: () => snooze({ preset: "next_monday" }), disabled: pending },
        {
          key: "pick",
          label: A.pickDate,
          onSelect: () => setPopover((p) => (p ? { ...p, view: "pick" } : p)),
          disabled: pending,
        },
      ]
    : [];

  const moreItems: MenuItemSpec[] = [
    ...overflow.map((k) => ({
      key: k,
      label: LABEL[k],
      icon: ICON[k],
      disabled: pending,
      className: only(!desktopButtons.includes(k), !mobileButtons.includes(k)),
      onSelect: () => {
        if (k === "snooze") {
          setPickDate("");
          setPickError(null);
          return setPopover({ anchor: "more", view: "snooze" });
        }
        setPopover(null);
        press(k);
      },
    })),
    ...(forget
      ? [
          {
            key: "forget",
            label: DATA_COPY.forgetMenu,
            icon: Trash2,
            danger: true,
            onSelect: () => {
              setPopover(null);
              setForgetOpen(true);
            },
          },
        ]
      : []),
  ];

  function popoverFor(anchor: "more" | "snooze") {
    if (popover?.anchor !== anchor) return null;
    const id = `${ids}-${anchor}`;
    if (popover.view === "main") {
      return <MenuPopover id={id} label={DATA_COPY.moreActions} items={moreItems} triggerRef={moreRef} onDismiss={dismissPopover} />;
    }
    const trigger = anchor === "more" ? moreRef : snoozeRef;
    const align = anchor === "more" ? "right" : "left";
    if (popover.view === "snooze") {
      return <MenuPopover id={id} label={A.snooze} items={snoozeItems} triggerRef={trigger} onDismiss={dismissPopover} align={align} />;
    }
    const field = `${ids}-pick`;
    return (
      <MenuPopover id={id} label={A.pickDate} triggerRef={trigger} onDismiss={dismissPopover} align={align}>
        <form
          className="px-3 py-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!pickDate) return setPickError(A.badDate);
            snooze({ preset: "date", date: pickDate });
          }}
        >
          <label htmlFor={field} className="block text-label text-le-text">
            {A.snoozeDateLabel}
          </label>
          <Input
            id={field}
            type="date"
            min={snoozeDates?.minDate}
            value={pickDate}
            onChange={(e) => setPickDate(e.target.value)}
            aria-invalid={pickError ? true : undefined}
            aria-describedby={pickError ? `${field}-error` : undefined}
            className="mt-2"
          />
          {pickError ? <FieldError id={`${field}-error`}>{pickError}</FieldError> : null}
          <Button type="submit" size="small" disabled={pending} className="mt-3 w-full">
            {pending ? <Spinner /> : <Moon aria-hidden strokeWidth={1.75} />}
            {A.snoozeConfirm}
          </Button>
        </form>
      </MenuPopover>
    );
  }

  function actionButton(k: Key, i: number) {
    const Icon = ICON[k];
    const primary = !compact && i === 0;
    const where = only(desktopButtons.includes(k), mobileButtons.includes(k));
    const button = (
      <Button
        key={k}
        ref={refFor(k)}
        className={k === "snooze" ? undefined : where}
        onClick={() => press(k)}
        disabled={pending}
        variant={compact ? "ghost" : primary ? "primary" : "secondary"}
        size={compact ? "small" : "default"}
        aria-label={compact ? (k === "resolve" ? `${LABEL[k]} ${title}` : `${LABEL[k]}: ${title}`) : undefined}
        aria-haspopup={k === "resolve" || k === "markWaiting" || k === "edit" ? "dialog" : k === "snooze" ? "menu" : undefined}
        aria-expanded={k === "snooze" ? popover?.anchor === "snooze" : undefined}
      >
        {pending && k === "done" ? <Spinner /> : Icon ? <Icon aria-hidden strokeWidth={1.75} /> : null}
        {LABEL[k]}
      </Button>
    );
    if (k !== "snooze") return button;
    return (
      <div key={k} className={cn("relative", where)}>
        {button}
        {popoverFor("snooze")}
      </div>
    );
  }

  return (
    <div>
      {error ? (
        <div ref={bannerRef} tabIndex={-1} className="focus-ring mb-4 rounded-card">
          <ErrorBanner
            action={
              error.code === "invalid_transition" ? (
                <Button variant="secondary" size="small" onClick={() => router.refresh()}>
                  {C.refresh}
                </Button>
              ) : error.retryable && canRetry ? (
                <Button variant="secondary" size="small" onClick={() => retry.current?.()} disabled={pending}>
                  {C.tryAgain}
                </Button>
              ) : undefined
            }
          >
            {error.message}
          </ErrorBanner>
        </div>
      ) : null}

      {buttons.length > 0 || moreItems.length > 0 ? (
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">{buttons.map(actionButton)}</div>
          {moreItems.length > 0 ? (
            <div className="relative">
              <Button
                ref={moreRef}
                variant="ghost"
                size="small"
                aria-label={DATA_COPY.moreActions}
                aria-haspopup="menu"
                aria-expanded={popover?.anchor === "more"}
                aria-controls={popover?.anchor === "more" ? `${ids}-more` : undefined}
                onClick={() => setPopover((p) => (p?.anchor === "more" ? null : { anchor: "more", view: "main" }))}
              >
                <Ellipsis aria-hidden strokeWidth={1.75} />
              </Button>
              {popoverFor("more")}
            </div>
          ) : null}
        </div>
      ) : null}

      {showResolve ? (
        <ResolveSheet threadId={threadId} status={status} kind={kind} open={sheetOpen} onClose={closeSheet} onResolved={resolved} surface={surface} />
      ) : null}
      {av.markWaiting ? (
        <MarkWaitingSheet
          threadId={threadId}
          status={status}
          counterparty={counterparty}
          open={form === "waiting"}
          onClose={() => setForm(null)}
          onDone={(r) => formDone(r, { message: A.markWaitingToast(title), undoLabel: A.markWaitingUndo(title) })}
          onClosed={() => formClosed(markWaitingRef)}
          surface={surface}
        />
      ) : null}
      {edit ? (
        <EditSheet
          threadId={threadId}
          status={status}
          prefill={edit}
          open={form === "edit"}
          onClose={() => setForm(null)}
          onDone={(r) => formDone(r, { message: A.editToast(r.title ?? title), undoLabel: A.editUndo(r.title ?? title) })}
          onClosed={() => formClosed(editRef)}
        />
      ) : null}
      {forget ? <ForgetDialog threadId={threadId} hasSource={forget.hasSource} open={forgetOpen} onClose={() => setForgetOpen(false)} returnFocusRef={moreRef} /> : null}

      {host ? null : <UndoToast toast={toast} onClose={(id) => setToast((t) => (t && t.id === id ? null : t))} />}
    </div>
  );
}
