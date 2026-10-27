import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  buildPriceReasonablenessOptions,
  isReasonablePrice,
} from "../../lib/price-validation";
import type { PriceObservedAtMode } from "@shared/types/core";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import { logWorkerEvent } from "../../lib/structured-log";
import { hasMissingPrice, type PeggedAsset } from "./enrich-prices-shared";

const FALLBACK_FUTURE_TIMESTAMP_SKEW_SEC = 120;
const MAX_LOGGED_INVALID_FALLBACK_ROWS = 10;

export interface EnrichPassResult {
  resolved: number;
  failures: string[];
  diagnostics?: PricingProviderAttemptDiagnostic[];
}

export interface DlContractPassResult extends EnrichPassResult {
  pass1: number;
  pass1b: number;
}

export interface FallbackPriceQuote {
  price: number;
  observedAt?: number;
  observedAtMode?: PriceObservedAtMode;
  symbol?: string;
  confidence?: number;
}

export interface MissingPriceCandidate {
  asset: PeggedAsset;
  index: number;
}

export function collectMissingPriceCandidates<T extends object = Record<never, never>>(
  assets: PeggedAsset[],
  enrich?: (asset: PeggedAsset, index: number) => T | null,
): Array<MissingPriceCandidate & T> {
  const candidates: Array<MissingPriceCandidate & T> = [];
  assets.forEach((asset, index) => {
    if (hasMissingPrice(asset)) {
      const extra = enrich ? enrich(asset, index) : ({} as T);
      if (extra != null) {
        candidates.push({ asset, index, ...extra });
      }
    }
  });
  return candidates;
}

/**
 * Validate provider rows one at a time so a malformed quote is quarantined by
 * key/index instead of rejecting its healthy siblings. Logs only bounded keys,
 * never payloads.
 */
export function quarantineInvalidFallbackRows<K extends string | number, T>(
  provider: string,
  rows: Iterable<readonly [K, unknown]>,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): { valid: Array<[K, T]>; invalidKeys: K[] } {
  const valid: Array<[K, T]> = [];
  const invalidKeys: K[] = [];
  for (const [key, row] of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) valid.push([key, parsed.data]);
    else invalidKeys.push(key);
  }
  if (invalidKeys.length > 0) {
    logWorkerEvent({
      scope: "handler", level: "warn", event: "fallback-quote-invalid-shape", provider,
      message: `[enrich-prices] Quarantined ${invalidKeys.length} malformed ${provider} quote rows`,
      metadata: {
        invalidCount: invalidKeys.length,
        validCount: valid.length,
        keys: invalidKeys.slice(0, MAX_LOGGED_INVALID_FALLBACK_ROWS).map((key) => String(key).slice(0, 160)),
      },
    });
  }
  return { valid, invalidKeys };
}

export function isFreshFallbackObservedAt(
  observedAtSec: number | null | undefined,
  maxAgeSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (typeof observedAtSec !== "number" || !Number.isFinite(observedAtSec)) return false;
  if (observedAtSec > nowSec + FALLBACK_FUTURE_TIMESTAMP_SKEW_SEC) return false;
  return nowSec - observedAtSec <= maxAgeSec;
}

export function parseUnixOrIsoTimestampSec(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export function isUsableFallbackPrice(
  asset: PeggedAsset,
  price: number,
  fxRates: Record<string, number> | undefined,
): boolean {
  return isReasonablePrice(
    price,
    asset.pegType as string | undefined,
    fxRates,
    buildPriceReasonablenessOptions(asset),
  );
}

export const SOLANA_MINT_BY_ID = new Map<string, string>();
for (const [id, meta] of ACTIVE_META_BY_ID) {
  const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
  const solanaDeployment = deployments.find((deployment) => deployment.chain === "solana");
  if (solanaDeployment?.address) {
    SOLANA_MINT_BY_ID.set(id, solanaDeployment.address);
  }
}

const activeSymbolCounts = new Map<string, number>();
for (const meta of ACTIVE_META_BY_ID.values()) {
  const symbol = meta.symbol.trim().toUpperCase();
  activeSymbolCounts.set(symbol, (activeSymbolCounts.get(symbol) ?? 0) + 1);
}

export const UNIQUE_ACTIVE_SYMBOLS = new Set(
  [...activeSymbolCounts.entries()]
    .filter(([, count]) => count === 1)
    .map(([symbol]) => symbol),
);
