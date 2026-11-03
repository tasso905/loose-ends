"use client";
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorBanner } from "@/components/Notice";
import { UndoToast, type ToastData } from "@/components/toast/UndoToast";
import { Button } from "@/components/ui/button";
import type { ApiError } from "@/lib/errors";
import { THREADS_COPY as C } from "@/lib/threads/view";

export interface ActionHost {
  showToast: (t: Omit<ToastData, "id">) => void;
  showError: (e: ApiError["error"]) => void;
}

/**
 * On a list (Today), Done or Resolve takes the row away, and the row's own toast and error banner
 * with it. Rows inside this host hand their undo toast and their Undo failures to it instead, so the
 * 8 s Undo (D8) and any refusal (§2.13) outlive the row. Thread detail has no host and keeps both
 * in ThreadActions.
 */
export const ActionHostContext = createContext<ActionHost | null>(null);

export function ActionHostProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [toast, setToast] = useState<ToastData | null>(null);
  const [error, setError] = useState<ApiError["error"] | null>(null);
  const nextId = useRef(0);
  const bannerRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((t: Omit<ToastData, "id">) => {
    nextId.current += 1;
    setError(null);
    setToast({ ...t, id: nextId.current });
  }, []);
  const showError = useCallback((e: ApiError["error"]) => setError(e), []);
  const host = useMemo(() => ({ showToast, showError }), [showToast, showError]);

  // The toast that held focus has closed: focus moves to the banner, never <body>.
  useEffect(() => {
    if (error) bannerRef.current?.focus();
  }, [error]);

  return (
    <ActionHostContext.Provider value={host}>
      {error ? (
        <div ref={bannerRef} tabIndex={-1} className="focus-ring mb-4 rounded-card">
          <ErrorBanner
            action={
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  setError(null);
                  router.refresh();
                }}
              >
                {C.refresh}
              </Button>
            }
          >
            {error.message}
          </ErrorBanner>
        </div>
      ) : null}
      {children}
      <UndoToast toast={toast} onClose={(id) => setToast((t) => (t && t.id === id ? null : t))} />
    </ActionHostContext.Provider>
  );
}
