import { logWorkerEventArgs } from "../lib/structured-log";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";

/**
 * Yield Pipeline — Pure Computation Functions
 *
 * Contains all math/scoring functions for yield intelligence. No I/O.
 *
 * Functions by pipeline stage:
 * - APY computation:    computeApyFromRate(), computeApyFromPrice()
 * - Scoring:            computePYS() (Pharos Yield Score)
 * - Variance analysis:  computeYieldStability(), computeApyVarianceScore()
 * - Warning detection:  detectWarningSignals()
 * - Pool matching:      matchAllDlPools() (3-layer resolution), findBestLendingPool()
 *
 * I/O counterparts live in yield-sync/: sources.ts (pool discovery), resolve.ts
 * (APY resolution), cache.ts (KV caching), rankings.ts (DB row mapping).
 */
export { buildOnChainSourceKey } from "../lib/yield-utils";

const YIELD_STALE_THRESHOLD_SYNC_CYCLES = 3;
export const STALE_THRESHOLD_MS = CRON_INTERVALS["sync-yield-data"] * YIELD_STALE_THRESHOLD_SYNC_CYCLES * 1000;
// Supplemental families refresh every four hours, so allow one full cycle plus a half-cycle buffer
// before surfacing stale warnings on the hourly publisher.
const SUPPLEMENTAL_STALE_THRESHOLD_CYCLES = 1.5;
export const SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS =
  CRON_INTERVALS["sync-yield-supplemental"] * SUPPLEMENTAL_STALE_THRESHOLD_CYCLES * 1000;
// These protocol-native NAV sources publish less frequently and already reject
// observations older than three days in their adapters.
export const SLOW_NAV_SOURCE_STALE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
const SLOW_NAV_SOURCE_KEYS = new Set([
  "protocol-api:hashnote-usyc",
  "protocol-api:midas-mmev-nav-oracle",
  "protocol-api:re-protocol-reusd",
]);
// Price-derived rows are backed by daily supply-history snapshots, so allow one missed daily write plus buffer.
export const PRICE_DERIVED_STALE_THRESHOLD_MS = 36 * 60 * 60 * 1000;
// Rate-derived rows inherit daily benchmark observations rather than the hourly
// publisher cadence. Allow one missed daily benchmark refresh before warning.
export const RATE_DERIVED_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;
export const DETERMINISTIC_APY_SANITY_MAX = 300;
export const COMPARISON_ANCHOR_STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;
// Price/NAV appreciation sources intentionally select an anchor from a 7-45d
// window. Their anchor is only stale after the window itself has expired.
export const LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS = 45 * 24 * 60 * 60 * 1000;

export {
  computePYS,
  PYS_RISK_PENALTY_FLOOR,
  PYS_RISK_PENALTY_EXPONENT,
  PYS_SUSTAINABILITY_FLOOR,
  PYS_MAX_SOURCE_RISK_PENALTY,
  resolvePysSourceRiskPenalty,
} from "@shared/lib/yield-scoring";
import { computePysComponents } from "@shared/lib/yield-scoring";
import type { YieldPysNullReason } from "@shared/types/yield";
import { normalizeChainId } from "@shared/lib/chains";
import { normalizeDexSymbol } from "../lib/dex-cron-constants";
import { normalizeTokenAddress } from "./dex-liquidity/token-resolution";

// --- Warning signal thresholds ---
const YIELD_SPIKE_THRESHOLD = 2.0;
const YIELD_DIVERGENCE_THRESHOLD = 3.0;
const NEGATIVE_TREND_THRESHOLD = 0.7;
const REWARD_HEAVY_THRESHOLD = 0.8;
const TVL_OUTFLOW_THRESHOLD = -0.2;
const YIELD_SPIKE_MIN_APY = 2.0; // only flag spike if currentApy > 2%
const NEGATIVE_TREND_MIN_APY = 1.0; // only flag negative trend if apy30d > 1%
const ZERO_YIELD_HISTORY_THRESHOLD = 0.5; // flag when current=0 but 30d avg > 0.5%
const BLOCKED_YIELD_OPPORTUNITY_PATTERNS = [
  /\bresolv\b/i,
  /\b(?:usr|stusr|wstusr)\b/i,
];

