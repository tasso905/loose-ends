import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The DESIGN_STANDARD type scale (app/globals.css `--text-*`) as font sizes. Without this,
 * tailwind-merge reads `text-small` as a colour and drops a colour class next to it (a primary
 * `size="small"` button lost its white label).
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "display-sm", "h2", "h3", "body", "body-strong", "small", "label", "eyebrow", "wordmark"] }],
    },
  },
});

/** shadcn/ui class merge helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
