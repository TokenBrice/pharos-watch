import type { StagedPool } from "../dex-discovery/types";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { stagedPoolConfidence, stagedPoolMaturityDays } from "../dex-discovery/types";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { QUALITY_MULTIPLIERS } from "../../lib/dex-constants";
import { toFiniteNumber } from "../../lib/number-utils";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { mergeCgPools, mergeGtPools } from "./fetch-crawlers";
import { getGtDexQuality } from "./pool-helpers";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import type { CgNewPool, GtNewPool, LiquidityMetrics, DexPriceObs } from "./types";
import {
  buildPoolIdentity,
  countPoolIdentityKeys,
  getIdentityDedupReason,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
} from "./pool-identity";

interface StagedPoolRow {
  pool_id: string;
  stablecoin_id: string;
  source: StagedPool["source"];
  chain: string;
  protocol: string;
  dex_id: string | null;
  symbol: string;
  tvl_usd: number | null;
  volume_24h: number | null;
  quality_multiplier: number | null;
  pool_type: string | null;
  fee_tier: number | null;
  balance_ratio: number | null;
  is_stable: number | boolean | null;
  base_token: string | null;
  quote_token: string | null;
  quote_symbol: string | null;
  price_usd: number | null;
  locked_liq_pct: number | null;
  discovered_at: number;
  refreshed_at: number;
}

function toBoolean(value: number | boolean | null): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return null;
}

function toStagedPool(row: StagedPoolRow): StagedPool {
  return {
    poolId: row.pool_id.toLowerCase(),
    stablecoinId: row.stablecoin_id,
    source: row.source,
    chain: row.chain,
    protocol: row.protocol,
    dexId: row.dex_id,
    symbol: row.symbol,
    tvlUsd: toFiniteNumber(row.tvl_usd),
    volume24h: toFiniteNumber(row.volume_24h),
    qualityMultiplier: toFiniteNumber(row.quality_multiplier),
    poolType: row.pool_type,
    feeTier: toFiniteNumber(row.fee_tier),
    balanceRatio: toFiniteNumber(row.balance_ratio),
    isStable: toBoolean(row.is_stable),
    baseToken: row.base_token,
    quoteToken: row.quote_token,
    quoteSymbol: row.quote_symbol,
    priceUsd: toFiniteNumber(row.price_usd),
    lockedLiqPct: toFiniteNumber(row.locked_liq_pct),
    rawJson: null,
    discoveredAt: toFiniteNumber(row.discovered_at) ?? 0,
    refreshedAt: toFiniteNumber(row.refreshed_at) ?? 0,
  };
}

function pushPool<T>(poolMap: Map<string, T[]>, stablecoinId: string, pool: T): void {
  const existing = poolMap.get(stablecoinId) ?? [];
  existing.push(pool);
  poolMap.set(stablecoinId, existing);
}

