import { cn } from "@/lib/utils";

/** Text input: 44px tall, 12px horizontal, 16px text so iOS does not zoom (DESIGN_STANDARD). */
export const inputClasses = cn(
  "block w-full rounded-control border border-le-border bg-le-surface px-3 text-body text-le-text",
  "placeholder:text-le-text-tertiary hover:border-le-border-strong",
  "focus-visible:border-le-accent focus-visible:ring-3 focus-visible:ring-le-accent-subtle focus-visible:outline-none",
  "aria-invalid:border-le-danger-fg disabled:cursor-not-allowed disabled:opacity-50",
);

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(inputClasses, "h-11", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn(inputClasses, "min-h-24 resize-y py-3", className)} {...props} />;
}
