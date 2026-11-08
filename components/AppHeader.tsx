import Link from "next/link";
import { Layers, Plus, Scale, Settings, Sun } from "lucide-react";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { buttonVariants } from "@/components/ui/button";
import { Wordmark } from "@/components/Wordmark";
import { cn } from "@/lib/utils";

export type NavItem = "today" | "threads" | "decisions" | null;

const ITEMS = [
  { key: "today", href: "/today", label: "Today", Icon: Sun },
  { key: "threads", href: "/threads", label: "Threads", Icon: Layers },
  { key: "decisions", href: "/decisions", label: "Decisions", Icon: Scale },
] as const;

/**
 * Minimal app shell (SITE_CONTRACT §1.1, D1) so the core loop is reachable by clicking: Today,
 * Threads, Decisions (S9) and the global Add. The account menu, the review chip and the mobile bottom
 * navigation arrive with their features; until the account menu exists, Settings is a link and Sign out
 * a button beside it.
 */
export function AppHeader({ current }: { current: NavItem }) {
  return (
    <header className="mx-auto flex w-full max-w-column flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 pt-6 sm:px-6 md:pt-8 lg:px-8">
      {/* 44 px tall below 768 px like the nav links (CLAUDE.md touch targets); the Wordmark alone is 26 px. */}
      <Link href="/today" className="focus-ring inline-flex items-center rounded-control max-md:min-h-11" aria-label="Loose Ends, go to Today">
        <Wordmark />
      </Link>
      <nav aria-label="Primary" className="flex flex-wrap items-center gap-1">
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
      <div className="flex items-center gap-1">
        <Link
          href="/settings"
          className="focus-ring inline-flex h-9 items-center gap-2 rounded-control px-3 text-body-strong text-le-text-secondary hover:bg-le-surface-sunken hover:text-le-text max-md:h-11"
        >
          <Settings aria-hidden strokeWidth={1.75} className="size-4" />
          Settings
        </Link>
        <SignOutButton />
      </div>
    </header>
  );
}
