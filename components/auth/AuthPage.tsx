import { Wordmark } from "@/components/Wordmark";

/** Shared frame for sign-in and onboarding: centred column, page padding and gutters per DESIGN_STANDARD Layout. */
export function AuthPage({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-narrow px-4 pt-6 pb-16 sm:px-6 md:pt-8 lg:px-8">
      <Wordmark />
      <div className="mt-12 max-sm:mt-10">{children}</div>
    </main>
  );
}
