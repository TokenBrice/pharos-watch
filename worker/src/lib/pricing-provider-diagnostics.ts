import { toErrorMessage } from "./error-utils";
import { isReplaySafePriceSource } from "@shared/lib/pricing-source-policy";

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

export type PricingAssetAttemptState = "attempted" | "skipped";

export type PricingAssetAttemptResult = "resolved" | "empty" | "rejected" | "failed" | "unresolved";

export type PricingAssetAttemptSkipReason =
  | "budget"
  | "circuit-open"
  | "deadline"
  | "missing-provider"
  | "negative-cache"
  | "provider-suppressed"
  | "request-cap";

/**
 * Asset-attributable pricing telemetry. Values are deliberately identifiers,
 * never request URLs or payloads, so this structure is safe to persist in cron
 * metadata without leaking provider credentials.
 */
export interface PricingAssetAttemptRecord {
  assetId: string;
  adapter: string;
  source: string;
  chain?: string;
  target?: string;
  state: PricingAssetAttemptState;
  skipReason?: PricingAssetAttemptSkipReason;
  result?: PricingAssetAttemptResult;
  rejectionClass?: string;
  candidateAt?: number;
  observedAt?: number | null;
  replaySafe: boolean;
}

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
  assetAttempts?: PricingAssetAttemptRecord[];
}

const MAX_SNIPPET_CHARS = 240;
const MAX_DIAGNOSTIC_IDENTIFIER_CHARS = 160;
export const MAX_ASSET_ATTEMPTS_PER_DIAGNOSTIC = 100;

function sanitizeIdentifier(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_DIAGNOSTIC_IDENTIFIER_CHARS);
}

function normalizeTimestamp(value: number | null | undefined): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function createPricingAssetAttempt(input: {
  assetId: string;
  adapter: string;
  source?: string;
  chain?: string;
  target?: string;
  state: PricingAssetAttemptState;
  skipReason?: PricingAssetAttemptSkipReason;
  result?: PricingAssetAttemptResult;
  rejectionClass?: string;
  candidateAt?: number;
  observedAt?: number | null;
  replaySafe?: boolean;
}): PricingAssetAttemptRecord {
  const source = sanitizeIdentifier(input.source ?? input.adapter);
  const observedAt = normalizeTimestamp(input.observedAt);
  const candidateAt = normalizeTimestamp(input.candidateAt);
  return {
    assetId: sanitizeIdentifier(input.assetId),
    adapter: sanitizeIdentifier(input.adapter),
    source,
    ...(input.chain ? { chain: sanitizeIdentifier(input.chain) } : {}),
    ...(input.target ? { target: sanitizeIdentifier(input.target) } : {}),
    state: input.state,
    ...(input.skipReason ? { skipReason: input.skipReason } : {}),
    ...(input.result ? { result: input.result } : {}),
    ...(input.rejectionClass ? { rejectionClass: sanitizeIdentifier(input.rejectionClass) } : {}),
    ...(candidateAt != null ? { candidateAt } : {}),
    ...(observedAt !== undefined ? { observedAt } : {}),
    replaySafe: input.replaySafe ?? isReplaySafePriceSource(source),
  };
}

export function appendPricingAssetAttempts(
  target: PricingAssetAttemptRecord[],
  attempts: readonly PricingAssetAttemptRecord[],
  maxEntries = MAX_ASSET_ATTEMPTS_PER_DIAGNOSTIC,
): void {
  if (target.length >= maxEntries) return;
  target.push(...attempts.slice(0, maxEntries - target.length));
}

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
