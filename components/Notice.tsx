import { CircleAlert, Info } from "lucide-react";
import { cn } from "@/lib/utils";

/** Info notice (DESIGN_STANDARD "Info notice"): onboarding notes and limitations. */
export function InfoNotice({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex gap-2 rounded-card border border-le-border bg-le-surface-sunken px-4 py-3 text-body", className)}>
      <Info aria-hidden strokeWidth={1.75} className="mt-1 size-4 shrink-0 text-le-text-secondary" />
      <div>{children}</div>
    </div>
  );
}

/**
 * Page-level error banner (DESIGN_STANDARD "Error banner"); never dismissible, never a toast. The
 * message alone is the live region, so the action button is not read out as part of it.
 */
export function ErrorBanner({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-le-danger-fg/30 bg-le-danger-bg px-4 py-3 text-body text-le-text">
      <CircleAlert aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-le-danger-fg" />
      <p role="alert" className="min-w-0 flex-1">
        {children}
      </p>
      {action}
    </div>
  );
}

/** Field error: `small` in --danger-fg with a 14px CircleAlert, 4px below the field. */
export function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-1 flex items-start gap-1 text-small text-le-danger-fg">
      <CircleAlert aria-hidden strokeWidth={1.75} className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
