import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Versioned prompt files in /prompts. The version recorded on each extraction is the file stem. */
export const EXTRACT_PROMPT_VERSION = "extract.v3";
export const ASK_WHY_PROMPT_VERSION = "ask-why.v3";

const cache = new Map<string, string>();

/** Loads `/prompts/{version}.md`, dropping the leading comment block (everything up to the first `---` line). */
export function loadPrompt(version: string): string {
  const hit = cache.get(version);
  if (hit) return hit;
  const raw = readFileSync(join(process.cwd(), "prompts", `${version}.md`), "utf8");
  const sep = raw.search(/^---\s*$/m);
  const body = (sep >= 0 ? raw.slice(sep).replace(/^---\s*\n/, "") : raw).trim();
  cache.set(version, body);
  return body;
}

/**
 * First 12 hex characters of sha256 over the whole prompt file (comment header included), so an
 * eval report names the exact text it scored even if a file is edited without a version bump.
 */
export function promptSha(version: string): string {
  const raw = readFileSync(join(process.cwd(), "prompts", `${version}.md`));
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/** Wraps untrusted text in a delimited block, neutralising any closing tag inside it. */
export function block(tag: string, content: string): string {
  const safe = content.replaceAll(`</${tag}>`, `<\\/${tag}>`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}

/** Extracts the content of the first `<tag>…</tag>` block from a prompt (used by the recorded fake). */
export function readBlock(tag: string, prompt: string): string | null {
  const m = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  return m ? (m[1] ?? null) : null;
}
