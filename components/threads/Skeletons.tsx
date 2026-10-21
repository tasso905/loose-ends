/** Skeleton rows (DESIGN_STANDARD "Skeleton"): real row height, so nothing jumps when content arrives. */
export function SkeletonRows({ count, label }: { count: number; label: string }) {
  return (
    <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 md:pt-8 lg:px-8" aria-busy="true" aria-label={label}>
      <div className="mt-14 h-8 w-40 animate-skeleton rounded-control bg-le-surface-sunken" aria-hidden />
      <ul className="mt-10 space-y-2" aria-hidden>
        {Array.from({ length: count }, (_, i) => (
          <li key={i} className="h-12 animate-skeleton rounded-card bg-le-surface-sunken" />
        ))}
      </ul>
    </main>
  );
}

/** Thread detail loading: skeleton header + card (SITE_CONTRACT §2.14). */
export function SkeletonDetail() {
  return (
    <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 md:pt-8 lg:px-8" aria-busy="true" aria-label="Loading thread">
      <div aria-hidden>
        <div className="mt-14 h-8 w-3/4 animate-skeleton rounded-control bg-le-surface-sunken" />
        <div className="mt-3 h-3 w-1/3 animate-skeleton rounded-control bg-le-surface-sunken" />
        <div className="mt-8 h-32 animate-skeleton rounded-card bg-le-surface-sunken" />
      </div>
    </main>
  );
}
