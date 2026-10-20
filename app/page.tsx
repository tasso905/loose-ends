import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth/session";

/** `/`: signed in → /today, signed out → /sign-in with no `next` (SITE_CONTRACT §1.2, D38). The proxy does this first. */
export default async function Home() {
  redirect((await getUser()) ? "/today" : "/sign-in");
}
