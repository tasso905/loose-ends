import type { Metadata } from "next";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { Wordmark } from "@/components/Wordmark";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Today" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Placeholder for Today (F10 is not built yet): enough for the sign-in redirect flow. Ranking,
 * sections and states from SITE_CONTRACT §2.5 / §2.14 arrive with F10.
 */
export default async function TodayPage({ searchParams }: { searchParams: SearchParams }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const x of [v].flat()) if (x !== undefined) params.append(k, x);
  const qs = params.toString();
  await requireUser(qs ? `/today?${qs}` : "/today");

  return (
    <>
      <header className="mx-auto flex w-full max-w-column items-center justify-between gap-4 px-4 pt-6 sm:px-6 md:pt-8 lg:px-8">
        <Wordmark />
        <SignOutButton />
      </header>
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        <h1 className="text-display-sm text-le-text sm:text-display">Today</h1>
      </main>
    </>
  );
}
