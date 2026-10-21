import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { THREADS_COPY as C } from "@/lib/threads/view";

/** Unknown or another user's thread (SITE_CONTRACT §1.2): plain not-found, never revealing existence. */
export default function ThreadNotFound() {
  return (
    <main className="mx-auto w-full max-w-column px-4 pt-16 pb-16 text-center sm:px-6 lg:px-8">
      <h1 className="text-h3 text-le-text">{C.notFound}</h1>
      <Link href="/today" className={buttonVariants({ variant: "secondary", className: "mt-6" })}>
        {C.goToToday}
      </Link>
    </main>
  );
}
