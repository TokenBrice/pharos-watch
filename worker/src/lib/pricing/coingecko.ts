/**
 * CoinGecko API helper.
 * Paid plans (Basic/Analyst/Lite) use pro-api.coingecko.com with an API key header.
 * Falls back to the free public API if no key is configured.
 */

const CG_FREE_BASE = "https://api.coingecko.com/api/v3";
const CG_PRO_BASE = "https://pro-api.coingecko.com/api/v3";

/** Normalize a raw env key to a trimmed string or null. */
export function normalizeCgApiKey(key: string | undefined): string | null {
  return key?.trim() || null;
}

/** Build a full CoinGecko API URL for the given path (e.g. "/simple/price?ids=..."). */
export function cgUrl(path: string, apiKey: string | null = null): string {
  const base = apiKey ? CG_PRO_BASE : CG_FREE_BASE;
  return `${base}${path}`;
}

/** Build a CoinGecko simple-price path with unrounded price precision. */
export function cgSimplePricePath(query: string | URLSearchParams): string {
  const params = new URLSearchParams(typeof query === "string" ? query : query.toString());
  params.set("precision", "full");
  return `/simple/price?${params.toString()}`;
}

/** Return headers that include the API key when configured. Merges with any extra headers. */
export function cgHeaders(extra?: Record<string, string>, apiKey: string | null = null): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (apiKey) {
    headers["x-cg-pro-api-key"] = apiKey;
  }
  return headers;
}
