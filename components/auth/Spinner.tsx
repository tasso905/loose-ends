import { Loader2 } from "lucide-react";

/** 16px Loader2 used inside a disabled button while it submits. The button label stays visible. */
export function Spinner() {
  return <Loader2 aria-hidden strokeWidth={1.75} className="animate-spin-status size-4!" />;
}
