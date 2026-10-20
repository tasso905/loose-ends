"use client";
import { useId, useRef, useState, useTransition } from "react";
import { setAnalyticsEnabled } from "@/app/settings/actions";
import { useHydrated } from "@/components/auth/useHydrated";
import { FieldError } from "@/components/Notice";
import { ANALYTICS_SETTINGS_COPY as C } from "@/lib/auth/copy";
import { cn } from "@/lib/utils";

/**
 * Settings → Profile analytics toggle (DESIGN_STANDARD "Toggle"; D40). The switch moves only after
 * the server confirms the save (rule 10); a failed save keeps the old state and shows the §2.13 error.
 * While saving it is aria-disabled and ignores presses rather than `disabled`, so keyboard focus stays
 * on the switch (WCAG 2.4.3).
 */
export function AnalyticsToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();
  const labelId = useId();
  const descId = useId();
  const errorId = useId();
  const inFlight = useRef(false);

  function toggle() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    const next = !enabled;
    startTransition(async () => {
      try {
        const res = await setAnalyticsEnabled({ enabled: next });
        if (res.ok) setEnabled(res.enabled);
        else setError(C.saveFailed);
      } catch {
        setError(navigator.onLine ? C.saveFailed : C.offline);
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <span id={labelId} className="text-body-strong text-le-text">
          {C.toggleLabel}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby={labelId}
          aria-describedby={error ? `${descId} ${errorId}` : descId}
          aria-busy={pending || undefined}
          aria-disabled={pending || undefined}
          disabled={!hydrated}
          onClick={toggle}
          className="focus-ring group inline-flex h-10 w-11 shrink-0 items-center justify-center rounded-control disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-wait aria-disabled:opacity-50 max-md:h-11"
        >
          <span
            aria-hidden
            className={cn(
              "flex h-5 w-9 items-center rounded-full p-0.5 transition-colors duration-(--le-dur-fast) ease-(--le-ease-out)",
              enabled ? "bg-le-accent" : "bg-le-border-strong",
            )}
          >
            <span
              className={cn(
                "size-4 rounded-full bg-le-surface-raised shadow-(--le-shadow-float) transition-transform duration-(--le-dur-fast) ease-(--le-ease-out) motion-reduce:transition-none",
                enabled ? "translate-x-4" : "translate-x-0",
              )}
            />
          </span>
        </button>
      </div>
      <p id={descId} className="mt-1 text-small text-le-text-secondary">
        {C.toggleDescription}
      </p>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
