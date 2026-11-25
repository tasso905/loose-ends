"use client";
import { useContext, useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitQuickAdd } from "@/app/add/actions";
import { Spinner } from "@/components/auth/Spinner";
import { useHydrated } from "@/components/auth/useHydrated";
import { ErrorBanner, FieldError } from "@/components/Notice";
import { ActionHostContext, ActionHostProvider } from "@/components/threads/ActionHost";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeLineBreaks } from "@/lib/capture/pasteInput";
import { QUICK_ADD_COPY as C, quickAddFieldError } from "@/lib/capture/quickAddInput";
import { apiError, type ApiError } from "@/lib/errors";
import { handOffQuickAddToast, leaveForSignIn, showQuickAddToast } from "./quickAddToast";

type Failure = ApiError["error"];

/**
 * The lines whose outcome is unknown, and the idempotency key of every line the server has not
 * answered for (S14 D2, D5). Kept in the module so a trip to /review or another tab of /add does not
 * drop them; one user's lines are never shown to another. A full reload drops them. Browser only.
 */
interface Unanswered {
  userId: string;
  keys: Map<string, string>;
  unknown: { line: string; tries: number }[];
}
let store: Unanswered | null = null;
function unanswered(userId: string): Unanswered {
  if (store?.userId === userId) return store;
  const fresh: Unanswered = { userId, keys: new Map(), unknown: [] };
  if (typeof window !== "undefined") store = fresh;
  return fresh;
}

/**
 * Quick add mode (F4; SITE_CONTRACT §2.2, §3.1; D9). One line; `Add` sends it through the same
 * pipeline as paste. When every proposal became a thread, the user stays here: the field clears and
 * the 8 s undo toast names what was added. If any Medium or Low proposal is waiting, the user goes to
 * the review tray for those, and the toast for any created thread follows them there. Nothing claims
 * success before the server's result (rule 10).
 */
export function QuickAddForm({ userId }: { userId: string }) {
  return (
    // Keyed: a toast or banner for one user goes when another user's page replaces it.
    <ActionHostProvider key={userId}>
      <QuickAddFields userId={userId} />
    </ActionHostProvider>
  );
}

