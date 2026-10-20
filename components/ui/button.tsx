import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Button recipe from DESIGN_STANDARD (Component padding and sizes; Hover, focus, pressed, disabled).
 * Tailwind v4 `hover:` already applies only on `(hover: hover)` devices.
 */
export const buttonVariants = cva(
  [
    "focus-ring inline-flex items-center justify-center gap-2 rounded-control text-body-strong",
    "transition-colors duration-(--le-dur-fast) ease-(--le-ease-out) active:duration-(--le-dur-press)",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "[&_svg]:size-5 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-le-accent text-le-text-on-accent hover:enabled:bg-le-accent-hover active:enabled:bg-le-accent-pressed",
        secondary:
          "border border-le-border-strong bg-le-surface text-le-text hover:enabled:bg-le-surface-sunken active:enabled:bg-le-border",
        ghost: "text-le-text-secondary hover:enabled:bg-le-surface-sunken hover:enabled:text-le-text active:enabled:bg-le-border",
      },
      size: {
        default: "h-10 px-4 max-md:h-11",
        small: "h-8 px-3 text-small max-md:h-11",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