function normalizeChainFilter(filter: Set<string> | undefined): Set<string> | undefined {
  if (!filter) return undefined;
  return new Set(
    [...filter]
      .map((chain) => normalizeChainId(chain))
      .filter((chain): chain is string => chain !== null),
  );
}

function isChainAllowed(filter: Set<string> | undefined, chain: string | undefined): boolean {
  if (!filter || !chain) return true;
  const chainId = normalizeChainId(chain);
  return chainId !== null && filter.has(chainId);
}

interface PysNullReasonInput {
  apy30d: number;
  safetyScore: number | null;
  apyVarianceScore: number;
  scalingFactor: number;
  benchmarkRate?: number | null;
  sourceRiskPenalty?: number | null;
}

/**
 * Mirrors the null/zero branches of `computePYS` so the UI can explain why a
 * row's score is null. Returns null when the inputs would yield a positive PYS.
 */
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
  if (effectiveYield <= 0) return "effective-yield-non-positive";
  return null;
}

export function computeApyFromRate(rateNow: number, ratePrev: number, days: number): number {
  if (ratePrev <= 0 || rateNow <= 0 || days <= 0) return 0;
  const ratio = rateNow / ratePrev;
  if (ratio === 1) return 0;
  return (Math.pow(ratio, 365.25 / days) - 1) * 100;
}

/**
 * Naming-only alias for {@link computeApyFromRate} used when inputs are token prices
 * rather than exchange rates. No additional transformation is applied.
 */
export function computeApyFromPrice(priceNow: number, pricePrev: number, days: number): number {
  return computeApyFromRate(priceNow, pricePrev, days);
}

export function isDeterministicApyWithinSanityBounds(apy: number): boolean {
  return Number.isFinite(apy) && apy <= DETERMINISTIC_APY_SANITY_MAX;
}

export function computeYieldStability(apySamples: number[]): number | null {
  if (apySamples.length < 2) return null;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (Math.abs(mean) < 1e-10) return null;
  const variance = apySamples.reduce((s, v) => s + (v - mean) ** 2, 0) / apySamples.length;
  const cv = Math.sqrt(variance) / Math.abs(mean);
  if (!Number.isFinite(cv)) return null;
  return Math.max(0, Math.min(1, Math.round((1 - cv) * 100) / 100));
}

export function computeApyVarianceScore(apySamples: number[]): number | null {
  if (apySamples.length < 2) return null;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (Math.abs(mean) < 1e-10) return null;
  const variance = apySamples.reduce((s, v) => s + (v - mean) ** 2, 0) / apySamples.length;
  const cv = Math.sqrt(variance) / Math.abs(mean);
  if (!Number.isFinite(cv)) return null;
  return Math.min(1, cv);
}

interface WarningInput {
  currentApy: number;
  apy30d: number;
  apyReward: number | null;
  medianApy: number;
  sourceTvlUsd: number | null;
  prevTvlUsd: number | null;
}

export function detectWarningSignals(input: WarningInput): string[] {
  const signals: string[] = [];
  if (input.apy30d > 0 && input.currentApy > YIELD_SPIKE_MIN_APY && input.currentApy / input.apy30d > YIELD_SPIKE_THRESHOLD) signals.push("yield-spike");
  if (input.medianApy > 0 && input.currentApy > input.medianApy * YIELD_DIVERGENCE_THRESHOLD) signals.push("yield-divergence");
  if (input.apy30d > NEGATIVE_TREND_MIN_APY && input.currentApy < input.apy30d * NEGATIVE_TREND_THRESHOLD) signals.push("negative-trend");
  if (input.apyReward != null && input.currentApy > 0 && input.apyReward / input.currentApy > REWARD_HEAVY_THRESHOLD) signals.push("reward-heavy");
  if (input.sourceTvlUsd != null && input.prevTvlUsd != null && input.prevTvlUsd > 0) {
    const change = (input.sourceTvlUsd - input.prevTvlUsd) / input.prevTvlUsd;
    if (change < TVL_OUTFLOW_THRESHOLD) signals.push("tvl-outflow");
  }
  if (input.currentApy === 0 && input.apy30d > ZERO_YIELD_HISTORY_THRESHOLD) signals.push("zero-yield");
  return signals;
}