function resolveStagedPoolProfile(stagedPool: StagedPool): {
  dexId: string;
  poolType: string;
  qualityMultiplier: number;
} {
  const dexId = stagedPool.dexId ?? stagedPool.protocol;

  if (stagedPool.qualityMultiplier != null && stagedPool.poolType != null) {
    return {
      dexId,
      poolType: stagedPool.poolType,
      qualityMultiplier: stagedPool.qualityMultiplier,
    };
  }

  if (stagedPool.source === "cg_tickers") {
    return {
      dexId,
      poolType: stagedPool.poolType ?? "orderbook",
      qualityMultiplier: stagedPool.qualityMultiplier ?? QUALITY_MULTIPLIERS["orderbook"]!,
    };
  }

  if (stagedPool.source === "cg_onchain" && stagedPool.feeTier != null) {
    if (stagedPool.feeTier <= 1) {
      return { dexId, poolType: stagedPool.poolType ?? "cg-cl-1bp", qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-1bp"]! };
    }
    if (stagedPool.feeTier <= 5) {
      return { dexId, poolType: stagedPool.poolType ?? "cg-cl-5bp", qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-5bp"]! };
    }
    if (stagedPool.feeTier <= 30) {
      return { dexId, poolType: stagedPool.poolType ?? "cg-cl-30bp", qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-30bp"]! };
    }
  }

  return {
    dexId,
    poolType: stagedPool.poolType ?? (stagedPool.isStable ? "stable" : "amm"),
    qualityMultiplier: stagedPool.qualityMultiplier ?? getGtDexQuality(dexId),
  };
}

/**
 * Read staged pools from dex_pool_staging (refreshed within 24h),
 * convert to pool entries with confidence decay and defaults,
 * and merge into existing metrics.
 *
 * If the staging table doesn't exist yet (pre-migration), catches the D1 error
 * and returns zero counts gracefully.
 */
export async function mergeStagedPools(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  knownPoolIndex: KnownPoolIdentityIndex,
  nowSec: number,
  references?: PriceValidationReferences,
): Promise<{
  mergedCount: number;
  skippedCount: number;
  skippedByExactIdentityCount: number;
  skippedByUniqueDerivedIdentityCount: number;
  priceObservations: Map<string, DexPriceObs[]>;
}> {
  let rows: StagedPoolRow[];
  try {
    const result = await db
      .prepare(`SELECT pool_id, stablecoin_id, source, chain, protocol, dex_id, symbol,
                       tvl_usd, volume_24h, quality_multiplier, pool_type, fee_tier, balance_ratio, is_stable,
                       base_token, quote_token, quote_symbol, price_usd, locked_liq_pct,
                       discovered_at, refreshed_at
                FROM dex_pool_staging WHERE refreshed_at >= ?`)
      .bind(nowSec - DAY_SECONDS)
      .all<StagedPoolRow>();
    rows = result.results ?? [];
  } catch (err) {
    console.warn("[dex-liquidity] staging table read failed (pre-migration?):", err);
    return {
      mergedCount: 0,
      skippedCount: 0,
      skippedByExactIdentityCount: 0,
      skippedByUniqueDerivedIdentityCount: 0,
      priceObservations: new Map(),
    };
  }

  const cgPoolMap = new Map<string, CgNewPool[]>();
  const gtPoolMap = new Map<string, GtNewPool[]>();
  const stagedPriceObs = new Map<string, DexPriceObs[]>();
  let skippedCount = 0;
  let exactIdentitySkipped = 0;
  let uniqueDerivedIdentitySkipped = 0;

  const stagedEntries = rows
    .map((row) => {
      const stagedPool = toStagedPool(row);
      if (!stagedPool.poolId || !stagedPool.stablecoinId) return null;

      const profile = resolveStagedPoolProfile(stagedPool);
      const poolAddressOrId = stagedPool.poolId.includes(":")
        ? stagedPool.poolId.split(":").slice(1).join(":")
        : stagedPool.poolId;
      const identity = buildPoolIdentity({
        chain: stagedPool.chain,
        protocol: profile.dexId,
        poolAddressOrId,
        tokenAddresses: [stagedPool.baseToken ?? "", stagedPool.quoteToken ?? ""],
        poolType: profile.poolType,
        feeTierBps: stagedPool.feeTier,
        isStable: stagedPool.isStable,
      });
      return {
        stagedPool,
        dexId: profile.dexId,
        poolType: profile.poolType,
        qualityMultiplier: profile.qualityMultiplier,
        identity,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  const stagedIdentityCounts = countPoolIdentityKeys(stagedEntries.map((entry) => entry.identity));

  for (const entry of stagedEntries) {
    const { stagedPool, dexId, poolType, qualityMultiplier, identity } = entry;

    // Compute confidence and adjusted TVL early — needed for price observation gate
    const ageHours = (nowSec - stagedPool.refreshedAt) / 3600;
    const confidence = stagedPoolConfidence(ageHours);
    if (confidence === 0) continue;

    const adjustedTvl = (stagedPool.tvlUsd ?? 0) * confidence;

    // Extract price observations BEFORE dedup check.
    // DL yields pools provide pool metrics but never prices; CG/GT staged pools
    // carry priceUsd. Dedup correctly prevents double-counting TVL in dex_liquidity,
    // but price observations feed a separate table (dex_prices) via TVL-weighted
    // median that handles multiple observations gracefully.
    if (
      stagedPool.priceUsd != null &&
      stagedPool.priceUsd > 0 &&
      adjustedTvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD &&
      isPlausibleDexObservationPrice(stagedPool.stablecoinId, stagedPool.priceUsd, references)
    ) {
      const obs = stagedPriceObs.get(stagedPool.stablecoinId) ?? [];
      obs.push({
        price: stagedPool.priceUsd,
        tvl: adjustedTvl,
        chain: stagedPool.chain,
        protocol: dexId,
        poolKey: identity.exactPoolKey ?? undefined,
        derivedMatchKey: identity.derivedMatchKey ?? undefined,
        identityConfidence: identity.exactPoolKey ? "exact" : identity.derivedMatchKey ? "derived_ambiguous" : "none",
        sourceFamily: stagedPool.source,
      });
      stagedPriceObs.set(stagedPool.stablecoinId, obs);
    }

    const dedupReason = getIdentityDedupReason(identity, knownPoolIndex, {
      derived: identity.derivedMatchKey
        ? (stagedIdentityCounts.derived.get(identity.derivedMatchKey) ?? 0)
        : 0,
      wildcard: identity.optionalWildcardKey
        ? (stagedIdentityCounts.wildcard.get(identity.optionalWildcardKey) ?? 0)
        : 0,
    });
    if (dedupReason) {
      skippedCount++;
      if (dedupReason === "exact") exactIdentitySkipped++;
      if (dedupReason === "derived_unique") uniqueDerivedIdentitySkipped++;
      continue;
    }
    registerKnownPoolIdentity(knownPoolIndex, identity);

    const adjustedVolume = (stagedPool.volume24h ?? 0) * confidence;
    const address = stagedPool.poolId.split(":")[1] ?? stagedPool.poolId;
    const maturityDays = stagedPoolMaturityDays(stagedPool.discoveredAt, nowSec);

    if (stagedPool.source === "cg_onchain") {
      pushPool(cgPoolMap, stagedPool.stablecoinId, {
        address,
        chain: stagedPool.chain,
        dexId,
        name: stagedPool.symbol,
        tvlUsd: adjustedTvl,
        volume24hUsd: adjustedVolume,
        qualityMultiplier,
        maturityDays,
        poolType,
        price: stagedPool.priceUsd ?? 0,
        symbol: stagedPool.symbol,
        sourceFamily: "cg_onchain",
        balanceRatio: stagedPool.balanceRatio,
        lockedLiquidityPct: stagedPool.lockedLiqPct,
        feePercentage: stagedPool.feeTier ? stagedPool.feeTier / 100 : null,
        measurement: {
          tvlMeasured: true,
          volumeMeasured: stagedPool.volume24h != null && Number.isFinite(stagedPool.volume24h),
          balanceMeasured: stagedPool.balanceRatio != null,
          maturityMeasured: false,
          priceMeasured: stagedPool.priceUsd != null && stagedPool.priceUsd > 0,
          synthetic: false,
          decayed: confidence < 1,
        },
      });
      continue;
    }

    pushPool(gtPoolMap, stagedPool.stablecoinId, {
      address,
      chain: stagedPool.chain,
      dexId,
      name: stagedPool.symbol,
      tvlUsd: adjustedTvl,
      volume24hUsd: adjustedVolume,
      qualityMultiplier,
      maturityDays,
      poolType,
      price: stagedPool.priceUsd ?? 0,
      symbol: stagedPool.symbol,
      sourceFamily:
        stagedPool.source === "dexscreener"
          ? "dexscreener"
          : stagedPool.source === "cg_tickers"
            ? "cg_tickers"
            : "gecko_terminal",
      ...(stagedPool.source === "cg_tickers"
        ? {
            pairQualityOverride: 0.85,
            measurement: {
              tvlMeasured: true,
              volumeMeasured: stagedPool.volume24h != null && Number.isFinite(stagedPool.volume24h),
              balanceMeasured: false,
              maturityMeasured: false,
              priceMeasured: stagedPool.priceUsd != null && stagedPool.priceUsd > 0,
              synthetic: true,
              decayed: confidence < 1,
            },
          }
        : {
            measurement: {
              tvlMeasured: true,
              volumeMeasured: stagedPool.volume24h != null && Number.isFinite(stagedPool.volume24h),
              balanceMeasured: stagedPool.balanceRatio != null,
              maturityMeasured: false,
              priceMeasured: stagedPool.priceUsd != null && stagedPool.priceUsd > 0,
              synthetic: false,
              decayed: confidence < 1,
            },
          }),
    });
  }

  if (uniqueDerivedIdentitySkipped > 0) {
    console.log(`[dex-liquidity] Skipped ${uniqueDerivedIdentitySkipped} staged pools via unique derived identity`);
  }

  let mergedCount = 0;
  for (const pools of cgPoolMap.values()) mergedCount += pools.length;
  for (const pools of gtPoolMap.values()) mergedCount += pools.length;

  if (cgPoolMap.size > 0) mergeCgPools(metrics, cgPoolMap);
  if (gtPoolMap.size > 0) mergeGtPools(metrics, gtPoolMap);

  return {
    mergedCount,
    skippedCount,
    skippedByExactIdentityCount: exactIdentitySkipped,
    skippedByUniqueDerivedIdentityCount: uniqueDerivedIdentitySkipped,
    priceObservations: stagedPriceObs,
  };
}
