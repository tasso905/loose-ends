import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";
import { renderInline } from "@/components/privacy/PrivacyText";
import { PRIVACY_COPY as C, privacySections } from "@/lib/privacy/copy";

export const metadata: Metadata = { title: C.title };

// Static: no cookies, no session, no data reads (SITE_CONTRACT §2.15), so it renders the same for
// everyone and works while Supabase is down.
export const dynamic = "force-static";

/**
 * Privacy (D77, D82; SITE_CONTRACT §2.15). Sections 1–10 of docs/PRIVACY.md, Proposed text only.
 * The wordmark links to /sign-in, which sends a signed-in visitor on to Today. Any next/link on
 * this page takes prefetch={false} (see below); the content links are plain <a> and never prefetch.
 */
export default function PrivacyPage() {
  const sections = privacySections();
  return (
    <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 md:pt-8 lg:px-8">
      {/* No prefetch: a prefetched /sign-in during an Auth outage made the proxy clear the session
          (lead-tester, Nov 8), so opening /privacy signed the visitor out. Fetched on click only. */}
      <Link
        href="/sign-in"
        prefetch={false}
        className="focus-ring inline-flex rounded-control max-md:min-h-11 max-md:items-center"
      >
        <Wordmark />
      </Link>
      <h1 className="mt-12 text-display-sm text-le-text max-sm:mt-10 sm:text-display">{C.heading}</h1>
      {sections.map((s, i) => {
        const id = `privacy-section-${i + 1}`;
        return (
          <section key={s.heading} aria-labelledby={id} className="mt-10 max-w-prose">
            <h2 id={id} className="text-h2 text-le-text">
              {s.heading}
            </h2>
            <div className="mt-3 space-y-3">
              {s.sentences.map((p) => (
                <p key={p.id} data-privacy-id={p.id} className="text-body text-le-text">
                  {renderInline(p.text)}
                </p>
              ))}
            </div>
          </section>
        );
      })}
    </main>
  );
}
