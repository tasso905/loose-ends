/**
 * Wordmark (DESIGN_STANDARD "Wordmark and favicon"): the mark at 20px, an 8px gap, then
 * "Loose Ends" in Plex Sans 600. Not a heading. The mark is two 2px-stroke lines on one baseline
 * with a 4px gap and rounded caps: a line left unfinished.
 */
export function Wordmark() {
  return (
    <div className="flex items-center gap-2 text-wordmark text-le-text">
      <svg aria-hidden viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <line x1="2" y1="11" x2="9" y2="11" />
        <line x1="15" y1="11" x2="18" y2="11" />
      </svg>
      <span>Loose Ends</span>
    </div>
  );
}
