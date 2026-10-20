import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { supabasePublicEnv } from "@/lib/supabase/env";

/**
 * User-scoped server client for Server Components, Server Actions and Route Handlers. RLS applies.
 * Create one per request. Server Components cannot write cookies; the proxy refreshes the session.
 */
export async function createClient() {
  // Read cookies first: it marks the route dynamic, so nothing auth-dependent is prerendered.
  const store = await cookies();
  const { url, anonKey } = supabasePublicEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          // Called from a Server Component: the proxy has already refreshed the session.
        }
      },
    },
  });
}
