import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

/** Unknown or another user's extraction: plain not-found, never revealing whether it exists. */
export default function ReviewNotFound() {
  return (
    <main className="mx-auto w-full max-w-column px-4 pt-16 pb-16 text-center sm:px-6 lg:px-8">
      <h1 className="text-h3 text-le-text">This doesn&apos;t exist or was deleted.</h1>
      <Link href="/today" className={buttonVariants({ variant: "secondary", className: "mt-6" })}>
        Go to Today
      </Link>
    </main>
  );
}
