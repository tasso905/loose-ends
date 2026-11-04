"use client";
import { useState } from "react";
import { Download } from "lucide-react";
import { Spinner } from "@/components/auth/Spinner";
import { ErrorBanner } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { DATA_COPY as C } from "@/lib/account/copy";
import { apiError } from "@/lib/errors";

/**
 * `Export data (JSON)` (SITE_CONTRACT §1.1, §2.12; PRD F13). The file is fetched in full first and
 * saved only once it has arrived, so completion is reported only after the download is ready
 * (§1.1, rule 10). A failure shows an error with the button still there to try again.
 */
export function ExportData() {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [error, setError] = useState<string>(C.exportFailed);

  async function run() {
    setState("working");
    try {
      const res = await fetch("/api/export", { cache: "no-store" });
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "loose-ends-export.json";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setState("done");
    } catch {
      setError(typeof navigator !== "undefined" && !navigator.onLine ? apiError("offline").error.message : C.exportFailed);
      setState("error");
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-body text-le-text-secondary">{C.exportHint}</p>
      {state === "error" ? <ErrorBanner>{error}</ErrorBanner> : null}
      <Button variant="secondary" onClick={run} disabled={state === "working"}>
        {state === "working" ? <Spinner /> : <Download aria-hidden strokeWidth={1.75} />}
        {C.exportButton}
      </Button>
      <p role="status" className="text-body text-le-text empty:hidden">
        {state === "working" ? C.exporting : state === "done" ? C.exportReady : null}
      </p>
    </div>
  );
}
