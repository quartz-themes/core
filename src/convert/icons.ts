/**
 * Obsidian icon ids → CSS image values.
 *
 * Obsidian themes pick callout icons with `--callout-icon: lucide-flame`
 * (Obsidian draws the SVG at runtime). Quartz paints `.callout-icon` with a
 * CSS mask, so the id must become a data URI at build time.
 */
import { LUCIDE, LUCIDE_ALIASES } from "../generated/lucide";

const cache = new Map<string, string | undefined>();

export function resolveIcon(id: string): string | undefined {
  if (cache.has(id)) return cache.get(id);
  const bare = id.toLowerCase().replace(/^lucide-/, "");
  const name = LUCIDE[bare] !== undefined ? bare : LUCIDE_ALIASES[bare];
  const body = name ? LUCIDE[name] : undefined;
  const uri = body ? svgDataUri(body) : undefined;
  cache.set(id, uri);
  return uri;
}

export function svgDataUri(body: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' ` +
    `stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`;
  const encoded = svg
    .replace(/"/g, "'")
    .replace(/#/g, "%23")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
  return `url("data:image/svg+xml;utf8,${encoded}")`;
}
