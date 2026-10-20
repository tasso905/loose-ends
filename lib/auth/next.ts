/**
 * The `next` parameter guard (SITE_CONTRACT §1.2 "Signed-out access", D38).
 *
 * Only same-site relative paths are honoured; anything else falls back to /today. The input is the
 * value as URLSearchParams already decoded it once. It is rejected when it, or any further-decoded
 * form of it, could be read by a browser or server as pointing off-site: protocol-relative (`//`),
 * backslash tricks (`/\evil`), control characters, schemes, or a resolved origin that is not ours.
 */

export const DEFAULT_NEXT = "/today";

const MAX_LENGTH = 2048;
const PROBE_ORIGIN = "http://next-guard.invalid";

/** Routes that must never be a post-sign-in destination (they would loop or re-run auth). */
const NON_DESTINATIONS = ["/sign-in", "/auth", "/onboarding"];

/**
 * The value plus up to three further-decoded forms, or null if a layer cannot be decoded at all.
 * A stray "%" (one not followed by two hex digits, like the literal "%" in `?q=why 20% raise`) is
 * escaped as "%25" first, so it cannot switch off the checks on the layers below it (R1). What still
 * fails to decode after that is an invalid UTF-8 escape run: no legitimate link of ours contains
 * one, so it is rejected rather than trusted.
 */
function decodeLayers(value: string): string[] | null {
  const layers = [value];
  let current = value;
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current.replace(/%(?![0-9a-f]{2})/gi, "%25"));
    } catch {
      return null;
    }
    if (decoded === current) break;
    layers.push(decoded);
    current = decoded;
  }
  return layers;
}

function looksOffSite(layer: string): boolean {
  if (!layer.startsWith("/")) return true;
  if (layer.startsWith("//")) return true;
  // Only the path decides where a browser goes; a query may legitimately hold spaces (`?q=`).
  const path = layer.split(/[?#]/, 1)[0] ?? "";
  if (path.includes("\\")) return true;
  // Control characters, whitespace (including Unicode spaces) and look-alike slashes.
  if (/[\u0000-\u001f\u007f\s\u2215\uff0f\u2044]/.test(path)) return true;
  return false;
}

/** An auth route, including with stray trailing characters ("/sign-in%", "/auth.x"); "/authority" is not. */
const NON_DESTINATION_RE = new RegExp(`^(${NON_DESTINATIONS.map((p) => p.replace(/[-/]/g, "\\$&")).join("|")})(?![a-z0-9_])`, "i");
const isNonDestination = (path: string) => NON_DESTINATION_RE.test(path);

/** One pass of the guard: the normalised path, or null if any check fails. */
function guardOnce(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_LENGTH) return null;
  const layers = decodeLayers(raw);
  if (!layers || layers.some(looksOffSite)) return null;

  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;

  const path = url.pathname;
  // Dot segments can normalise into a protocol-relative path ("/.//evil.com" → "//evil.com").
  if (path.startsWith("//") || path.includes("\\")) return null;
  if (path === "/") return null;
  const pathLayers = decodeLayers(path);
  if (!pathLayers || pathLayers.some((p) => isNonDestination(p.split(/[?#]/, 1)[0] ?? ""))) return null;

  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Returns a safe same-site path (with query and hash), or DEFAULT_NEXT. Idempotent: the normalised
 * output is guarded again, so no later hop that decodes or re-normalises it can reach another origin.
 */
export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== "string") return DEFAULT_NEXT;
  const once = guardOnce(raw);
  if (once === null) return DEFAULT_NEXT;
  const twice = guardOnce(once);
  return twice === once ? once : DEFAULT_NEXT;
}

/** `/sign-in` with a safe `next` carried (SITE_CONTRACT §1.2); unsafe or absent values are dropped. */
export function signInPath(next: string | null | undefined, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  const dest = safeNext(next);
  if (next && (dest !== DEFAULT_NEXT || next === DEFAULT_NEXT)) params.set("next", dest);
  const qs = params.toString();
  return qs ? `/sign-in?${qs}` : "/sign-in";
}

/** `/onboarding` with `next` carried, omitting it when it is the default destination. */
export function onboardingPath(next: string | null | undefined): string {
  const dest = safeNext(next);
  return dest === DEFAULT_NEXT ? "/onboarding" : `/onboarding?${new URLSearchParams({ next: dest })}`;
}
