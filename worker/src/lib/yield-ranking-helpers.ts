import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { computePysComponents } from "@shared/lib/yield-scoring";
import type { YieldPysNullReason } from "@shared/types/yield";

const YIELD_STALE_THRESHOLD_SYNC_CYCLES = 3;
export const STALE_THRESHOLD_MS = CRON_INTERVALS["sync-yield-data"] * YIELD_STALE_THRESHOLD_SYNC_CYCLES * 1000;
const SUPPLEMENTAL_STALE_THRESHOLD_CYCLES = 1.5;
export const SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS =
  CRON_INTERVALS["sync-yield-supplemental"] * SUPPLEMENTAL_STALE_THRESHOLD_CYCLES * 1000;
export const SLOW_NAV_SOURCE_STALE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
const SLOW_NAV_SOURCE_KEYS = new Set([
  "protocol-api:hashnote-usyc",
  "protocol-api:midas-mmev-nav-oracle",
  "protocol-api:re-protocol-reusd",
]);
export const PRICE_DERIVED_STALE_THRESHOLD_MS = 36 * 60 * 60 * 1000;
export const RATE_DERIVED_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;
export const COMPARISON_ANCHOR_STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;
export const LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS = 45 * 24 * 60 * 60 * 1000;

interface PysNullReasonInput {
  apy30d: number;
  safetyScore: number | null;
  apyVarianceScore: number;
  scalingFactor: number;
  benchmarkRate?: number | null;
  sourceRiskPenalty?: number | null;
}

// Raw apy30d/scalingFactor accompany effectiveYield because computePysComponents
// folds a non-finite apy30d to 0, hiding it from this ladder.
export function derivePysNullReasonFromComponents(
  apy30d: number,
  scalingFactor: number,
  effectiveYield: number,
): YieldPysNullReason | null {
  if (!Number.isFinite(apy30d)) return "missing-inputs";
  if (apy30d <= 0) return "apy-non-positive";
  if (!Number.isFinite(scalingFactor) || scalingFactor <= 0) return "scaling-invalid";
  if (effectiveYield <= 0) return "effective-yield-non-positive";
  return null;
}

export function derivePysNullReason(input: PysNullReasonInput): YieldPysNullReason | null {
  if (!Number.isFinite(input.apy30d)) return "missing-inputs";
  if (input.apy30d <= 0) return "apy-non-positive";
  if (!Number.isFinite(input.scalingFactor) || input.scalingFactor <= 0) return "scaling-invalid";
  const { effectiveYield } = computePysComponents({
    apy30d: input.apy30d,
    safetyScore: input.safetyScore,
    apyVarianceScore: input.apyVarianceScore,
    benchmarkRate: input.benchmarkRate,
    sourceRiskPenalty: input.sourceRiskPenalty,
  });
  return derivePysNullReasonFromComponents(input.apy30d, input.scalingFactor, effectiveYield);
}

function isSupplementalOnchainSource(sourceKey: string | null | undefined): boolean {
  return sourceKey?.startsWith("aave-v3-onchain:") === true || sourceKey?.startsWith("compound-v3:") === true;
}

export function getRankingStaleThresholdMs(dataSource: string, sourceKey?: string | null): number {
  if (dataSource === "price-derived") return PRICE_DERIVED_STALE_THRESHOLD_MS;
  if (dataSource === "rate-derived") return RATE_DERIVED_STALE_THRESHOLD_MS;
  if (dataSource === "protocol-api" && sourceKey != null && SLOW_NAV_SOURCE_KEYS.has(sourceKey)) {
    return SLOW_NAV_SOURCE_STALE_THRESHOLD_MS;
  }
  if (dataSource === "protocol-api" || (dataSource === "onchain" && isSupplementalOnchainSource(sourceKey))) {
    return SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS;
  }
  return STALE_THRESHOLD_MS;
}

export type YieldSourceFreshness = "fresh" | "stale" | "unknown";

export function classifyYieldSourceFreshness(input: {
  dataSource: string;
  sourceKey?: string | null;
  sourceAgeSeconds: number | null;
  comparisonAnchorAgeSeconds?: number | null;
}): YieldSourceFreshness {
  const staleThresholdMs = getRankingStaleThresholdMs(input.dataSource, input.sourceKey);
  if (
    input.comparisonAnchorAgeSeconds != null &&
    input.comparisonAnchorAgeSeconds * 1000 > getComparisonAnchorStaleThresholdMs(input.dataSource, input.sourceKey)
  ) {
    return "stale";
  }
  if (input.sourceAgeSeconds == null || !Number.isFinite(input.sourceAgeSeconds)) return "unknown";
  return input.sourceAgeSeconds * 1000 > staleThresholdMs ? "stale" : "fresh";
}

function isLongHorizonNavAnchor(sourceKey: string | null | undefined): boolean {
  return sourceKey?.includes("protocol-api:ondo-usdy-oracle") === true
    || sourceKey?.includes("protocol-api:midas-mmev-nav-oracle") === true;
}

export function getComparisonAnchorStaleThresholdMs(
  dataSource: string,
  sourceKey?: string | null,
): number {
  if (dataSource === "price-derived" || isLongHorizonNavAnchor(sourceKey)) {
    return LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS;
  }
  return COMPARISON_ANCHOR_STALE_THRESHOLD_MS;
}
