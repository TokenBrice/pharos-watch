import { isRecord, stringValue } from "@shared/lib/type-guards";
import type { StablecoinLink } from "@shared/types";

/** Read client-safe links from a raw projection boundary without changing order. */
export function readStablecoinLinks(value: unknown): StablecoinLink[] {
  if (!Array.isArray(value)) return [];
  const links: StablecoinLink[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const label = stringValue(item.label);
    const url = stringValue(item.url);
    if (label && url) links.push({ label, url });
  }
  return links;
}

/** Keep the first label for each URL while preserving source order. */
export function dedupeStablecoinLinksByUrl(links: readonly StablecoinLink[]): StablecoinLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}
