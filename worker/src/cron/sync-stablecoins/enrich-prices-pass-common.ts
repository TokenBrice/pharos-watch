import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  buildPriceReasonablenessOptions,
  isReasonablePrice,
} from "../../lib/price-validation";
import type { PriceObservedAtMode } from "@shared/types/core";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import { hasMissingPrice, type PeggedAsset } from "./enrich-prices-shared";

const FALLBACK_FUTURE_TIMESTAMP_SKEW_SEC = 120;

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
