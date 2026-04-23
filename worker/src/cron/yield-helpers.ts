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
// Price-derived rows are backed by daily supply-history snapshots, so allow one missed daily write plus buffer.
export const PRICE_DERIVED_STALE_THRESHOLD_MS = 36 * 60 * 60 * 1000;

export {
  computePYS,
  PYS_RISK_PENALTY_FLOOR,
  PYS_RISK_PENALTY_EXPONENT,
  PYS_SUSTAINABILITY_FLOOR,
} from "@shared/lib/yield-scoring";
import { resolveChainId } from "@shared/lib/chains";
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

export function computeApyFromRate(rateNow: number, ratePrev: number, days: number): number {
  if (ratePrev <= 0 || rateNow <= 0 || days <= 0) return 0;
  const ratio = rateNow / ratePrev;
  if (ratio === 1) return 0;
  return (Math.pow(ratio, 365.25 / days) - 1) * 100;
}

export function computeApyFromPrice(priceNow: number, pricePrev: number, days: number): number {
  return computeApyFromRate(priceNow, pricePrev, days);
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
  if (dataSource === "protocol-api" || (dataSource === "onchain" && isSupplementalOnchainSource(sourceKey))) {
    return SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS;
  }
  return STALE_THRESHOLD_MS;
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
  const normalizedChainFilter = options?.chainFilter
    ? new Set(Array.from(options.chainFilter).map((chain) => resolveChainId(chain) ?? chain.toLowerCase()))
    : undefined;

  const isEligibleChain = (poolChain: string | undefined): boolean => {
    if (!normalizedChainFilter || !poolChain) return true;
    const chainId = resolveChainId(poolChain) ?? poolChain.toLowerCase();
    return normalizedChainFilter.has(chainId);
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
      console.warn(`[yield-sync] Pool UUID ${nativeId} for ${stablecoinId} not found in DL response, falling through`);
    }
  }

  // Layer 2: Variant map (wrapper/savings pool — stablecoin flag relaxed)
  const variant = variantMap[stablecoinId];
  if (variant) {
    const variantSymbol = normalizeDexSymbol(variant.variantSymbol);
    const variantChain = variant.variantChain ? resolveChainId(variant.variantChain) ?? variant.variantChain.toLowerCase() : null;
    const variantAddress = normalizeTokenAddress(variant.variantAddress ?? "");
    const variantProject = (variant.variantProject ?? "").trim().toLowerCase();

    const baseCandidates = dlPools.filter(
      (pool) =>
        pool.exposure === "single" &&
        !seenUuids.has(pool.pool) &&
        !isReservedForAnotherCoin(pool.pool) &&
        (!variantChain || (resolveChainId(pool.chain ?? "") ?? pool.chain?.toLowerCase()) === variantChain),
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
      console.warn(
        `[yield-sync] Ambiguous variant DL match for ${stablecoinId} (${variant.variantSymbol}) across ${selectedVariantCandidates.length} pools; skipping variant layer`,
      );
    }
  }

  // Layer 3: Base-symbol fallback (only when BOTH static maps miss — stablecoin=true required).
  // Intentionally uses .includes() instead of === to catch DL pools with prefixed/suffixed
  // symbols (e.g., "FEUSDH" for USDH, "STEAKEURCV" for EURCV). Layers 1 and 2 catch most
  // coins first, so Layer 3 only fires when both miss. A minimum symbol length of 4 prevents
  // short symbols like "USD" from matching everything.
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
        const symbolCandidates = baseCandidates.filter((pool) => normalizeDexSymbol(pool.symbol).includes(sym));
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
          console.warn(
            `[yield-sync] Ambiguous fallback DL match for ${stablecoinId} (${symbol}) across ${symbolCandidates.length} pools; skipping fallback`,
          );
        }
      }
    }
  }

  return found;
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
  },
): { pool: string; apy: number; apyBase: number | null; apyReward: number | null; tvlUsd: number; project: string } | null {
  const symbolKey = normalizeDexSymbol(symbol);
  const minApy = options?.minApy ?? 0;
  const minTvlUsd = options?.minTvlUsd ?? 0;
  const contractSet = new Set((options?.contractAddresses ?? []).map((address) => normalizeTokenAddress(address)));
  const chainFilter = options?.chainFilter
    ? new Set(Array.from(options.chainFilter).map((chain) => resolveChainId(chain) ?? chain.toLowerCase()))
    : undefined;
  const reservedPoolIds = options?.reservedPoolIds ?? new Set<string>();

  const baseCandidates = dlPools.filter((p) =>
    p.exposure === "single" &&
    p.stablecoin &&
    allowlist.has(p.project) &&
    p.apy >= minApy &&
    p.tvlUsd >= minTvlUsd &&
    !isBlockedYieldOpportunitySource({ poolMeta: p.poolMeta, symbol: p.symbol }) &&
    !reservedPoolIds.has(p.pool) &&
    (!chainFilter || !p.chain || chainFilter.has(resolveChainId(p.chain) ?? p.chain.toLowerCase()))
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
  };
}
