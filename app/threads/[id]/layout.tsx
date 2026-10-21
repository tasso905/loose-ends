import { notFound } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{ id: string }>;

/**
 * Existence gate for /threads/[id], outside every loading boundary (the list's loading.tsx lives
 * in the (list) route group; this segment's own loading.tsx sits inside this layout). A layout
 * renders before any loading UI streams, so `notFound()` here is a real HTTP 404, not a 200 with
 * the not-found UI (same pattern as app/settings/layout.tsx). The not-found UI is
 * app/threads/not-found.tsx, the nearest boundary above this layout.
 *
 * RLS limits the read to the caller's rows, so an unknown id and another user's thread are the
 * same 404 and existence is never revealed. A failed query (not "no row") falls through to the
 * page, which shows the load error with Try again (SITE_CONTRACT §2.14).
 */
export default async function ThreadLayout({ children, params }: { children: React.ReactNode; params: Params }) {
  const { id } = await params;
  await requireUser(`/threads/${encodeURIComponent(id)}`);
  if (!z.uuid().safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data, error } = await supabase.from("threads").select("id").eq("id", id).maybeSingle();
  if (!error && !data) notFound();
  return children;
}
