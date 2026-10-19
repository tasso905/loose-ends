import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { decideRoute, isPublicPath } from "@/lib/auth/routing";
import { redirectResponse } from "@/lib/auth/signIn";
import { supabasePublicEnv } from "@/lib/supabase/env";

/**
 * Refreshes the Supabase session cookie on every page request (PRD Authentication) and applies the
 * signed-out routing in SITE_CONTRACT §1.2 / D38. Pages re-check the user with getUser(); this is
 * not the only guard.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  let cacheHeaders: Record<string, string> = {};
  const { url, anonKey } = supabasePublicEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        cacheHeaders = { ...cacheHeaders, ...(headers ?? {}) };
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
      },
    },
  });

  const { pathname, search } = request.nextUrl;

  // getClaims() validates the JWT signature and expiry, and refreshes an expired session.
  const { data } = await supabase.auth.getClaims();
  let signedIn = Boolean(data?.claims?.sub);

  // A JWT can outlive its session (signed out elsewhere, account deleted). Before sending anyone away
  // from /sign-in or /, ask Auth itself, the same check requireUser() makes, so the two never disagree
  // and bounce between /today and /sign-in (B1). A dead session's cookies are cleared here.
  if (signedIn && (pathname === "/" || isPublicPath(pathname))) {
    const { data: u, error } = await supabase.auth.getUser();
    if (error || !u.user) {
      signedIn = false;
      await supabase.auth.signOut({ scope: "local" });
    }
  }

  const decision = decideRoute({ pathname, search, signedIn });
  if (decision.kind === "continue") return response;

  const redirect = redirectResponse(decision.to);
  // Keep any refreshed or cleared session cookies on the redirect.
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  for (const [k, v] of Object.entries(cacheHeaders)) redirect.headers.set(k, v);
  return redirect;
}

export const config = {
  // Every route except Next.js internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)"],
};