export function isBlockedYieldOpportunitySource(params: {
  yieldSource?: string | null;
  poolMeta?: string | null;
  symbol?: string | null;
}): boolean {
  const searchText = [params.yieldSource, params.poolMeta, params.symbol]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");

  if (!searchText) return false;
  return BLOCKED_YIELD_OPPORTUNITY_PATTERNS.some((pattern) => pattern.test(searchText));
}

function isSupplementalOnchainSource(sourceKey: string | null | undefined): boolean {
  return sourceKey?.startsWith("aave-v3-onchain:") === true || sourceKey?.startsWith("compound-v3:") === true;
}

export function getRankingStaleThresholdMs(dataSource: string, sourceKey?: string | null): number {
  if (dataSource === "price-derived") {
    return PRICE_DERIVED_STALE_THRESHOLD_MS;
  }
  if (dataSource === "rate-derived") {
    return RATE_DERIVED_STALE_THRESHOLD_MS;
  }
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
  if (input.sourceAgeSeconds == null || !Number.isFinite(input.sourceAgeSeconds)) {
    return "unknown";
  }
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

/**
 * Returns ALL DL pools that are yield sources for the given coin.
 *
 * Layer 1: YIELD_POOL_MAP (native/primary pool — stablecoin + single exposure required)
 * Layer 2: YIELD_VARIANT_MAP (wrapper/savings pool — single exposure only; stablecoin
 *          flag relaxed because savings wrappers like fxSAVE are not flagged as
 *          stablecoin=true in DeFiLlama)
 * Layer 3: Base-symbol fallback (only when both static maps miss — stablecoin + single
 *          exposure required, picks highest TVL)
 *
 * Deduplicates by pool UUID. Used by sync-yield-data to support multiple sources per coin.
 */
export function matchAllDlPools(
  stablecoinId: string,
  symbol: string,
  dlPools: Array<{
    pool: string; symbol: string; tvlUsd: number;
    apy: number; apyBase: number | null; apyReward: number | null;
    stablecoin: boolean; exposure: string;
    underlyingTokens?: string[] | null;
    chain?: string;
    project?: string;
  }>,
  poolMap: Record<string, string>,
  variantMap: Record<string, {
    variantSymbol: string;
    variantChain?: string;
    variantAddress?: string;
    variantProject?: string;
  }>,
  options?: {
    chainFilter?: Set<string>;
    contractAddresses?: string[];
    reservedPoolIds?: Set<string>;
  },
): Array<{ pool: string; apy: number; apyBase: number | null; apyReward: number | null; tvlUsd: number }> {
  const found: Array<{ pool: string; apy: number; apyBase: number | null; apyReward: number | null; tvlUsd: number }> = [];
  const seenUuids = new Set<string>();
  const nativeId = poolMap[stablecoinId];
  const reservedPoolIds = options?.reservedPoolIds ?? new Set<string>();
  const contractSet = new Set((options?.contractAddresses ?? []).map((address) => normalizeTokenAddress(address)));
  const normalizedChainFilter = normalizeChainFilter(options?.chainFilter);

  const isEligibleChain = (poolChain: string | undefined): boolean => {
    return isChainAllowed(normalizedChainFilter, poolChain);
  };
  const isReservedForAnotherCoin = (poolId: string): boolean => reservedPoolIds.has(poolId) && poolId !== nativeId;
  const addressMatches = (pool: { underlyingTokens?: string[] | null }): boolean =>
    contractSet.size > 0 &&
    (pool.underlyingTokens ?? []).some((address) => contractSet.has(normalizeTokenAddress(address)));

  // Layer 1: Static pool map (native/primary source — stablecoin=true required)
  if (nativeId) {
    const p = dlPools.find((pool) => pool.pool === nativeId && pool.exposure === "single");
    if (p) {
      found.push({ pool: p.pool, apy: p.apy, apyBase: p.apyBase, apyReward: p.apyReward, tvlUsd: p.tvlUsd });
      seenUuids.add(p.pool);
    } else if (!dlPools.find((pool) => pool.pool === nativeId)) {
      logWorkerEventArgs("handler", "warn", `[yield-sync] Pool UUID ${nativeId} for ${stablecoinId} not found in DL response, falling through`);
    }
  }

  // Layer 2: Variant map (wrapper/savings pool — stablecoin flag relaxed)
  const variant = variantMap[stablecoinId];
  if (variant) {
    const variantSymbol = normalizeDexSymbol(variant.variantSymbol);
    const variantChain = variant.variantChain ? normalizeChainId(variant.variantChain) : null;
    const variantAddress = normalizeTokenAddress(variant.variantAddress ?? "");
    const variantProject = (variant.variantProject ?? "").trim().toLowerCase();

    const baseCandidates = dlPools.filter(
      (pool) =>
        pool.exposure === "single" &&
        !seenUuids.has(pool.pool) &&
        !isReservedForAnotherCoin(pool.pool) &&
        (!variantChain || normalizeChainId(pool.chain) === variantChain),
    );

    const addressCandidates = variantAddress
      ? baseCandidates.filter((pool) =>
        (pool.underlyingTokens ?? []).some((address) => normalizeTokenAddress(address) === variantAddress))
      : [];
    const symbolCandidates = baseCandidates.filter((pool) => normalizeDexSymbol(pool.symbol) === variantSymbol);
    const filterByProject = <T extends { project?: string }>(candidates: T[]): T[] =>
      variantProject
        ? candidates.filter((pool) => (pool.project ?? "").trim().toLowerCase() === variantProject)
        : candidates;

    const scopedAddressCandidates = filterByProject(addressCandidates);
    const scopedSymbolCandidates = filterByProject(symbolCandidates);

    let selectedVariantCandidates = symbolCandidates;
    if (addressCandidates.length > 0) {
      selectedVariantCandidates = variantProject ? scopedAddressCandidates : addressCandidates;
    } else if (variantProject) {
      selectedVariantCandidates = scopedSymbolCandidates;
    }
    if (selectedVariantCandidates.length === 1) {
      const selected = selectedVariantCandidates[0];
      found.push({
        pool: selected.pool,
        apy: selected.apy,
        apyBase: selected.apyBase,
        apyReward: selected.apyReward,
        tvlUsd: selected.tvlUsd,
      });
      seenUuids.add(selected.pool);
    } else if (selectedVariantCandidates.length > 1) {
      logWorkerEventArgs("handler", "warn",
        `[yield-sync] Ambiguous variant DL match for ${stablecoinId} (${variant.variantSymbol}) across ${selectedVariantCandidates.length} pools; skipping variant layer`,
      );
    }
  }

  // Layer 3: Base-symbol fallback (only when BOTH static maps miss — stablecoin=true required).
  // Prefer address corroboration first, then exact normalized symbol equality. Substring-only
  // matches are intentionally excluded because they can attach a base asset to an unrelated
  // prefixed/suffixed wrapper.
  if (found.length === 0) {
    const sym = normalizeDexSymbol(symbol);
    if (sym.length >= 4) {
      const baseCandidates = dlPools.filter(
        (pool) =>
          pool.exposure === "single" &&
          pool.stablecoin &&
          !isReservedForAnotherCoin(pool.pool) &&
          isEligibleChain(pool.chain),
      );

      const addressCandidates = contractSet.size > 0
        ? baseCandidates.filter((pool) => addressMatches(pool))
        : [];
      if (addressCandidates.length > 0) {
        const best = addressCandidates.reduce((a, b) => b.tvlUsd > a.tvlUsd ? b : a);
        found.push({ pool: best.pool, apy: best.apy, apyBase: best.apyBase, apyReward: best.apyReward, tvlUsd: best.tvlUsd });
      } else {
        const symbolCandidates = baseCandidates.filter((pool) => normalizeDexSymbol(pool.symbol) === sym);
        if (symbolCandidates.length === 1) {
          const candidate = symbolCandidates[0];
          found.push({
            pool: candidate.pool,
            apy: candidate.apy,
            apyBase: candidate.apyBase,
            apyReward: candidate.apyReward,
            tvlUsd: candidate.tvlUsd,
          });
        } else if (symbolCandidates.length > 1) {
          logWorkerEventArgs("handler", "warn",
            `[yield-sync] Ambiguous fallback DL match for ${stablecoinId} (${symbol}) across ${symbolCandidates.length} pools; skipping fallback`,
          );
        }
      }
    }
  }

  return found;
}

/**
 * Core lending-pool eligibility gate shared by the deterministic AUTO_LENDING
 * loop and findBestLendingPool's dynamic discovery, so the two auto paths stay
 * in sync: single exposure, stablecoin = true, project in allowlist, and the
 * APY/TVL quality floors. Source-block, reserved-pool, collision, and chain
 * filters are applied separately by each caller.
 */
export function meetsLendingPoolCoreEligibility(
  pool: {
    project: string;
    apy: number;
    tvlUsd: number;
    stablecoin: boolean;
    exposure: string;
  },
  options: { allowlist: Set<string>; minApy: number; minTvlUsd: number },
): boolean {
  return (
    pool.exposure === "single" &&
    pool.stablecoin &&
    options.allowlist.has(pool.project) &&
    pool.apy >= options.minApy &&
    pool.tvlUsd >= options.minTvlUsd
  );
}

/**
 * Auto-discovery: find the best lending pool for a coin from allowlisted protocols.
 * Used for non-yield-bearing stablecoins rated C+ or above (Wave 2).
 *
 * Filters: single exposure, stablecoin = true, project in allowlist, symbol match.
 * Optional quality gates: minimum APY and minimum TVL.
 * Picks the highest-TVL pool.
 */
export function findBestLendingPool(
  symbol: string,
  dlPools: Array<{
    pool: string; symbol: string; project: string; tvlUsd: number;
    apy: number; apyBase: number | null; apyReward: number | null;
    stablecoin: boolean; exposure: string;
    poolMeta?: string | null;
    underlyingTokens?: string[] | null;
    chain?: string;
  }>,
  allowlist: Set<string>,
  options?: {
    minApy?: number;
    minTvlUsd?: number;
    contractAddresses?: string[];
    chainFilter?: Set<string>;
    allowSymbolMatch?: boolean;
    reservedPoolIds?: Set<string>;
    isBlockedPool?: (pool: {
      pool: string;
      symbol: string;
      project: string;
      tvlUsd: number;
      apy: number;
      apyBase: number | null;
      apyReward: number | null;
      stablecoin: boolean;
      exposure: string;
      poolMeta?: string | null;
      underlyingTokens?: string[] | null;
      chain?: string;
    }) => boolean;
  },
): {
  pool: string;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  tvlUsd: number;
  project: string;
  chain?: string;
} | null {
  const symbolKey = normalizeDexSymbol(symbol);
  const minApy = options?.minApy ?? 0;
  const minTvlUsd = options?.minTvlUsd ?? 0;
  const contractSet = new Set((options?.contractAddresses ?? []).map((address) => normalizeTokenAddress(address)));
  const chainFilter = normalizeChainFilter(options?.chainFilter);
  const reservedPoolIds = options?.reservedPoolIds ?? new Set<string>();

  const baseCandidates = dlPools.filter((p) =>
    meetsLendingPoolCoreEligibility(p, { allowlist, minApy, minTvlUsd }) &&
    !isBlockedYieldOpportunitySource({ poolMeta: p.poolMeta, symbol: p.symbol }) &&
    !reservedPoolIds.has(p.pool) &&
    !options?.isBlockedPool?.(p) &&
    isChainAllowed(chainFilter, p.chain)
  );

  // Primary match: underlying token address match.
  const addressCandidates = contractSet.size > 0
    ? baseCandidates.filter((pool) =>
      (pool.underlyingTokens ?? []).some((address) => contractSet.has(normalizeTokenAddress(address))))
    : [];
  if (addressCandidates.length > 0) {
    const best = addressCandidates.reduce((a, b) => (b.tvlUsd > a.tvlUsd ? b : a));
    return {
      pool: best.pool,
      apy: best.apy,
      apyBase: best.apyBase,
      apyReward: best.apyReward,
      tvlUsd: best.tvlUsd,
      project: best.project,
      chain: best.chain,
    };
  }

  if (options?.allowSymbolMatch === false) {
    return null;
  }

  // Fallback: exact symbol, but only when the caller has determined it is safe.
  const symbolCandidates = baseCandidates.filter((pool) => normalizeDexSymbol(pool.symbol) === symbolKey);
  if (symbolCandidates.length === 0) return null;

  const best = symbolCandidates.reduce((a, b) => (b.tvlUsd > a.tvlUsd ? b : a));
  return {
    pool: best.pool,
    apy: best.apy,
    apyBase: best.apyBase,
    apyReward: best.apyReward,
    tvlUsd: best.tvlUsd,
    project: best.project,
    chain: best.chain,
  };
}
