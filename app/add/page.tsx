import type { Metadata } from "next";
import { formatInTimeZone } from "date-fns-tz";
import Link from "next/link";
import { ClipboardPaste, FileUp } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { PasteForm } from "@/components/capture/PasteForm";
import { UploadForm } from "@/components/capture/UploadForm";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getNow, isDemoMode } from "@/lib/time";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Add" };
// The paste server action runs the extraction pipeline in after(); it inherits this limit
// (PRD Technical Architecture "Extraction timeouts").
export const maxDuration = 60;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type Mode = "paste" | "upload";

/** Add tabs (SITE_CONTRACT §2.2; DESIGN_STANDARD Iconography). Quick add (F4) joins when it ships. */
const MODES: { key: Mode; label: string; href: string; Icon: typeof FileUp }[] = [
  { key: "paste", label: "Paste", href: "/add?mode=paste", Icon: ClipboardPaste },
  { key: "upload", label: "Upload", href: "/add?mode=upload", Icon: FileUp },
];

/**
 * Add / Capture (F2, F3; SITE_CONTRACT §2.2). `?mode=paste` (default) and `?mode=upload`.
 * `?mode=quick` (F4) is not built yet and shows Paste. The modes are links, so Back keeps the mode.
 */
export default async function AddPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).mode;
  const mode = Array.isArray(raw) ? raw[0] : raw;
  const user = await requireUser(mode ? `/add?mode=${encodeURIComponent(mode)}` : "/add");

  const supabase = await createClient();
  const [{ data: profile }, settings] = await Promise.all([
    supabase.from("profiles").select("timezone").eq("id", user.id).maybeSingle(),
    isDemoMode()
      ? supabase.from("user_settings").select("demo_now").eq("user_id", user.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const timezone = (profile?.timezone as string | undefined) ?? "UTC";
  const demoNow = (settings.data as { demo_now?: string | null } | null)?.demo_now ?? null;
  const today = formatInTimeZone(getNow({ demoNow }), timezone, "yyyy-MM-dd");
  const current: Mode = mode === "upload" ? "upload" : "paste";

  return (
    <>
      <AppHeader current={null} />
      <main className="mx-auto w-full max-w-column px-4 pt-6 pb-16 sm:px-6 lg:px-8">
        <h1 className="text-display-sm text-le-text sm:text-display">Drop something in</h1>
        <nav aria-label="Add mode" className="mt-4 flex gap-6 border-b border-le-border">
          {MODES.map(({ key, label, href, Icon }) => (
            <Link
              key={key}
              href={href}
              aria-current={key === current ? "page" : undefined}
              className={cn(
                "focus-ring -mb-px inline-flex h-10 items-center gap-2 border-b-2 text-body max-md:h-11",
                key === current ? "border-le-accent font-medium text-le-text" : "border-transparent text-le-text-secondary hover:text-le-text",
              )}
            >
              <Icon aria-hidden strokeWidth={1.75} className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        {current === "upload" ? <UploadForm today={today} userId={user.id} /> : <PasteForm today={today} />}
      </main>
    </>
  );
}
