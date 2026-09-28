import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { logWorkerEventArgs } from "../../lib/structured-log";
import type { StagedPool } from "../dex-discovery/types";
import { CHAIN_META } from "@shared/lib/chains";
import { canonicalExitRouteChain, canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import {
  TEZOS_POOL_IDENTITY_REVIEW_VERSION,
  SLIPSTREAM_POOL_IDENTITY_REVIEW_VERSION,
  STAGED_POOL_CONFIDENCE_HORIZON_HOURS,
  STAGED_POOL_MAX_TVL_USD,
  STAGED_POOL_PRICE_MAX_AGE_HOURS,
  stagedPoolConfidence,
  stagedPoolMaturityDays,
} from "../dex-discovery/types";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { DIRECT_API_POOL_MIN_TVL_USD } from "../../lib/dex-api-pool-shaping";
import { QUALITY_MULTIPLIERS } from "../../lib/dex-cron-constants";
import { toFiniteNumber } from "../../lib/number-utils";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { mergeCgPools, mergeGtPools } from "./fetch-crawlers";
import type { CgTickerOrderbookMetadata } from "./coingecko-tickers-shared";
import type { AuthoritativeStagedPoolConfirmationIndex } from "./orchestrator-phases/authoritative";
import { getGtDexQuality, normalizeProtocol, parsePoolSymbols } from "./pool-helpers";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import type {
  CgNewPool,
  DexPoolVolumeReading,
  DexPriceObs,
  GtNewPool,
  LiquidityFallbackCounters,
  LiquidityMetrics,
  LiquidityPoolSourceFamily,
  PoolEntry,
} from "./types";
import {
  buildDexPriceObservationIdentity,
  buildPoolIdentity,
  createKnownPoolIdentityIndex,
  getIdentityDedupReason,
  registerKnownPoolExactStablecoin,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
} from "./pool-identity";
import { attachEvmV2CandidateToRetainedPool, buildEvmV2ExecutionCandidate } from "./constant-product-v2";
import { resolveRegistryPools, type RegistryPoolView } from "./registry-resolver";
import { DEX_VOLUME_TRADE_VERIFIED_ZERO_SOURCES } from "./constants";
import { isDeadPool } from "./scoring-helpers";
import { buildChainAddressKey } from "./token-resolution";
import { DEX_VOLUME_OBSERVATION_MAX_AGE_SEC, classifyDexPoolVolumeObservation } from "@shared/lib/dex-volume-availability";

export interface StagedPoolRow {
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
  | "legacy_lowercase_identity_superseded"
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
    poolId: canonicalExitRouteScopedKey(row.chain, row.pool_id),
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

function legacyLowercaseIdentityKey(row: StagedPoolRow): string | null {
  const chain = canonicalExitRouteChain(row.chain);
  if (CHAIN_META[chain]?.type === "evm" || chain === "orderbook") return null;
  return JSON.stringify([
    row.stablecoin_id,
    row.source,
    chain,
    canonicalExitRouteScopedKey(chain, row.pool_id).toLowerCase(),
    row.base_token?.trim().toLowerCase() ?? "",
    row.quote_token?.trim().toLowerCase() ?? "",
  ]);
}

function hasMixedCaseNativeIdentity(row: StagedPoolRow): boolean {
  const values = [canonicalExitRouteScopedKey(row.chain, row.pool_id), row.base_token ?? "", row.quote_token ?? ""];
  return values.some((value) => value !== value.toLowerCase());
}

function collectSupersededLegacyLowercaseRows(rows: readonly (StagedPoolRow | undefined)[]): WeakSet<StagedPoolRow> {
  const correctedByIdentity = new Map<string, number>();
  for (const row of rows) {
    if (!row) continue;
    const key = legacyLowercaseIdentityKey(row);
    if (!key || !hasMixedCaseNativeIdentity(row)) continue;
    correctedByIdentity.set(key, Math.max(correctedByIdentity.get(key) ?? Number.NEGATIVE_INFINITY, row.refreshed_at));
  }

  const supersededRows = new WeakSet<StagedPoolRow>();
  for (const row of rows) {
    if (!row) continue;
    const key = legacyLowercaseIdentityKey(row);
    if (!key || hasMixedCaseNativeIdentity(row)) continue;
    if ((correctedByIdentity.get(key) ?? Number.NEGATIVE_INFINITY) > row.refreshed_at) {
      supersededRows.add(row);
    }
  }
  return supersededRows;
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

type StagedPoolIdentity = ReturnType<typeof buildPoolIdentity>;

function retainedPoolKey(stablecoinId: string, exactPoolKey: string): string {
  return `${stablecoinId}\u0000${exactPoolKey}`;
}

/**
 * Register every live-lane pool's exact identity for its coin and return the
 * pools that carry no volume reading, keyed by (stablecoin, exact pool key), so
 * a dedup-skipped registry view of the same pool can hand them its reading.
 */
function registerRetainedPoolExactStablecoins(
  knownPoolIndex: KnownPoolIdentityIndex,
  metrics: Map<string, LiquidityMetrics>,
): Map<string, PoolEntry> {
  const unreadLivePools = new Map<string, PoolEntry>();
  for (const [stablecoinId, metric] of metrics) {
    for (const pool of metric.topPools ?? []) {
      const identity = buildPoolIdentity({
        chain: pool.chain,
        protocol: pool.project,
        poolAddressOrId: pool.poolId,
        tokenAddresses: [],
      });
      if (identity.exactPoolKey) knownPoolIndex.exactKeys.add(identity.exactPoolKey);
      registerKnownPoolExactStablecoin(knownPoolIndex, identity, stablecoinId);
      const reading = pool.volumeReading;
      if (identity.exactPoolKey && reading?.volume24hUsd == null && reading?.volume7dUsd == null) {
        const key = retainedPoolKey(stablecoinId, identity.exactPoolKey);
        if (!unreadLivePools.has(key)) unreadLivePools.set(key, pool);
      }
    }
  }
  return unreadLivePools;
}

/**
 * Chains on which CoinGecko Onchain demonstrably indexes trades: at least one
 * registry row from a DEX_VOLUME_TRADE_VERIFIED_ZERO_SOURCES source on the chain
 * carries a positive 24h volume observed inside the admission window. CoinGecko
 * also publishes explicit zero volume with zero buys and sells for networks it
 * lists but does not index (Hydration on 2026-09-28: 15 of 15 rows zero while
 * DeFiLlama reported $3.3M of weekly volume), and such a zero is not evidence of
 * a pool that did not trade.
 */
/**
 * Views that carry the dead-pool signature and clear the dead-pool floor but sit
 * on a chain where CoinGecko Onchain shows no traded pool (so they are kept),
 * by canonical chain: pool count and decayed TVL. Run metadata only.
 */
export type DeadPoolUnindexedChainSkips = Record<string, { poolCount: number; tvlUsd: number }>;

function collectTradeIndexedChains(rows: readonly StagedPool[], nowSec: number): Set<string> {
  const chains = new Set<string>();
  for (const row of rows) {
    if (
      DEX_VOLUME_TRADE_VERIFIED_ZERO_SOURCES[row.source] === true &&
      row.volume24h != null && row.volume24h > 0 &&
      row.refreshedAt <= nowSec && nowSec - row.refreshedAt <= DEX_VOLUME_OBSERVATION_MAX_AGE_SEC
    ) {
      chains.add(canonicalExitRouteChain(row.chain));
    }
  }
  return chains;
}

/**
 * Liquidity v6.92 dead-pool signature of a resolved view, before the chain gate:
 * its 24h reading row (a usable reading, per the resolver) is a zero from a
 * DEX_VOLUME_TRADE_VERIFIED_ZERO_SOURCES source, the view's own coin owns one leg,
 * and no other leg is a tracked stablecoin deployment on the chain
 * (`trackedDeployments` is the pipeline's chain-address → stablecoin index).
 * Missing token identity or an unmapped own leg proves nothing, so the signature
 * is withheld. The caller signs only on chains in collectTradeIndexedChains.
 */
function hasDeadPoolSignature(view: RegistryPoolView, trackedDeployments: ReadonlyMap<string, string>): boolean {
  const row = view.volume;
  if (row?.volume24h !== 0 || DEX_VOLUME_TRADE_VERIFIED_ZERO_SOURCES[row.source] !== true) return false;
  const { chain, baseToken, quoteToken } = view.metadata;
  if (!baseToken || !quoteToken) return false;
  const legIds = [baseToken, quoteToken].map((token) => trackedDeployments.get(buildChainAddressKey(chain, token)));
  const ownLeg = legIds.indexOf(view.stablecoinId);
  return ownLeg >= 0 && legIds.every((id, index) => index === ownLeg || id === undefined);
}

/** The resolver's volume row as a raw DEC-19 reading, never scaled by TVL decay. */
function buildRegistryVolumeReading(view: RegistryPoolView, deadPoolSignature: boolean): DexPoolVolumeReading {
  return {
    volume24hUsd: view.volume?.volume24h ?? null,
    volume7dUsd: null,
    observedAtSec: view.volume?.refreshedAt ?? null,
    ...(deadPoolSignature ? { deadPoolSignature: true } : {}),
  };
}

/** The dead-pool predicate evaluated at the merge clock, as scoring will evaluate it. */
function isDeadRegistryPool(reading: DexPoolVolumeReading, tvlUsd: number, nowSec: number): boolean {
  const status = classifyDexPoolVolumeObservation(
    { volumeUsd: reading.volume24hUsd, observedAtSec: reading.observedAtSec },
    { asOfSec: nowSec, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC },
  );
  return isDeadPool({ tvlUsd, volumeUsd1d: status === "measured" ? reading.volume24hUsd : null, volumeReading: reading });
}

interface StagedPoolEntry {
  dexId: string;
  poolType: string;
  qualityMultiplier: number;
  identity: StagedPoolIdentity;
  confidence: number;
  priceEligible: boolean;
}

interface StagedPoolIdentityCounts {
  derived: Map<string, number>;
  wildcard: Map<string, number>;
}

function poolIdentityRegistrationKey(identity: StagedPoolIdentity): string {
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

function hasUnreviewedPoolIdentity(pool: StagedPool): boolean {
  const expectedVersion = pool.source === "tezos"
    ? TEZOS_POOL_IDENTITY_REVIEW_VERSION
    : pool.source === "direct_api" && pool.poolType?.includes("slipstream")
      ? SLIPSTREAM_POOL_IDENTITY_REVIEW_VERSION
      : null;
  if (!expectedVersion) return false;
  try {
    return JSON.parse(pool.rawJson ?? "null")?.identityReviewVersion !== expectedVersion;
  } catch {
    return true;
  }
}

function hasInvalidTvl(stagedPool: StagedPool): boolean {
  return (
    stagedPool.tvlUsd == null ||
    !Number.isFinite(stagedPool.tvlUsd) ||
    stagedPool.tvlUsd < 0 ||
    stagedPool.tvlUsd > STAGED_POOL_MAX_TVL_USD
  );
}

function buildStagedPoolEntry(stagedPool: StagedPool, nowSec: number): StagedPoolEntry {
  const profile = resolveStagedPoolProfile(stagedPool);
  // Orderbook ids retain their prefix so downstream exact-key detection can
  // distinguish them from legacy exchange-only rows.
  const poolAddressOrId =
    stagedPool.chain === "orderbook"
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

  return {
    dexId: profile.dexId,
    poolType: profile.poolType,
    qualityMultiplier: profile.qualityMultiplier,
    identity,
    confidence: stagedPoolConfidence(ageHours),
    priceEligible: ageHours <= STAGED_POOL_PRICE_MAX_AGE_HOURS,
  };
}

function incrementStagedIdentityCounts(
  countsByStablecoin: Map<string, StagedPoolIdentityCounts>,
  stablecoinId: string,
  identity: StagedPoolIdentity,
): void {
  const counts = countsByStablecoin.get(stablecoinId) ?? {
    derived: new Map<string, number>(),
    wildcard: new Map<string, number>(),
  };
  if (identity.derivedMatchKey) {
    counts.derived.set(identity.derivedMatchKey, (counts.derived.get(identity.derivedMatchKey) ?? 0) + 1);
  }
  if (identity.optionalWildcardKey) {
    counts.wildcard.set(identity.optionalWildcardKey, (counts.wildcard.get(identity.optionalWildcardKey) ?? 0) + 1);
  }
  countsByStablecoin.set(stablecoinId, counts);
}

function requiresAuthoritativeProtocolConfirmation(
  authoritativeConfirmation: AuthoritativeStagedPoolConfirmationIndex | undefined,
  protocol: string,
  chain: string,
  poolType: string,
  dexId: string,
  tvlUsd: number | null,
): boolean {
  if (!authoritativeConfirmation) return false;
  // Every direct-API census drops pools under DIRECT_API_POOL_MIN_TVL_USD before
  // it is ever read, so a smaller staged pool is outside the census's reach and
  // can never be confirmed. Demanding confirmation there deletes real liquidity
  // for exactly the assets whose only pools sit below the direct-source floor.
  if (tvlUsd == null || tvlUsd < DIRECT_API_POOL_MIN_TVL_USD) return false;
  const familyDescriptor = `${dexId} ${poolType}`.toLowerCase();
  if (protocol === "pancakeswap") {
    if (familyDescriptor.includes("v2")) return false;
    if (!/(v3|v4|concentrated|\bclmm\b|\bcg-cl-)/.test(familyDescriptor)) return false;
  }
  if (protocol === "aerodrome" || protocol === "velodrome") {
    // The protocol-native fetchers cover Slipstream only. Do not let a clean
    // concentrated-liquidity inventory veto classic v2 pools that are outside
    // that source's declared family; those remain eligible through exact-id
    // staged discovery. Slipstream claims still require exact confirmation.
    if (!/(slipstream|concentrated|\bclmm\b|\bcg-cl-)/.test(familyDescriptor)) return false;
  }
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

// Exhaustive staged-source → published source-family mapping: adding a staged
// source without a row fails this record's type. `dl` and `direct_api` rows are
// this repo's own live-lane write-back, so they map to their own family. The
// gecko_terminal fallback still covers staged rows whose persisted source
// string outlives this deploy, including prototype-named keys that plain
// Record indexing would inherit.
const STAGED_SOURCE_FAMILY: Record<StagedPool["source"], LiquidityPoolSourceFamily> = {
  dl: "dl",
  direct_api: "direct_api",
  cg_onchain: "cg_onchain",
  gecko_terminal: "gecko_terminal",
  dexscreener: "dexscreener",
  cg_tickers: "cg_tickers",
  horizon: "horizon",
  aquarius: "aquarius",
  tezos: "tezos",
  "icon-balanced": "icon-balanced",
  "kava-swap": "kava-swap",
  "osmosis-sqs": "osmosis-sqs",
  "noble-swap": "noble-swap",
};

/**
 * Read staged pools from dex_pool_registry that refreshed within
 * STAGED_POOL_CONFIDENCE_HORIZON_HOURS, convert to pool entries with confidence
 * decay and defaults, and merge into existing metrics. The horizon is inventory
 * memory only: price evidence is separately pinned to
 * STAGED_POOL_PRICE_MAX_AGE_HOURS, and volume carries its raw reading plus
 * observation clock so scoring counts it only inside
 * DEX_VOLUME_OBSERVATION_MAX_AGE_SEC (decay applies to TVL, never to flow).
 *
 * Liquidity v6.92: a view carrying the dead-pool signature stages no price
 * observation when its decayed TVL clears the dead-pool floor, and a live-lane
 * pool with no volume reading adopts the reading of the registry view it
 * dedup-skips (same coin, same exact pool id). `trackedDeployments` is the
 * chain-address → stablecoin index that decides whether a counter-token is a
 * tracked deployment. Only chains on which CoinGecko Onchain indexes trades
 * (collectTradeIndexedChains over the rows read here) can carry a signature.
 */
export async function mergeStagedPools(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  knownPoolIndex: KnownPoolIdentityIndex,
  nowSec: number,
  trackedDeployments: ReadonlyMap<string, string>,
  references?: PriceValidationReferences,
  authoritativeConfirmation?: AuthoritativeStagedPoolConfirmationIndex,
  fallbackCounters?: LiquidityFallbackCounters,
  signal?: AbortSignal,
): Promise<{
  mergedCount: number;
  skippedCount: number;
  skippedByExactIdentityCount: number;
  skippedByUniqueDerivedIdentityCount: number;
  skippedByOptionalWildcardIdentityCount: number;
  skippedByAuthoritativeProtocolCount: number;
  skipDimensions: StagedPoolSkipDimension[];
  priceObservations: Map<string, DexPriceObs[]>;
  registryRowsRead: number;
  registryMultiSourcePools: number;
  registryFamilyBySource: Record<string, number>;
  deadPoolUnindexedChainSkips: DeadPoolUnindexedChainSkips;
}> {
  const unreadLivePools = registerRetainedPoolExactStablecoins(knownPoolIndex, metrics);
  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT pool_id, stablecoin_id, source, chain, protocol, dex_id, symbol,
                       tvl_usd, volume_24h, quality_multiplier, pool_type, fee_tier, balance_ratio, is_stable,
                       base_token, quote_token, quote_symbol, price_usd, locked_liq_pct,
                       raw_json, discovered_at, refreshed_at
                FROM dex_pool_registry WHERE refreshed_at >= ?`,
        )
        // Fetch a 60s grace beyond the confidence horizon so rows that have just
        // crossed it surface as stagedPoolConfidence === 0 and are recorded under
        // the stale_confidence_zero skip reason instead of silently never
        // appearing. Without the grace the read window and the zero gate align
        // exactly and the guard below is unreachable.
        .bind(nowSec - STAGED_POOL_CONFIDENCE_HORIZON_HOURS * 3600 - 60)
        .all<StagedPoolRow>(),
    3,
    signal,
  );
  const rows: Array<StagedPoolRow | undefined> = result.results ?? [];
  const registryRowsRead = rows.length;

  const cgPoolMap = new Map<string, CgNewPool[]>();
  const gtPoolMap = new Map<string, GtNewPool[]>();
  const stagedPriceObs = new Map<string, DexPriceObs[]>();
  let skippedCount = 0;
  let exactIdentitySkipped = 0;
  let uniqueDerivedIdentitySkipped = 0;
  let optionalWildcardIdentitySkipped = 0;
  let authoritativeProtocolSkipped = 0;
  const skipDimensions = new Map<string, StagedPoolSkipDimension>();
  const supersededLegacyLowercaseRows = collectSupersededLegacyLowercaseRows(rows);
  const stagedIdentityCountsByStablecoin = new Map<string, StagedPoolIdentityCounts>();
  const observations: StagedPool[] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    rows[rowIndex] = undefined;
    if (!row) continue;
    if (supersededLegacyLowercaseRows.has(row)) {
      skippedCount++;
      incrementSkipDimension(skipDimensions, "legacy_lowercase_identity_superseded", row);
      continue;
    }
    const stagedPool = toStagedPool(row);
    if (!stagedPool.poolId || !stagedPool.stablecoinId || hasUnreviewedPoolIdentity(stagedPool)) {
      skippedCount++;
      incrementSkipDimension(skipDimensions, "malformed_identity", row);
      continue;
    }
    if (hasInvalidTvl(stagedPool)) {
      skippedCount++;
      incrementSkipDimension(skipDimensions, "invalid_tvl", stagedPool, { threshold: STAGED_POOL_MAX_TVL_USD });
      continue;
    }
    observations.push(stagedPool);
  }
  rows.length = 0;
  const tradeIndexedChains = collectTradeIndexedChains(observations, nowSec);
  const views: Array<RegistryPoolView | undefined> = resolveRegistryPools(observations, nowSec);
  observations.length = 0;
  let registryMultiSourcePools = 0;
  const registryFamilyBySource: Record<string, number> = {};
  const deadPoolUnindexedChainSkips: DeadPoolUnindexedChainSkips = {};
  for (const view of views) {
    if (!view) continue;
    if (view.sources.length >= 2) registryMultiSourcePools++;
    registryFamilyBySource[view.value.source] = (registryFamilyBySource[view.value.source] ?? 0) + 1;
    const stagedPool = { ...view.value, ...view.metadata, discoveredAt: view.discoveredAt };
    const entry = buildStagedPoolEntry(stagedPool, nowSec);
    if (entry.confidence <= 0) continue;
    incrementStagedIdentityCounts(stagedIdentityCountsByStablecoin, stagedPool.stablecoinId, entry.identity);
  }
  const acceptedStagedIndexesByStablecoin = new Map<string, KnownPoolIdentityIndex>();
  const acceptedStagedIdentities = new Map<
    string,
    { identity: StagedPoolIdentity; stablecoinIds: Set<string> }
  >();

  for (let viewIndex = 0; viewIndex < views.length; viewIndex++) {
    const view = views[viewIndex];
    views[viewIndex] = undefined;
    if (!view) continue;
    const stagedPool = {
      ...view.value,
      ...view.metadata,
      discoveredAt: view.discoveredAt,
      priceUsd: view.price?.priceUsd ?? view.value.priceUsd,
    };
    // The resolver may pair a trusted value row with a price observed by a
    // different source (e.g. a remembered dl TVL row plus a fresh cg_onchain
    // price). That price keeps the value row's family for pool attribution,
    // but it must never inherit it for price confidence or weight.
    const crossSourcePrice = view.price != null && view.price.source !== view.value.source;

    const entry = buildStagedPoolEntry(stagedPool, nowSec);
    const { dexId, poolType, qualityMultiplier, identity, confidence } = entry;
    let priceEligible = view.price != null;
    const normalizedProtocol = normalizeProtocol(stagedPool.protocol || dexId);
    // Preserve the full suffix after the first colon. Orderbook ids and any colon-bearing
    // native ids stay intact. EVM/base58 addresses are colon-free so this is safe.
    const firstColonIndex = stagedPool.poolId.indexOf(":");
    const address = firstColonIndex >= 0 ? stagedPool.poolId.slice(firstColonIndex + 1) : stagedPool.poolId;
    const evmV2ExecutionCandidate = buildEvmV2ExecutionCandidate({
      chain: stagedPool.chain,
      protocol: dexId,
      poolType,
      poolAddress: address,
      tokenAddresses: [stagedPool.baseToken ?? "", stagedPool.quoteToken ?? ""],
      tokenSymbols: parsePoolSymbols(stagedPool.symbol),
    });

    // Compute confidence and adjusted TVL early — needed for price observation gate
    if (confidence === 0) {
      skippedCount++;
      incrementSkipDimension(skipDimensions, "stale_confidence_zero", stagedPool, {
        threshold: STAGED_POOL_CONFIDENCE_HORIZON_HOURS,
      });
      continue;
    }

    const adjustedTvl = (stagedPool.tvlUsd ?? 0) * confidence;
    if (
      stagedPool.priceUsd != null &&
      stagedPool.priceUsd > 0 &&
      !isPlausibleDexObservationPrice(stagedPool.stablecoinId, stagedPool.priceUsd, references)
    ) {
      if (crossSourcePrice) {
        // Only the fallback provider's price failed peg-aware sanity. Drop that
        // price and keep the independently selected value row instead of letting
        // one bad observation erase otherwise valid evidence (R8).
        stagedPool.priceUsd = null;
        priceEligible = false;
      } else {
        skippedCount++;
        incrementSkipDimension(skipDimensions, "invalid_price", stagedPool);
        continue;
      }
    }
    const crossSourcePriceProvenance = crossSourcePrice && priceEligible
      ? {
          priceSourceFamily: Object.prototype.hasOwnProperty.call(STAGED_SOURCE_FAMILY, view.price!.source)
            ? STAGED_SOURCE_FAMILY[view.price!.source]
            : ("gecko_terminal" as const),
          ...(view.price!.tvlUsd != null && Number.isFinite(view.price!.tvlUsd)
            ? { priceEvidenceTvlUsd: view.price!.tvlUsd }
            : {}),
        }
      : undefined;
    if (
      requiresAuthoritativeProtocolConfirmation(
        authoritativeConfirmation,
        normalizedProtocol,
        stagedPool.chain,
        poolType,
        dexId,
        stagedPool.tvlUsd,
      )
    ) {
      const confirmedExactKeys = authoritativeConfirmation?.confirmedExactKeysByProtocol.get(normalizedProtocol);
      if (!identity.exactPoolKey || !confirmedExactKeys?.has(identity.exactPoolKey)) {
        skippedCount++;
        authoritativeProtocolSkipped++;
        incrementSkipDimension(skipDimensions, "authoritative_confirmation_missing", stagedPool);
        continue;
      }
    }

    // DEC-19: the volume reading is the resolver's volume row as observed —
    // never scaled by the TVL confidence decay. Its refresh clock decides at
    // scoring whether it is in-window (measured) or aged (stale, never counted).
    const signatureBeforeChainGate = hasDeadPoolSignature(view, trackedDeployments);
    const viewChain = canonicalExitRouteChain(stagedPool.chain);
    const chainTradeIndexed = tradeIndexedChains.has(viewChain);
    const registryReading = buildRegistryVolumeReading(view, signatureBeforeChainGate && chainTradeIndexed);
    const deadPool = isDeadRegistryPool(registryReading, adjustedTvl, nowSec);
    if (
      signatureBeforeChainGate && !chainTradeIndexed &&
      isDeadRegistryPool(buildRegistryVolumeReading(view, true), adjustedTvl, nowSec)
    ) {
      // Would be dead but CoinGecko shows no traded pool on the chain: kept, and
      // counted so an indexing regression on a major chain stays visible.
      const skipped = deadPoolUnindexedChainSkips[viewChain] ?? { poolCount: 0, tvlUsd: 0 };
      skipped.poolCount++;
      skipped.tvlUsd += adjustedTvl;
      deadPoolUnindexedChainSkips[viewChain] = skipped;
    }

    // Extract price observations BEFORE dedup check.
    // DL yields pools provide pool metrics but never prices; CG/GT staged pools
    // carry priceUsd. These observations still feed diagnostics and later retained-
    // pool price eligibility, but dex_prices is now rebuilt only from the final
    // retained pool set after dedupe and filtering. A dead pool (v6.92) stages
    // no observation: its reserve-seeded price carries no traded evidence.
    if (deadPool && priceEligible && stagedPool.priceUsd != null && stagedPool.priceUsd > 0) {
      if (fallbackCounters) fallbackCounters.stagedDeadPoolPriceObservationExcluded++;
    } else if (
      priceEligible &&
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
        ...buildDexPriceObservationIdentity(identity),
        sourceFamily: view.price!.source,
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
      { allowOptionalWildcard: true, stablecoinId: stagedPool.stablecoinId },
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
      // The live lane already retained this exact pool for this coin. When it
      // observed no volume (Sugar Slipstream publishes none), the resolver's
      // measured reading is the pool's reading: dropping it would hide a
      // trade-verified zero behind a missing value.
      const unreadKey = knownDedupReason === "exact" && identity.exactPoolKey
        ? retainedPoolKey(stagedPool.stablecoinId, identity.exactPoolKey)
        : null;
      const unreadLivePool = unreadKey ? unreadLivePools.get(unreadKey) : undefined;
      if (unreadKey && unreadLivePool && view.volume) {
        unreadLivePool.volumeReading = registryReading;
        unreadLivePool.volumeUsd1d = registryReading.volume24hUsd;
        unreadLivePools.delete(unreadKey);
        if (fallbackCounters) fallbackCounters.stagedLiveVolumeBackfill++;
      }
      if (evmV2ExecutionCandidate) {
        attachEvmV2CandidateToRetainedPool({
          metrics,
          stablecoinId: stagedPool.stablecoinId,
          chain: stagedPool.chain,
          candidate: evmV2ExecutionCandidate,
        });
      }
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
    const acceptedIdentity = acceptedStagedIdentities.get(registrationKey);
    if (acceptedIdentity) {
      acceptedIdentity.stablecoinIds.add(stagedPool.stablecoinId);
    } else {
      acceptedStagedIdentities.set(registrationKey, {
        identity,
        stablecoinIds: new Set([stagedPool.stablecoinId]),
      });
    }

    const volumeReading = {
      volume24hUsd: registryReading.volume24hUsd,
      volumeObservedAtSec: registryReading.observedAtSec,
      ...(registryReading.deadPoolSignature ? { volumeDeadPoolSignature: true as const } : {}),
    };
    const maturityDays = stagedPoolMaturityDays(stagedPool.discoveredAt, nowSec);
    const orderbookMetadata =
      stagedPool.source === "cg_tickers" ? readCgTickerOrderbookMetadata(stagedPool.rawJson) : null;

    if (stagedPool.source === "cg_onchain") {
      pushPool(cgPoolMap, stagedPool.stablecoinId, {
        address,
        chain: stagedPool.chain,
        dexId,
        name: stagedPool.symbol,
        tvlUsd: adjustedTvl,
        ...volumeReading,
        qualityMultiplier,
        maturityDays,
        poolType,
        // dex_prices → DDR/peg-summary must only see day-fresh prices, while the
        // inventory TVL above may be two weeks old: an aged row keeps its decayed
        // TVL but contributes no price.
        price: priceEligible ? stagedPool.priceUsd ?? 0 : 0,
        symbol: stagedPool.symbol,
        sourceFamily: "cg_onchain",
        ...(crossSourcePriceProvenance ?? {}),
        balanceRatio: stagedPool.balanceRatio,
        lockedLiquidityPct: stagedPool.lockedLiqPct,
        feePercentage: stagedPool.feeTier ? stagedPool.feeTier / 100 : null,
        measurement: {
          tvlMeasured: true,
          volumeMeasured: view.volume != null,
          balanceMeasured: stagedPool.balanceRatio != null,
          maturityMeasured: false,
          priceMeasured: priceEligible && stagedPool.priceUsd != null && stagedPool.priceUsd > 0,
          synthetic: false,
          decayed: confidence < 1,
        },
        ...(evmV2ExecutionCandidate ? { evmV2ExecutionCandidate } : {}),
      });
      continue;
    }

    pushPool(gtPoolMap, stagedPool.stablecoinId, {
      address,
      chain: stagedPool.chain,
      dexId,
      name: stagedPool.symbol,
      tvlUsd: adjustedTvl,
      ...volumeReading,
      qualityMultiplier,
      maturityDays,
      poolType,
      price: priceEligible ? stagedPool.priceUsd ?? 0 : 0,
      symbol: stagedPool.symbol,
      sourceFamily: Object.prototype.hasOwnProperty.call(STAGED_SOURCE_FAMILY, stagedPool.source)
        ? STAGED_SOURCE_FAMILY[stagedPool.source]
        : "gecko_terminal",
      ...(crossSourcePriceProvenance ?? {}),
      ...(evmV2ExecutionCandidate ? { evmV2ExecutionCandidate } : {}),
      ...(stagedPool.source === "cg_tickers"
        ? {
            pairQualityOverride: 0.85,
            ...(orderbookMetadata ?? {}),
            measurement: {
              tvlMeasured: orderbookMetadata?.orderbookDepthUsd != null,
              volumeMeasured: view.volume != null,
              balanceMeasured: false,
              maturityMeasured: false,
              priceMeasured: priceEligible && stagedPool.priceUsd != null && stagedPool.priceUsd > 0,
              synthetic: true,
              decayed: confidence < 1,
            },
          }
        : {
            measurement: {
              tvlMeasured: true,
              volumeMeasured: view.volume != null,
              balanceMeasured: stagedPool.balanceRatio != null,
              maturityMeasured: false,
              priceMeasured: priceEligible && stagedPool.priceUsd != null && stagedPool.priceUsd > 0,
              synthetic: false,
              decayed: confidence < 1,
            },
          }),
    });
  }
  views.length = 0;

  if (uniqueDerivedIdentitySkipped > 0) {
    logWorkerEventArgs("handler", "info", `[dex-liquidity] Skipped ${uniqueDerivedIdentitySkipped} staged pools via unique derived identity`);
  }
  if (optionalWildcardIdentitySkipped > 0) {
    logWorkerEventArgs("handler", "info",
      `[dex-liquidity] Skipped ${optionalWildcardIdentitySkipped} staged pools via optional wildcard identity`,
    );
  }
  if (authoritativeProtocolSkipped > 0) {
    logWorkerEventArgs("handler", "info",
      `[dex-liquidity] Skipped ${authoritativeProtocolSkipped} staged pools missing authoritative protocol confirmation`,
    );
  }
  if (skipDimensions.size > 0) {
    logWorkerEventArgs("handler", "info", `[dex-liquidity] staged skip dimensions ${JSON.stringify([...skipDimensions.values()])}`);
  }

  let mergedCount = 0;
  for (const pools of cgPoolMap.values()) mergedCount += pools.length;
  for (const pools of gtPoolMap.values()) mergedCount += pools.length;

  for (const { identity, stablecoinIds } of acceptedStagedIdentities.values()) {
    registerKnownPoolIdentity(knownPoolIndex, identity);
    for (const stablecoinId of stablecoinIds) {
      registerKnownPoolExactStablecoin(knownPoolIndex, identity, stablecoinId);
    }
  }
  acceptedStagedIdentities.clear();
  acceptedStagedIndexesByStablecoin.clear();
  stagedIdentityCountsByStablecoin.clear();

  if (cgPoolMap.size > 0) {
    await mergeCgPools(metrics, cgPoolMap, db, fallbackCounters);
    cgPoolMap.clear();
  }
  if (gtPoolMap.size > 0) {
    await mergeGtPools(metrics, gtPoolMap, db, fallbackCounters);
    gtPoolMap.clear();
  }

  return {
    mergedCount,
    skippedCount,
    skippedByExactIdentityCount: exactIdentitySkipped,
    skippedByUniqueDerivedIdentityCount: uniqueDerivedIdentitySkipped,
    skippedByOptionalWildcardIdentityCount: optionalWildcardIdentitySkipped,
    skippedByAuthoritativeProtocolCount: authoritativeProtocolSkipped,
    skipDimensions: [...skipDimensions.values()],
    priceObservations: stagedPriceObs,
    registryRowsRead,
    registryMultiSourcePools,
    registryFamilyBySource,
    deadPoolUnindexedChainSkips: Object.fromEntries(
      Object.entries(deadPoolUnindexedChainSkips).map(([chain, { poolCount, tvlUsd }]) => [
        chain,
        { poolCount, tvlUsd: Math.round(tvlUsd) },
      ]),
    ),
  };
}