function QuickAddFields({ userId }: { userId: string }) {
  const router = useRouter();
  const host = useContext(ActionHostContext);
  const hydrated = useHydrated();
  const inputRef = useRef<HTMLInputElement>(null);
  const [length, setLength] = useState(0);
  const [blank, setBlank] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [fieldFailure, setFieldFailure] = useState(false);
  const [pending, startTransition] = useTransition();
  // Each has its own banner until the server answers for that line, whatever else is sent meanwhile.
  const [unknown, setUnknown] = useState(() => unanswered(userId).unknown);
  const unknownId = useId();
  // Set when Try again on an unknown line was refused: the next Try again is about that line too.
  const [retryLine, setRetryLine] = useState<string | null>(null);

  useEffect(() => {
    // SITE_CONTRACT §3.2: focus the first relevant field on /add, unless the user already moved on.
    const active = document.activeElement;
    if (!active || active === document.body) inputRef.current?.focus();
    const value = inputRef.current?.value ?? "";
    if (value.length > 0) {
      setLength(normalizeLineBreaks(value).length);
      setBlank(value.trim() === "");
    }
  }, []);

  const overLimit = quickAddFieldError(length);
  const fieldError = overLimit ?? (fieldFailure && failure ? failure.message : null);
  const banner = failure && !fieldFailure ? failure : null;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || overLimit || blank) return;
    send(inputRef.current?.value ?? "");
  }

  // `s`: the lines of the user who sent it, also when its answer comes after a switch of users.
  function settle(s: Unanswered, line: string) {
    s.unknown = s.unknown.filter((u) => u.line !== line);
    setUnknown(s.unknown);
  }

  function send(line: string) {
    if (pending) return;
    const s = unanswered(userId);
    const key = s.keys.get(line) ?? crypto.randomUUID();
    const formData = new FormData();
    formData.set("text", line);
    formData.set("key", key);
    formData.set("user_id", userId);
    // The Add and Try again buttons go away or are disabled while pending; the field stays.
    inputRef.current?.focus();
    if (!navigator.onLine) {
      // Nothing was sent now, but an earlier try of this line may have been saved.
      setFailure(s.unknown.some((u) => u.line === line) ? null : apiError("offline").error);
      setRetryLine(null);
      setFieldFailure(false);
      return;
    }
    s.keys.set(line, key);
    setFailure(null);
    setFieldFailure(false);
    setRetryLine(null);
    const sentAt = performance.now();
    startTransition(async () => {
      const outcomeUnknown = () => {
        const before = s.unknown.find((u) => u.line === line);
        // `tries` remounts the banner, so a repeated unknown outcome is announced again.
        s.unknown = [...s.unknown.filter((u) => u.line !== line), { line, tries: (before?.tries ?? 0) + 1 }];
        setUnknown(s.unknown);
      };
      try {
        const result = await submitQuickAdd(formData);
        if (!result.ok && result.unknown) return outcomeUnknown();
        if (!result.ok) {
          if (result.signedOut) {
            if (inputRef.current) inputRef.current.value = "";
            leaveForSignIn();
            return;
          }
          // A refusal that never looked the key up says nothing about the earlier try of this line.
          const earlier = s.unknown.some((u) => u.line === line);
          if (earlier && result.unsettled) return outcomeUnknown();
          settle(s, line);
          setFailure(result.error);
          if (earlier) setRetryLine(line);
          // A field error belongs to the line it was about, not to newer text (D1).
          setFieldFailure(result.field === "text" && inputRef.current?.value === line);
          return;
        }
        s.keys.delete(line);
        settle(s, line);
        // The request cannot have reached the server before it was sent, so this is never later than
        // the real creation time: the toast never outlives the server's Undo window (D4).
        const toast = {
          userId,
          created: result.created,
          createdAt: sentAt + result.createdAfterMs,
          arrivedAt: performance.now(),
          undoable: result.undoable,
        };
        if (result.route === "review") {
          handOffQuickAddToast(result.extractionId, toast);
          router.push(`/review/${result.extractionId}`);
          return;
        }
        // The threads exist (rule 10): clear the line, unless the user has typed another since (D1).
        if (inputRef.current?.value === line) {
          inputRef.current.value = "";
          setLength(0);
          setBlank(true);
        }
        if (host) showQuickAddToast(host, toast, () => inputRef.current?.focus());
      } catch {
        // The request may have been saved: only the server can say, so nothing is claimed (D2).
        outcomeUnknown();
      }
    });
  }

  const describedBy = ["quick-hint", fieldError ? "quick-error" : null].filter(Boolean).join(" ");

  return (
    <form method="post" onSubmit={onSubmit} aria-busy={pending || undefined} className="mt-6 space-y-5">
      {banner ? (
        <ErrorBanner
          action={
            banner.retryable ? (
              <Button
                type={retryLine === null ? "submit" : "button"}
                variant="secondary"
                size="small"
                disabled={pending}
                onClick={retryLine === null ? undefined : () => send(retryLine)}
              >
                Try again
              </Button>
            ) : undefined
          }
        >
          {banner.message}
        </ErrorBanner>
      ) : null}
      {unknown.map((u, i) => (
        <ErrorBanner
          key={`${u.line}:${u.tries}`}
          action={
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={pending}
              aria-describedby={`${unknownId}-${i}`}
              onClick={() => send(u.line)}
            >
              Try again
            </Button>
          }
        >
          {C.addUnknown}
          {/* The user's own words, verbatim and in full (rule 5): which line this is about, once others have been added. */}
          <span id={`${unknownId}-${i}`} className="block text-small wrap-anywhere whitespace-pre-wrap text-le-text-secondary">
            {u.line}
          </span>
        </ErrorBanner>
      ))}

      <div>
        <label htmlFor="quick-text" className="sr-only">
          {C.label}
        </label>
        <p id="quick-hint" className="text-small text-le-text-secondary">
          {C.hint}
        </p>
        <Input
          ref={inputRef}
          id="quick-text"
          name="text"
          type="text"
          autoComplete="off"
          placeholder={C.placeholder}
          className="mt-3"
          onInput={(e) => {
            setLength(normalizeLineBreaks(e.currentTarget.value).length);
            setBlank(e.currentTarget.value.trim() === "");
            if (fieldFailure) {
              setFailure(null);
              setFieldFailure(false);
            }
          }}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={describedBy}
        />
        {fieldError ? <FieldError id="quick-error">{fieldError}</FieldError> : null}
      </div>

      <Button type="submit" disabled={!hydrated || pending || blank || overLimit !== null}>
        {pending ? <Spinner /> : null}
        {C.submit}
      </Button>
    </form>
  );
}
