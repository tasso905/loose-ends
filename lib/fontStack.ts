export type LoadedFont = { style: { fontFamily: string } };

/**
 * One font-family list for a face loaded as several next/font calls (one per unicode-range subset):
 * the latin family, then each extra subset's family, then the latin call's size-adjusted fallback.
 * "'plexSans', 'plexSans Fallback'" + "'plexSansGreek'" → "'plexSans', 'plexSansGreek', 'plexSans Fallback'".
 * Names come from next/font at runtime, so the list stays right if a build hashes them.
 */
export function fontStack(latin: LoadedFont, subsets: LoadedFont[]): string {
  const split = (s: string) => s.split(/,\s*/).filter(Boolean);
  const [main, ...fallbacks] = split(latin.style.fontFamily);
  return [main, ...subsets.flatMap((f) => split(f.style.fontFamily)), ...fallbacks].join(", ");
}
