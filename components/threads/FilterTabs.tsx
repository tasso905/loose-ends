"use client";
import { useRef } from "react";
import Link from "next/link";
import { THREADS_COPY as C, type ThreadFilter } from "@/lib/threads/view";
import { cn } from "@/lib/utils";

const TABS: { key: ThreadFilter; label: string; href: string }[] = [
  { key: "active", label: C.active, href: "/threads" },
  { key: "closed", label: C.closed, href: "/threads?filter=closed" },
];

/**
 * Active / Closed (D7) as tabs: the selected one is exposed with aria-selected (SITE_CONTRACT §2.6,
 * §3.3). Each tab is a link to its `?filter=`, so Back restores the filter. Arrow keys move focus
 * between tabs and Enter opens one (manual activation); only the selected tab is in the Tab order.
 */
export function FilterTabs({ current, panelId }: { current: ThreadFilter; panelId: string }) {
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    refs.current[(next + TABS.length) % TABS.length]?.focus();
  }

  return (
    <div role="tablist" aria-label="Filter threads" className="flex gap-6 border-b border-le-border">
      {TABS.map((t, i) => {
        const selected = t.key === current;
        return (
          <Link
            key={t.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`tab-${t.key}`}
            href={t.href}
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "focus-ring -mb-px inline-flex h-10 items-center border-b-2 text-body max-md:h-11",
              selected ? "border-le-accent font-medium text-le-text" : "border-transparent text-le-text-secondary hover:text-le-text",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
