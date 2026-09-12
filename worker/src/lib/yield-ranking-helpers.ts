import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { computePysComponents } from "@shared/lib/yield-scoring";
import type { YieldPysNullReason } from "@shared/types/yield";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const YIELD_STALE_THRESHOLD_SYNC_CYCLES = 3;
export const STALE_THRESHOLD_MS = CRON_INTERVALS["sync-yield-data"] * YIELD_STALE_THRESHOLD_SYNC_CYCLES * 1000;
const SUPPLEMENTAL_STALE_THRESHOLD_CYCLES = 1.5;
export const SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS =
  CRON_INTERVALS["sync-yield-supplemental"] * SUPPLEMENTAL_STALE_THRESHOLD_CYCLES * 1000;
export const SLOW_NAV_SOURCE_STALE_THRESHOLD_MS = 3 * DAY_MS;
const SLOW_NAV_SOURCE_KEYS = new Set([
  "protocol-api:hashnote-usyc",
  "protocol-api:midas-mmev-nav-oracle",
  "protocol-api:re-protocol-reusd",
]);
/**
 * Freshness tiers are anchored on the cadence at which each source class
 * actually receives a new observation (B21; measured on the live payload
 * 2026-09-12, n=157):
 *
 * | class                          | cadence | aging | stale |
 * |--------------------------------|---------|-------|-------|
 * | hourly families (`sync-yield-data`) | 1h | 2h    | 3h    |
 * | supplemental families          | 4h      | 5h    | 6h    |
 * | price-derived daily snapshot   | 24h     | 27h   | 30h   |
 * | rate-derived daily benchmark   | 24h     | 30h   | 36h   |
 * | slow NAV oracles               | 24h     | 48h   | 72h   |
 *
 * `aging` is the midpoint between a class cadence and its stale bound
 * ("missed its refresh slot, not yet stale"), which is exactly 2x the producer
 * cadence for the default hourly class. Measured before this change: all 30
 * price-derived rows sat at 23.9h and every rate-derived row at 15.9h while all
 * read `fresh`, so a dead daily feed stayed silently fresh for up to 36-48h.
 * Narrowed 2026-09-12: price-derived 36h -> 30h (1.25 daily cadences),
 * rate-derived 48h -> 36h (1.5 daily cadences).
 */
export const PRICE_DERIVED_STALE_THRESHOLD_MS = 30 * HOUR_MS;
export const RATE_DERIVED_STALE_THRESHOLD_MS = 36 * HOUR_MS;
export const COMPARISON_ANCHOR_STALE_THRESHOLD_MS = 14 * DAY_MS;
export const LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS = 45 * DAY_MS;

interface PysNullReasonInput {
  apy30d: number;
  safetyScore: number | null;
  apyVarianceScore: number;
  scalingFactor: number;
  benchmarkRate?: number | null;
  /** Currency the row's benchmark is quoted in — see `computePysComponents` (B24). */
  benchmarkCurrency?: string | null;
  /** Reference (USD) risk-free rate — see `computePysComponents`. */
  usdBenchmarkRate?: number | null;
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
    benchmarkCurrency: input.benchmarkCurrency,
    usdBenchmarkRate: input.usdBenchmarkRate,
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

/** Observation cadence for a ranking source class (see the tier table above). */
function getRankingProducerCadenceMs(dataSource: string, sourceKey?: string | null): number {
  if (
    dataSource === "price-derived" ||
    dataSource === "rate-derived" ||
    (dataSource === "protocol-api" && sourceKey != null && SLOW_NAV_SOURCE_KEYS.has(sourceKey))
  ) {
    return DAY_MS;
  }
  if (dataSource === "protocol-api" || (dataSource === "onchain" && isSupplementalOnchainSource(sourceKey))) {
    return CRON_INTERVALS["sync-yield-supplemental"] * 1000;
  }
  return CRON_INTERVALS["sync-yield-data"] * 1000;
}

/** `aging` boundary: the midpoint between a class cadence and its stale bound. */
function getRankingAgingThresholdMs(dataSource: string, sourceKey?: string | null): number {
  const cadenceMs = getRankingProducerCadenceMs(dataSource, sourceKey);
  return cadenceMs + (getRankingStaleThresholdMs(dataSource, sourceKey) - cadenceMs) / 2;
}

export type YieldSourceAgeTier = "fresh" | "aging" | "stale" | "unknown";

/**
 * Observation-age tier for a ranking row (B21). Unlike
 * {@link classifyYieldSourceFreshness} it ignores the published label and the
 * comparison anchor, so the read path can emit the second-tier `aging` signal
 * for an observation that missed its refresh slot without re-deriving the
 * provenance freshness contract.
 */
export function classifyYieldSourceAgeTier(input: {
  dataSource: string;
  sourceKey?: string | null;
  sourceAgeSeconds: number | null;
}): YieldSourceAgeTier {
  if (input.sourceAgeSeconds == null || !Number.isFinite(input.sourceAgeSeconds)) return "unknown";
  const ageMs = input.sourceAgeSeconds * 1000;
  if (ageMs > getRankingStaleThresholdMs(input.dataSource, input.sourceKey)) return "stale";
  return ageMs > getRankingAgingThresholdMs(input.dataSource, input.sourceKey) ? "aging" : "fresh";
}

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
