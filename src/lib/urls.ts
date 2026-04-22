import type { VariantKind } from "@shared/types";

/**
 * Build the canonical URL path for a stablecoin detail page.
 * Encodes the ID to handle future ticker-issuer format safely.
 */
export function buildStablecoinUrl(id: string): string {
  return "/stablecoin/" + encodeURIComponent(id) + "/";
}

export function buildHomepageVariantBrowseUrl(kind?: VariantKind | null): string {
  if (!kind) {
    return "/?variant=variant-tracked";
  }
  return `/?variant=${encodeURIComponent(`variant-${kind}`)}`;
}
