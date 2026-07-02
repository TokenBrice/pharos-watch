import type { StagedPool } from "../dex-discovery/types";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { STAGED_POOL_MAX_TVL_USD, stagedPoolConfidence, stagedPoolMaturityDays } from "../dex-discovery/types";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { QUALITY_MULTIPLIERS } from "../../lib/dex-cron-constants";
import { toFiniteNumber } from "../../lib/number-utils";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { mergeCgPools, mergeGtPools } from "./fetch-crawlers";
import type { CgTickerOrderbookMetadata } from "./coingecko-tickers-shared";
import type { AuthoritativeStagedPoolConfirmationIndex } from "./orchestrator-phases";
import { getGtDexQuality, normalizeProtocol } from "./pool-helpers";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import type { CgNewPool, GtNewPool, LiquidityMetrics, DexPriceObs } from "./types";
import {
  buildPoolIdentity,
  countPoolIdentityKeys,
  createKnownPoolIdentityIndex,
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
  raw_json: string | null;
  discovered_at: number;
  refreshed_at: number;
}

export type StagedPoolSkipReason =
  | "malformed_identity"
  | "invalid_tvl"
  | "invalid_price"
  | "stale_confidence_zero"
  | "authoritative_confirmation_missing"
  | "duplicate_exact_identity"
  | "duplicate_unique_derived_identity"
  | "duplicate_optional_wildcard_identity";

export interface StagedPoolSkipDimension {
  reason: StagedPoolSkipReason;
  protocol: string;
  chain: string;
  count: number;
  threshold?: number;
  conflict?: string;
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
    rawJson: row.raw_json ?? null,
    discoveredAt: toFiniteNumber(row.discovered_at) ?? 0,
    refreshedAt: toFiniteNumber(row.refreshed_at) ?? 0,
  };
}

function readCgTickerOrderbookMetadata(rawJson: string | null): CgTickerOrderbookMetadata | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const orderbookDepthUsd = toFiniteNumber(parsed.orderbookDepthUsd);
    const orderbookDepthUpUsd = toFiniteNumber(parsed.orderbookDepthUpUsd);
    const orderbookTvlBasis =
      parsed.orderbookTvlBasis === "coingecko-depth-2pct-capped-by-volume" ||
      parsed.orderbookTvlBasis === "volume-derived"
        ? parsed.orderbookTvlBasis
        : undefined;
    if (orderbookDepthUsd == null && orderbookDepthUpUsd == null && !orderbookTvlBasis) return null;
    return {
      ...(orderbookDepthUsd != null ? { orderbookDepthUsd } : {}),
      ...(orderbookDepthUpUsd != null ? { orderbookDepthUpUsd } : {}),
      ...(orderbookTvlBasis ? { orderbookTvlBasis } : {}),
    };
  } catch {
    return null;
  }
}

function pushPool<T>(poolMap: Map<string, T[]>, stablecoinId: string, pool: T): void {
  const existing = poolMap.get(stablecoinId) ?? [];
  existing.push(pool);
  poolMap.set(stablecoinId, existing);
}

function getStablecoinIdentityIndex(
  indexes: Map<string, KnownPoolIdentityIndex>,
  stablecoinId: string,
): KnownPoolIdentityIndex {
  const existing = indexes.get(stablecoinId);
  if (existing) return existing;
  const created = createKnownPoolIdentityIndex();
  indexes.set(stablecoinId, created);
  return created;
}

function poolIdentityRegistrationKey(identity: ReturnType<typeof buildPoolIdentity>): string {
  return JSON.stringify([identity.exactPoolKey, identity.derivedMatchKey, identity.optionalWildcardKey]);
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
      return {
        dexId,
        poolType: stagedPool.poolType ?? "cg-cl-1bp",
        qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-1bp"]!,
      };
    }
    if (stagedPool.feeTier <= 5) {
      return {
        dexId,
        poolType: stagedPool.poolType ?? "cg-cl-5bp",
        qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-5bp"]!,
      };
    }
    if (stagedPool.feeTier <= 30) {
      return {
        dexId,
        poolType: stagedPool.poolType ?? "cg-cl-30bp",
        qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-30bp"]!,
      };
    }
  }

  return {
    dexId,
    poolType: stagedPool.poolType ?? (stagedPool.isStable ? "stable" : "amm"),
    qualityMultiplier: stagedPool.qualityMultiplier ?? getGtDexQuality(dexId),
  };
}

