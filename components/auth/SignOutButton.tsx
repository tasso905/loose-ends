"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { signOut } from "@/app/today/actions";
import { Spinner } from "@/components/auth/Spinner";
import { useHydrated } from "@/components/auth/useHydrated";
import { FieldError } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { apiError } from "@/lib/errors";

const SAVE_FAILED = apiError("save_failed").error.message; // SITE_CONTRACT §2.13
const OFFLINE = apiError("offline").error.message;

/** Account-menu Sign out (`LogOut` icon) until the app shell's account menu exists. */
export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const hydrated = useHydrated();

  function run() {
    setError(null);
    startTransition(async () => {
      try {
        const { ok } = await signOut();
        if (!ok) return setError(SAVE_FAILED);
        router.replace("/sign-in");
        router.refresh();
      } catch {
        setError(navigator.onLine ? SAVE_FAILED : OFFLINE);
      }
    });
  }

  return (
    <div>
      <Button variant="secondary" size="small" onClick={run} disabled={pending || !hydrated} aria-describedby={error ? "sign-out-error" : undefined}>
        {pending ? <Spinner /> : <LogOut aria-hidden strokeWidth={1.75} />}
        Sign out
      </Button>
      {error ? <FieldError id="sign-out-error">{error}</FieldError> : null}
    </div>
  );
}
