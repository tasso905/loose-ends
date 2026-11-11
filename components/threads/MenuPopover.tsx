"use client";
import { useEffect, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MenuItemSpec {
  key: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  /** Right-aligned in `small` --text-tertiary tabular figures (DESIGN_STANDARD Snooze menu). */
  detail?: string;
  /** Destructive items sit last, after a 1 px divider, in --danger-fg (DESIGN_STANDARD Overflow menu). */
  danger?: boolean;
  disabled?: boolean;
  /** Responsive visibility (e.g. `md:hidden`): a hidden item is skipped by focus and the arrow keys. */
  className?: string;
}

/** Enabled menu items that are rendered (not hidden by a responsive class). */
const shown = (root: HTMLElement | null) =>
  [...(root?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? [])].filter((el) => el.getClientRects().length > 0);

/**
 * A level-2 popover under its trigger (DESIGN_STANDARD "Overflow menu" and "Snooze menu"): min-width
 * 200 px, items 36 px tall (44 px on mobile), 12 px horizontal padding, 16 px icon + `body` label.
 * With `items` it is a menu (role=menu; Arrow keys move, Escape or Tab closes and returns focus to
 * the trigger); with `children` instead it is a labelled group holding a small form (the `Pick a
 * date…` step), where Tab moves normally and Escape still closes. Focus moves into it when it opens.
 * A pointer down outside it closes it.
 */
export function MenuPopover({
  id,
  label,
  items,
  children,
  triggerRef,
  onDismiss,
  align = "right",
}: {
  id: string;
  label: string;
  items?: MenuItemSpec[];
  children?: React.ReactNode;
  triggerRef: React.RefObject<HTMLElement | null>;
  /** `returnFocus`: Escape and Tab put focus back on the trigger; an outside click does not. */
  onDismiss: (returnFocus: boolean) => void;
  align?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isMenu = items !== undefined;
  const view = isMenu ? items.map((i) => i.key).join(",") : "form";

  useEffect(() => {
    (isMenu ? shown(ref.current)[0] : ref.current?.querySelector<HTMLElement>("input, button"))?.focus();
  }, [isMenu, view]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !triggerRef.current?.contains(t)) onDismiss(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onDismiss, triggerRef]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" || (isMenu && e.key === "Tab")) {
      e.preventDefault();
      e.stopPropagation();
      onDismiss(true);
      return;
    }
    if (!isMenu || (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End")) return;
    e.preventDefault();
    const all = shown(ref.current);
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : e.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  }

  const plain = items?.filter((i) => !i.danger) ?? [];
  const danger = items?.filter((i) => i.danger) ?? [];

  return (
    <div
      ref={ref}
      id={id}
      role={isMenu ? "menu" : "group"}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute z-10 mt-1 min-w-50 rounded-card border border-le-border bg-le-surface-raised py-1 shadow-(--le-shadow-modal)",
        align === "right" ? "right-0" : "left-0",
      )}
    >
      {isMenu ? (
        <>
          {plain.map((i) => (
            <Item key={i.key} item={i} />
          ))}
          {danger.length > 0 ? (
            <>
              {plain.length > 0 ? <div role="separator" className="my-1 border-t border-le-border" /> : null}
              {danger.map((i) => (
                <Item key={i.key} item={i} />
              ))}
            </>
          ) : null}
        </>
      ) : (
        children
      )}
    </div>
  );
}

function Item({ item: i }: { item: MenuItemSpec }) {
  const Icon = i.icon;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={i.onSelect}
      disabled={i.disabled}
      className={cn(
        i.className,
        "group focus-ring flex h-9 w-full items-center gap-2 px-3 text-left text-body whitespace-nowrap max-md:h-11 disabled:cursor-not-allowed disabled:opacity-50",
        i.danger ? "text-le-danger-fg hover:enabled:bg-le-danger-bg" : "text-le-text hover:enabled:bg-le-surface-sunken",
      )}
    >
      {Icon ? <Icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0" /> : null}
      <span className="flex-1">{i.label}</span>
      {/* --text-tertiary on the hover fill (--surface-sunken) measures 4.42:1, under AA, so a hovered item's date uses --text-secondary. */}
      {i.detail ? <span className="pl-4 text-small text-le-text-tertiary tabular-nums group-hover:group-enabled:text-le-text-secondary">{i.detail}</span> : null}
    </button>
  );
}
