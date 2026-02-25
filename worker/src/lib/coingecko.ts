/**
 * CoinGecko API helper.
 * Paid plans (Basic/Analyst/Lite) use pro-api.coingecko.com with an API key header.
 * Falls back to the free public API if no key is configured.
 */

const CG_FREE_BASE = "https://api.coingecko.com/api/v3";
const CG_PRO_BASE = "https://pro-api.coingecko.com/api/v3";

let apiKey: string | null = null;

export function initCoinGecko(key: string | undefined): void {
  apiKey = key?.trim() || null;
}

/** Build a full CoinGecko API URL for the given path (e.g. "/simple/price?ids=..."). */
export function cgUrl(path: string): string {
  const base = apiKey ? CG_PRO_BASE : CG_FREE_BASE;
  return `${base}${path}`;
}

/** Return headers that include the API key when configured. Merges with any extra headers. */
export function cgHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (apiKey) {
    headers["x-cg-pro-api-key"] = apiKey;
  }
  return headers;
}
