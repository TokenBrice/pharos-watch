/**
 * Build the canonical URL path for a stablecoin detail page.
 * Encodes the ID to handle future ticker-issuer format safely.
 */
export function buildStablecoinUrl(id: string): string {
  return "/stablecoin/" + encodeURIComponent(id) + "/";
}