function requiresAuthoritativeProtocolConfirmation(
  authoritativeConfirmation: AuthoritativeStagedPoolConfirmationIndex | undefined,
  protocol: string,
  chain: string,
): boolean {
  if (!authoritativeConfirmation) return false;
  const enforcedChains = authoritativeConfirmation.enforcedChainsByProtocol.get(protocol);
  return enforcedChains?.has(chain.toLowerCase()) ?? false;
}

function incrementSkipDimension(
  dimensions: Map<string, StagedPoolSkipDimension>,
  reason: StagedPoolSkipReason,
  input: Pick<StagedPool, "protocol" | "chain"> | Pick<StagedPoolRow, "protocol" | "chain"> | null,
  details?: { threshold?: number; conflict?: string },
): void {
  const protocol = (input?.protocol || "unknown").toLowerCase();
  const chain = (input?.chain || "unknown").toLowerCase();
  const key = JSON.stringify({ reason, protocol, chain, threshold: details?.threshold, conflict: details?.conflict });
  const existing = dimensions.get(key);
  if (existing) {
    existing.count++;
    return;
  }
  dimensions.set(key, {
    reason,
    protocol,
    chain,
    count: 1,
    ...(details?.threshold != null ? { threshold: details.threshold } : {}),
    ...(details?.conflict ? { conflict: details.conflict } : {}),
  });
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
  authoritativeConfirmation?: AuthoritativeStagedPoolConfirmationIndex,
): Promise<{
  mergedCount: number;
  skippedCount: number;
  skippedByExactIdentityCount: number;
  skippedByUniqueDerivedIdentityCount: number;
  skippedByOptionalWildcardIdentityCount: number;
  skippedByAuthoritativeProtocolCount: number;
  skipDimensions: StagedPoolSkipDimension[];
  priceObservations: Map<string, DexPriceObs[]>;
}> {
  let rows: StagedPoolRow[];
  try {
    const result = await db
      .prepare(
        `SELECT pool_id, stablecoin_id, source, chain, protocol, dex_id, symbol,
                       tvl_usd, volume_24h, quality_multiplier, pool_type, fee_tier, balance_ratio, is_stable,
                       base_token, quote_token, quote_symbol, price_usd, locked_liq_pct,
                       raw_json, discovered_at, refreshed_at
                FROM dex_pool_staging WHERE refreshed_at >= ?`,
      )
      // Fetch a 60s grace beyond the 24h confidence horizon so rows that have
      // just crossed it surface as stagedPoolConfidence === 0 and are recorded
      // under the stale_confidence_zero skip reason instead of silently never
      // appearing. Without the grace the read window and the zero gate align
      // exactly and the guard below is unreachable.
      .bind(nowSec - DAY_SECONDS - 60)
      .all<StagedPoolRow>();
    rows = result.results ?? [];
  } catch (err) {
    console.warn("[dex-liquidity] staging table read failed (pre-migration?):", err);
    return {
      mergedCount: 0,
      skippedCount: 0,
      skippedByExactIdentityCount: 0,
      skippedByUniqueDerivedIdentityCount: 0,
      skippedByOptionalWildcardIdentityCount: 0,
      skippedByAuthoritativeProtocolCount: 0,
      skipDimensions: [],
      priceObservations: new Map(),
    };
  }

  const cgPoolMap = new Map<string, CgNewPool[]>();
  const gtPoolMap = new Map<string, GtNewPool[]>();
  const stagedPriceObs = new Map<string, DexPriceObs[]>();
  let skippedCount = 0;
  let exactIdentitySkipped = 0;
  let uniqueDerivedIdentitySkipped = 0;
  let optionalWildcardIdentitySkipped = 0;
  let authoritativeProtocolSkipped = 0;
  const skipDimensions = new Map<string, StagedPoolSkipDimension>();

  const stagedEntries: Array<{
    stagedPool: StagedPool;
    dexId: string;
    poolType: string;
    qualityMultiplier: number;
    orderbookMetadata: CgTickerOrderbookMetadata | null;
    identity: ReturnType<typeof buildPoolIdentity>;
    confidence: number;
  }> = [];

  for (const row of rows) {
    const stagedPool = toStagedPool(row);
    if (!stagedPool.poolId || !stagedPool.stablecoinId) {
      skippedCount++;
      incrementSkipDimension(skipDimensions, "malformed_identity", row);
      continue;
    }
    if (
      stagedPool.tvlUsd == null ||
      !Number.isFinite(stagedPool.tvlUsd) ||
      stagedPool.tvlUsd < 0 ||
      stagedPool.tvlUsd > STAGED_POOL_MAX_TVL_USD
    ) {
      skippedCount++;
      incrementSkipDimension(skipDimensions, "invalid_tvl", stagedPool, { threshold: STAGED_POOL_MAX_TVL_USD });
      continue;
    }

    const profile = resolveStagedPoolProfile(stagedPool);
    const orderbookMetadata = stagedPool.source === "cg_tickers"
      ? readCgTickerOrderbookMetadata(stagedPool.rawJson)
      : null;
    // For orderbook pools, preserve the full poolId so that
    // isTrustworthyExactPoolId recognises the "orderbook:" prefix and
    // registers a usable exact key for downstream dedup.
    const poolAddressOrId = stagedPool.chain === "orderbook"
      ? stagedPool.poolId
      : stagedPool.poolId.includes(":")
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
    const ageHours = (nowSec - stagedPool.refreshedAt) / 3600;
    const confidence = stagedPoolConfidence(ageHours);
    stagedEntries.push({
      stagedPool,
      dexId: profile.dexId,
      poolType: profile.poolType,
      qualityMultiplier: profile.qualityMultiplier,
      orderbookMetadata,
      identity,
      confidence,
    });
  }
  const stagedEntriesByStablecoin = new Map<string, typeof stagedEntries>();
  for (const entry of stagedEntries) {
    if (entry.confidence <= 0) continue;
    const entries = stagedEntriesByStablecoin.get(entry.stagedPool.stablecoinId) ?? [];
    entries.push(entry);
    stagedEntriesByStablecoin.set(entry.stagedPool.stablecoinId, entries);
  }
  const stagedIdentityCountsByStablecoin = new Map<string, ReturnType<typeof countPoolIdentityKeys>>();
  for (const [stablecoinId, entries] of stagedEntriesByStablecoin) {
    stagedIdentityCountsByStablecoin.set(stablecoinId, countPoolIdentityKeys(entries.map((entry) => entry.identity)));
  }
  const acceptedStagedIndexesByStablecoin = new Map<string, KnownPoolIdentityIndex>();
  const acceptedStagedIdentities: Array<ReturnType<typeof buildPoolIdentity>> = [];
  const acceptedStagedIdentityKeys = new Set<string>();

  for (const entry of stagedEntries) {
    const { stagedPool, dexId, poolType, qualityMultiplier, orderbookMetadata, identity, confidence } = entry;
    const normalizedProtocol = normalizeProtocol(stagedPool.protocol || dexId);

    // Compute confidence and adjusted TVL early — needed for price observation gate
    if (confidence === 0) {
      skippedCount++;
      incrementSkipDimension(skipDimensions, "stale_confidence_zero", stagedPool, { threshold: 24 });
      continue;
    }

    const adjustedTvl = (stagedPool.tvlUsd ?? 0) * confidence;
    if (
      stagedPool.priceUsd != null &&
      stagedPool.priceUsd > 0 &&
      !isPlausibleDexObservationPrice(stagedPool.stablecoinId, stagedPool.priceUsd, references)
    ) {
      skippedCount++;
      incrementSkipDimension(skipDimensions, "invalid_price", stagedPool);
      continue;
    }

    if (requiresAuthoritativeProtocolConfirmation(authoritativeConfirmation, normalizedProtocol, stagedPool.chain)) {
      const confirmedExactKeys = authoritativeConfirmation?.confirmedExactKeysByProtocol.get(normalizedProtocol);
      if (!identity.exactPoolKey || !confirmedExactKeys?.has(identity.exactPoolKey)) {
        skippedCount++;
        authoritativeProtocolSkipped++;
        incrementSkipDimension(skipDimensions, "authoritative_confirmation_missing", stagedPool);
        continue;
      }
    }

    // Extract price observations BEFORE dedup check.
    // DL yields pools provide pool metrics but never prices; CG/GT staged pools
    // carry priceUsd. These observations still feed diagnostics and later retained-
    // pool price eligibility, but dex_prices is now rebuilt only from the final
    // retained pool set after dedupe and filtering.
    if (
      stagedPool.priceUsd != null &&
      stagedPool.priceUsd > 0 &&
      adjustedTvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD
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

    const stagedIdentityCounts = stagedIdentityCountsByStablecoin.get(stagedPool.stablecoinId) ?? {
      derived: new Map<string, number>(),
      wildcard: new Map<string, number>(),
    };

    const knownDedupReason = getIdentityDedupReason(
      identity,
      knownPoolIndex,
      {
        derived: identity.derivedMatchKey ? (stagedIdentityCounts.derived.get(identity.derivedMatchKey) ?? 0) : 0,
        wildcard: identity.optionalWildcardKey
          ? (stagedIdentityCounts.wildcard.get(identity.optionalWildcardKey) ?? 0)
          : 0,
      },
      { allowOptionalWildcard: true },
    );
    const stagedDedupReason = getIdentityDedupReason(
      identity,
      acceptedStagedIndexesByStablecoin.get(stagedPool.stablecoinId) ?? createKnownPoolIdentityIndex(),
      {
        derived: identity.derivedMatchKey ? (stagedIdentityCounts.derived.get(identity.derivedMatchKey) ?? 0) : 0,
        wildcard: identity.optionalWildcardKey
          ? (stagedIdentityCounts.wildcard.get(identity.optionalWildcardKey) ?? 0)
          : 0,
      },
      { allowOptionalWildcard: true },
    );
    const dedupReason = knownDedupReason ?? stagedDedupReason;
    if (dedupReason) {
      skippedCount++;
      if (dedupReason === "exact") exactIdentitySkipped++;
      if (dedupReason === "derived_unique") uniqueDerivedIdentitySkipped++;
      if (dedupReason === "derived_optional_wildcard") optionalWildcardIdentitySkipped++;
      incrementSkipDimension(
        skipDimensions,
        dedupReason === "exact"
          ? "duplicate_exact_identity"
          : dedupReason === "derived_unique"
            ? "duplicate_unique_derived_identity"
            : "duplicate_optional_wildcard_identity",
        stagedPool,
        { conflict: dedupReason },
      );
      continue;
    }
    registerKnownPoolIdentity(
      getStablecoinIdentityIndex(acceptedStagedIndexesByStablecoin, stagedPool.stablecoinId),
      identity,
    );
    const registrationKey = poolIdentityRegistrationKey(identity);
    if (!acceptedStagedIdentityKeys.has(registrationKey)) {
      acceptedStagedIdentityKeys.add(registrationKey);
      acceptedStagedIdentities.push(identity);
    }

    const adjustedVolume = (stagedPool.volume24h ?? 0) * confidence;
    // Preserve the full suffix after the first colon. Orderbook ids and any colon-bearing
    // native ids stay intact. EVM/base58 addresses are colon-free so this is safe.
    const firstColonIndex = stagedPool.poolId.indexOf(":");
    const address = firstColonIndex >= 0 ? stagedPool.poolId.slice(firstColonIndex + 1) : stagedPool.poolId;
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
            ...(orderbookMetadata ?? {}),
            measurement: {
              tvlMeasured: orderbookMetadata?.orderbookDepthUsd != null,
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
  if (optionalWildcardIdentitySkipped > 0) {
    console.log(
      `[dex-liquidity] Skipped ${optionalWildcardIdentitySkipped} staged pools via optional wildcard identity`,
    );
  }
  if (authoritativeProtocolSkipped > 0) {
    console.log(
      `[dex-liquidity] Skipped ${authoritativeProtocolSkipped} staged pools missing authoritative protocol confirmation`,
    );
  }
  if (skipDimensions.size > 0) {
    console.log(`[dex-liquidity] staged skip dimensions ${JSON.stringify([...skipDimensions.values()])}`);
  }

  let mergedCount = 0;
  for (const pools of cgPoolMap.values()) mergedCount += pools.length;
  for (const pools of gtPoolMap.values()) mergedCount += pools.length;

  for (const identity of acceptedStagedIdentities) {
    registerKnownPoolIdentity(knownPoolIndex, identity);
  }

  if (cgPoolMap.size > 0) await mergeCgPools(metrics, cgPoolMap, db);
  if (gtPoolMap.size > 0) await mergeGtPools(metrics, gtPoolMap, db);

  return {
    mergedCount,
    skippedCount,
    skippedByExactIdentityCount: exactIdentitySkipped,
    skippedByUniqueDerivedIdentityCount: uniqueDerivedIdentitySkipped,
    skippedByOptionalWildcardIdentityCount: optionalWildcardIdentitySkipped,
    skippedByAuthoritativeProtocolCount: authoritativeProtocolSkipped,
    skipDimensions: [...skipDimensions.values()],
    priceObservations: stagedPriceObs,
  };
}
