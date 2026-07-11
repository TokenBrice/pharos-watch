import { toErrorMessage } from "./error-utils";

export type PricingProviderDiagnosticSource =
  | "binance"
  | "kraken"
  | "bitstamp"
  | "coinbase"
  | "coingecko"
  | "cg-ticker"
  | "defillama-list"
  | "defillama-contract"
  | "coinmarketcap"
  | "jupiter"
  | "dexscreener-exact"
  | "dexscreener-address"
  | "dexscreener-search"
  | "dexpaprika-address"
  | "alchemy-address"
  | "moralis-address"
  | "birdeye-address"
  | "coingecko-onchain-address"
  | "geckoterminal"
  | "pyth"
  | "redstone"
  | "curve-onchain"
  | "curve-oracle"
  | "dex-promoted"
  | "protocol-dex"
  | "native-peg"
  | "cached";

export type PricingProviderRejectionReason =
  | "blocked"
  | "empty-response"
  | "invalid-shape"
  | "malformed-json"
  | "missing-quote"
  | "missing-provider"
  | "no-candidates"
  | "non-ok"
  | "price-rejected"
  | "stale"
  | "timeout"
  | "unsupported-quote"
  | "upstream-error";

export interface PricingProviderAttemptDiagnostic {
  source: PricingProviderDiagnosticSource;
  stage: "primary" | "fallback" | "health-probe" | "no-candidates" | "depeg-confirmation";
  endpoint: string;
  status: number | null;
  ok: boolean;
  success: boolean;
  candidateCount?: number;
  responseRowCount?: number;
  matchedCount?: number;
  resolvedCount?: number;
  rejectionReasonCounts?: Partial<Record<PricingProviderRejectionReason, number>>;
  errorClass?: string;
  errorMessage?: string;
  snippet?: string;
  retryAfterSec?: number;
}

const MAX_SNIPPET_CHARS = 240;

export function endpointLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url.slice(0, MAX_SNIPPET_CHARS);
  }
}

export function errorClassFor(error: unknown): string {
  if (error instanceof DOMException && error.name) return error.name;
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

export function errorMessageFor(error: unknown): string {
  const raw = toErrorMessage(error);
  return sanitizeSnippet(raw);
}

function sanitizeSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET_CHARS);
}

export async function readResponseSnippet(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    const snippet = sanitizeSnippet(text);
    return snippet.length > 0 ? snippet : undefined;
  } catch {
    return undefined;
  }
}
