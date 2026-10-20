/** Settings loading state: skeleton form (SITE_CONTRACT §2.14). */
export default function SettingsLoading() {
  return (
    <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 md:pt-8 lg:px-8" aria-busy="true">
      <div className="mt-12 space-y-4" aria-hidden>
        <div className="h-8 w-40 rounded-control bg-le-surface-sunken" />
        <div className="h-6 w-24 rounded-control bg-le-surface-sunken" />
        <div className="h-10 w-full rounded-control bg-le-surface-sunken" />
      </div>
    </main>
  );
}
