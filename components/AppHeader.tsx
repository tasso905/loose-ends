import Link from "next/link";
import { Layers, Plus, Sun } from "lucide-react";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { buttonVariants } from "@/components/ui/button";
import { Wordmark } from "@/components/Wordmark";
import { cn } from "@/lib/utils";

export type NavItem = "today" | "threads" | null;

const ITEMS = [
  { key: "today", href: "/today", label: "Today", Icon: Sun },
  { key: "threads", href: "/threads", label: "Threads", Icon: Layers },
] as const;

/**
 * Minimal app shell (SITE_CONTRACT §1.1, D1) so the core loop is reachable by clicking: Today,
 * Threads and the global Add. Decisions, the account menu, the review chip and the mobile bottom
 * navigation arrive with their features; Sign out stays a button until the account menu exists.
 */
export function AppHeader({ current }: { current: NavItem }) {
  return (
    <header className="mx-auto flex w-full max-w-column flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 pt-6 sm:px-6 md:pt-8 lg:px-8">
      <Link href="/today" className="focus-ring rounded-control" aria-label="Loose Ends, go to Today">
        <Wordmark />
      </Link>
      <nav aria-label="Primary" className="flex items-center gap-1">
        {ITEMS.map(({ key, href, label, Icon }) => {
          const active = current === key;
          return (
            <Link
              key={key}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "focus-ring inline-flex h-9 items-center gap-2 rounded-control px-3 text-body-strong max-md:h-11",
                "transition-colors duration-(--le-dur-fast) ease-(--le-ease-out)",
                active ? "bg-le-accent-subtle text-le-accent" : "text-le-text-secondary hover:bg-le-surface-sunken hover:text-le-text",
              )}
            >
              <Icon aria-hidden strokeWidth={1.75} className="size-4" />
              {label}
            </Link>
          );
        })}
        <Link href="/add" className={buttonVariants({ size: "small", className: "ml-2" })}>
          <Plus aria-hidden strokeWidth={1.75} />
          Add
        </Link>
      </nav>
      <SignOutButton />
    </header>
  );
}
