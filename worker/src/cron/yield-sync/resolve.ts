import {
  ACTIVE_STABLECOINS,
  TRACKED_META_BY_ID,
} from "@shared/lib/stablecoins/registry";
import {
  CHAIN_META,
  normalizeChainId,
} from "@shared/types/chain-identity";
import type {
  StablecoinMeta,
  YieldType,
} from "@shared/types/core";
import {
  normalizeDexSymbol,
} from "../../lib/dex-cron-constants";
import {
  buildChainAddressKey,
  normalizeTokenAddress,
} from "../dex-liquidity/token-resolution";
import {
  logWorkerEventArgs,
  logWorkerEvent,
} from "../../lib/structured-log";
import type {
  DlPool,
  ResolvedYield,
  ResolvedYieldCandidate,
  ResolvedYieldEntry,
  SafetyScoreSnapshot,
  YieldResolutionResult,
} from "./types";
import type {
  WeightedYieldPoolGroupConfig,
} from "../../lib/yield-config/yield-config-weighted-pools";
import {
  resolveYieldRewardShare,
  resolveYieldSourceLabel,
  resolveYieldTypeLabel,
} from "./evaluation";
import {
  YIELD_VARIANT_CHILD_VENUE_PROTOCOLS,
} from "@shared/lib/yield-source-risk-registry";
import type {
  YieldDeploymentPlace,
  YieldSourceRisk,
} from "@shared/types/yield";
import {
  MIN_LENDING_POOL_APY,
  MIN_LENDING_POOL_TVL_SHARE_OF_STABLECOIN_SUPPLY,
  MIN_LENDING_POOL_TVL_USD,
  MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  MIN_SAFETY_SCORE_FOR_YIELD,
} from "../../lib/constants";
import {
  findBestLendingPool,
  isBlockedYieldOpportunitySource,
  computeApyFromRate,
  isDeterministicApyWithinSanityBounds,
  matchAllDlPools,
} from "../yield-helpers";
import {
  type StablecoinSupplyMapState,
  getPriceDerivedApy,
} from "./state";
import {
  AUTO_LENDING_POOL_MAP,
  AUTO_LENDING_SAFETY_BYPASS_IDS,
  isAutoLendingCollisionBlockedForStablecoin,
  LENDING_PROTOCOL_ALLOWLIST,
} from "../../lib/yield-config/yield-config-lending-protocols";
import { EXPLICIT_YIELD_SOURCE_POOL_MAP } from "../../lib/yield-config/yield-config-explicit-pools";
import {
  ON_CHAIN_RATE_CONFIGS,
  PRICE_DERIVED_FALLBACK_IDS,
  RATE_DERIVED_CONFIGS,
} from "../../lib/yield-config/yield-config-rate-sources";
import { YIELD_POOL_MAP } from "../../lib/yield-config/yield-config-pools";
import { YIELD_VARIANT_MAP } from "../../lib/yield-config/yield-config-variants";
import { YIELD_WEIGHTED_POOL_GROUPS } from "../../lib/yield-config/yield-config-weighted-pools";
import {
  DAY_SECONDS,
} from "@shared/lib/time-constants";
import {
  ACTIVE_YIELD_BEARING_STABLECOINS,
} from "@shared/lib/tracked-stablecoin-utils";
import {
  INTENTIONAL_GAP_REASONS,
} from "../../lib/yield-config/yield-config-rate-sources";
import {
  resolveBenchmarkForStablecoin,
  type ParsedYieldBenchmarkMeta,
  type ParsedYieldBenchmarkRegistry,
} from "./benchmarks";
import {
  STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY,
  TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID,
} from "./sources-optional";
import type {
  ChainRpcConfig,
} from "../../lib/chain-registry";
import {
  throwIfAborted,
} from "../../lib/abort";
import {
  buildOnChainSourceKey,
} from "../../lib/yield-utils";
import {
  buildInClause,
} from "../../lib/db";
import {
  isPriceDerivedYieldEligible,
} from "../../lib/yield-config/yield-config-registry";
import {
  resolveYieldBenchmarkDependencies,
} from "../../lib/yield-config/yield-benchmark-dependencies";
import type {
  YieldOptionalSourceOutcome,
} from "./sources-rpc";

export interface YieldIdentityLookups {
  symbolToIds: Map<string, string[]>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  chainAddressToId: Map<string, string>;
}

export interface YieldCandidateIdentityInput {
  symbol?: string | null;
  chain?: string | null;
  address?: string | null;
}

export interface YieldIdentityResolution {
  status: "matched" | "ambiguous" | "unresolved";
  stablecoinId?: string;
  matchType?: "chain-address" | "unique-chain-symbol" | "unique-symbol";
}

function getTrackedContracts(meta: Pick<StablecoinMeta, "contracts" | "tradedContracts">) {
  const result = [];
  const seen = new Set<string>();

  for (const contract of [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])]) {
    const key = buildChainAddressKey(contract.chain, contract.address);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(contract);
  }

  return result;
}

function normalizeYieldSymbol(symbol: string | null | undefined): string {
  return normalizeDexSymbol(symbol ?? "");
}

export function buildYieldIdentityLookups(
  stablecoins: readonly StablecoinMeta[] = ACTIVE_STABLECOINS,
): YieldIdentityLookups {
  const symbolToIds = new Map<string, string[]>();
  const symbolToChainScopedIds = new Map<string, Map<string, string[]>>();
  const chainAddressToId = new Map<string, string>();

  for (const meta of stablecoins) {
    const symbolKey = normalizeYieldSymbol(meta.symbol);
    if (symbolKey) {
      const ids = symbolToIds.get(symbolKey) ?? [];
      if (!ids.includes(meta.id)) {
        ids.push(meta.id);
      }
      symbolToIds.set(symbolKey, ids);
    }

    for (const contract of getTrackedContracts(meta)) {
      const chainId = normalizeChainId(contract.chain);
      if (!chainId) continue;
      const scopedIdsByChain = symbolToChainScopedIds.get(symbolKey) ?? new Map<string, string[]>();
      const scopedIds = scopedIdsByChain.get(chainId) ?? [];
      if (!scopedIds.includes(meta.id)) {
        scopedIds.push(meta.id);
      }
      scopedIdsByChain.set(chainId, scopedIds);
      symbolToChainScopedIds.set(symbolKey, scopedIdsByChain);

      chainAddressToId.set(buildChainAddressKey(chainId, contract.address), meta.id);
    }
  }

  return {
    symbolToIds,
    symbolToChainScopedIds,
    chainAddressToId,
  };
}

export function resolveYieldCandidateStablecoinId(
  candidate: YieldCandidateIdentityInput,
  lookups: YieldIdentityLookups,
): YieldIdentityResolution {
  const normalizedChain = candidate.chain ? normalizeChainId(candidate.chain) : null;
  const candidateAddress = candidate.address?.trim() ?? "";
  if (normalizedChain && candidateAddress) {
    const byChainAddress = lookups.chainAddressToId.get(buildChainAddressKey(normalizedChain, candidateAddress));
    if (byChainAddress) {
      return {
        status: "matched",
        stablecoinId: byChainAddress,
        matchType: "chain-address",
      };
    }
  }
  // Address evidence is authoritative: never replace a failed identity lookup
  // with a ticker match, even when the ticker is unique.
  if (candidateAddress) return { status: "unresolved" };

  const symbolKey = normalizeYieldSymbol(candidate.symbol);
  if (!symbolKey) {
    return { status: "unresolved" };
  }

  if (normalizedChain) {
    const scopedIds = lookups.symbolToChainScopedIds.get(symbolKey)?.get(normalizedChain) ?? [];
    if (scopedIds.length === 1) {
      return {
        status: "matched",
        stablecoinId: scopedIds[0],
        matchType: "unique-chain-symbol",
      };
    }
    if (scopedIds.length > 1) {
      return { status: "ambiguous" };
    }
  }

  const symbolIds = lookups.symbolToIds.get(symbolKey) ?? [];
  if (symbolIds.length === 1) {
    return {
      status: "matched",
      stablecoinId: symbolIds[0],
      matchType: "unique-symbol",
    };
  }
  if (symbolIds.length > 1) {
    return { status: "ambiguous" };
  }

  return { status: "unresolved" };
}

export function canUseSymbolOnlyYieldMatch(
  meta: Pick<StablecoinMeta, "id" | "symbol" | "contracts" | "tradedContracts">,
  lookups: YieldIdentityLookups,
  chain: string | null | undefined,
): boolean {
  const symbolKey = normalizeYieldSymbol(meta.symbol);
  if (!symbolKey) return false;

  if (chain) {
    const chainId = normalizeChainId(chain);
    if (!chainId) return false;
    const scopedIds = lookups.symbolToChainScopedIds.get(symbolKey)?.get(chainId) ?? [];
    return scopedIds.length === 1 && scopedIds[0] === meta.id;
  }

  const symbolIds = lookups.symbolToIds.get(symbolKey) ?? [];
  return symbolIds.length === 1 && symbolIds[0] === meta.id;
}

function buildDlChainFilter(
  meta: Pick<StablecoinMeta, "contracts" | "tradedContracts">,
): Set<string> | undefined {
  const chainIds = new Set<string>();
  for (const contract of getTrackedContracts(meta)) {
    const chainId = normalizeChainId(contract.chain);
    if (!chainId) continue;
    if (CHAIN_META[chainId]) {
      chainIds.add(chainId);
    }
  }

  return chainIds.size > 0 ? chainIds : undefined;
}

function getTrackedContractAddresses(
  meta: Pick<StablecoinMeta, "contracts" | "tradedContracts">,
  chain?: string | null,
): string[] {
  const normalizedChain = chain ? normalizeChainId(chain) : null;

  return getTrackedContracts(meta)
    .filter(
      (contract) =>
        !normalizedChain || normalizeChainId(contract.chain) === normalizedChain,
    )
    .map((contract) => normalizeTokenAddress(contract.address))
    .filter(Boolean);
}

const MIN_VARIANT_TVL_USD = 500_000;
const WRAPPER_PREFIX_PATTERNS = ["s", "st", "w"];
const WRAPPER_SUFFIX_PATTERNS = ["SAVE", "VAULT", "EARN", "STAKE"];

interface DiscoveredVariant {
  baseSymbol: string;
  variantSymbol: string;
  poolId: string;
  chain: string;
  project: string;
  tvlUsd: number;
  apy: number;
}

type VariantMatchOutcome = "added" | "duplicate";

function maybeAddVariant(
  pool: DlPool,
  seen: Set<string>,
  trackedSymbols: Set<string>,
  candidateSymbol: string,
  normalizedSymbol: string,
  results: DiscoveredVariant[],
): VariantMatchOutcome | null {
  if (!trackedSymbols.has(candidateSymbol)) {
    return null;
  }
  if (seen.has(normalizedSymbol)) {
    return "duplicate";
  }

  results.push({
    baseSymbol: candidateSymbol,
    variantSymbol: pool.symbol,
    poolId: pool.pool,
    chain: pool.chain,
    project: pool.project,
    tvlUsd: pool.tvlUsd,
    apy: pool.apy,
  });
  seen.add(normalizedSymbol);
  return "added";
}

/**
 * C20 — the same wrapper symbol can appear on several chains with different TVL, and
 * DeFiLlama's iteration order is arbitrary. Scan the deepest pool first so the
 * reported variant is the largest one (the previous first-wins rule kept a $500k row
 * over its $900k twin) and log how many same-symbol duplicates were dropped.
 */
export function scanForNewVariants(
  dlPools: DlPool[],
  trackedSymbols: Set<string>,
  knownVariantSymbols: Set<string>,
): DiscoveredVariant[] {
  const results: DiscoveredVariant[] = [];
  const seen = new Set<string>();
  let discardedDuplicateCount = 0;

  for (const pool of [...dlPools].sort((a, b) => b.tvlUsd - a.tvlUsd)) {
    if (pool.exposure !== "single") continue;
    if (pool.tvlUsd < MIN_VARIANT_TVL_USD) continue;
    if (pool.apy <= 0) continue;

    const sym = pool.symbol.toUpperCase();
    if (knownVariantSymbols.has(sym)) continue;

    for (const prefix of WRAPPER_PREFIX_PATTERNS) {
      const prefixUpper = prefix.toUpperCase();
      if (sym.startsWith(prefixUpper) && sym.length > prefixUpper.length) {
        const outcome = maybeAddVariant(pool, seen, trackedSymbols, sym.slice(prefixUpper.length), sym, results);
        if (outcome === "duplicate") discardedDuplicateCount += 1;
      }
    }

    for (const suffix of WRAPPER_SUFFIX_PATTERNS) {
      const suffixUpper = suffix.toUpperCase();
      if (sym.endsWith(suffixUpper) && sym.length > suffixUpper.length) {
        const outcome = maybeAddVariant(pool, seen, trackedSymbols, sym.slice(0, -suffixUpper.length), sym, results);
        if (outcome === "duplicate") discardedDuplicateCount += 1;
      }
    }
  }

  if (discardedDuplicateCount > 0) {
    logWorkerEventArgs("handler", "info",
      `[sync-yield-data] Variant scanner kept the highest-TVL pool for ${discardedDuplicateCount} duplicate wrapper symbol match(es)`,
    );
  }
  return results;
}

function normalizeDlIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function isUsableWeightedPool(
  pool: DlPool | undefined,
  config: WeightedYieldPoolGroupConfig,
): pool is DlPool {
  const expectedChain = pool ? config.expectedChainsByPoolId[pool.pool] : null;
  return Boolean(
    pool &&
      expectedChain &&
      pool.exposure === "single" &&
      pool.stablecoin &&
      pool.project === config.expectedProject &&
      normalizeDlIdentity(pool.symbol) === normalizeDlIdentity(config.expectedSymbol) &&
      normalizeDlIdentity(pool.chain) === normalizeDlIdentity(expectedChain) &&
      Number.isFinite(pool.tvlUsd) &&
      pool.tvlUsd > 0 &&
      Number.isFinite(pool.apy),
  );
}

function weightedAverage(
  pools: DlPool[],
  readValue: (pool: DlPool) => number | null,
): number | null {
  let totalTvlUsd = 0;
  let weightedTotal = 0;
  for (const pool of pools) {
    const value = readValue(pool);
    if (value == null || !Number.isFinite(value)) return null;
    totalTvlUsd += pool.tvlUsd;
    weightedTotal += value * pool.tvlUsd;
  }
  if (!Number.isFinite(totalTvlUsd) || totalTvlUsd <= 0) return null;
  if (!Number.isFinite(weightedTotal)) return null;
  const weightedValue = weightedTotal / totalTvlUsd;
  return Number.isFinite(weightedValue) ? weightedValue : null;
}

function commonPoolValue(
  pools: DlPool[],
  readValue: (pool: DlPool) => string | null | undefined,
): string | undefined {
  const values = new Set(
    pools
      .map((pool) => readValue(pool))
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  return values.size === 1 ? [...values][0] : undefined;
}

function joinedPoolValues(
  pools: DlPool[],
  readValue: (pool: DlPool) => string | null | undefined,
): string | undefined {
  const values = [
    ...new Set(
      pools
        .map((pool) => readValue(pool))
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];
  return values.length > 0 ? values.join(", ") : undefined;
}

export function buildWeightedYieldPoolGroupSource(
  config: WeightedYieldPoolGroupConfig,
  dlPools: DlPool[],
): ResolvedYield | null {
  const pools = config.poolIds
    .map((poolId) => dlPools.find((pool) => pool.pool === poolId))
    .filter((pool): pool is DlPool => isUsableWeightedPool(pool, config));

  if (pools.length < (config.minPools ?? 1)) return null;

  const totalTvlUsd = pools.reduce((sum, pool) => sum + pool.tvlUsd, 0);
  if (!Number.isFinite(totalTvlUsd) || totalTvlUsd <= 0) return null;

  const currentApy = weightedAverage(pools, (pool) => pool.apy);
  if (currentApy == null) return null;

  const apyBase = weightedAverage(pools, (pool) => pool.apyBase);
  const apyReward = weightedAverage(pools, (pool) =>
    pool.apyReward ?? (resolveYieldRewardShare({
      apyReward: pool.apyReward,
      apyBase: Number.isFinite(pool.apyBase) ? pool.apyBase : null,
      currentApy: pool.apy,
    }) === 0 ? 0 : null),
  );

  return {
    currentApy,
    apyBase,
    apyReward,
    sourcePool: null,
    sourceTvlUsd: totalTvlUsd,
    dataSource: "defillama",
    exchangeRate: null,
    sourceKey: config.sourceKey,
    yieldSource: config.yieldSource,
    yieldType: config.yieldType,
    project: commonPoolValue(pools, (pool) => pool.project),
    chain: joinedPoolValues(pools, (pool) => pool.chain),
  };
}

const CHAIN_LENDING_TVL_FLOOR_USD: Record<string, number> = {
  aptos: MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  berachain: MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  cardano: MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  ink: MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  monad: MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  plasma: MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  solana: MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  stacks: MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  stellar: MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  sui: MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
};

function getActiveStablecoinMeta(stablecoinId: string) {
  return ACTIVE_STABLECOINS.find((meta) => meta.id === stablecoinId);
}

function buildReservedYieldPoolIds(): Set<string> {
  return new Set([
    ...Object.values(YIELD_POOL_MAP),
    ...Object.values(AUTO_LENDING_POOL_MAP),
    ...Object.values(EXPLICIT_YIELD_SOURCE_POOL_MAP)
      .flat()
      .map((config) => config.poolId),
  ]);
}

function normalizeYieldPoolChain(chain: string | null | undefined): string | null {
  if (!chain) return null;
  return normalizeChainId(chain);
}

export function getLendingOpportunityAbsoluteTvlFloor(chain: string | null | undefined): number {
  const normalizedChain = normalizeYieldPoolChain(chain);
  return normalizedChain && CHAIN_LENDING_TVL_FLOOR_USD[normalizedChain] != null
    ? CHAIN_LENDING_TVL_FLOOR_USD[normalizedChain]
    : MIN_LENDING_POOL_TVL_USD;
}

export function getRequiredLendingOpportunityTvlUsd(params: {
  stablecoinId: string;
  poolChain?: string | null;
  baseMinTvlUsd?: number;
  stablecoinSupplyById: Map<string, number>;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
}): number {
  const absoluteFloor = params.baseMinTvlUsd ?? getLendingOpportunityAbsoluteTvlFloor(params.poolChain);
  if (params.stablecoinSupplyMapState !== "ok") {
    return Number.POSITIVE_INFINITY;
  }
  const supplyUsd = params.stablecoinSupplyById.get(params.stablecoinId);
  if (typeof supplyUsd !== "number" || !Number.isFinite(supplyUsd) || supplyUsd <= 0) {
    // A coin absent from an otherwise valid map keeps the absolute-floor policy.
    return absoluteFloor;
  }

  return Math.max(absoluteFloor, supplyUsd * MIN_LENDING_POOL_TVL_SHARE_OF_STABLECOIN_SUPPLY);
}

export type AutoLendingEligibilityReasonCode =
  | "collision"
  | "safety-score"
  | "pool-exposure"
  | "pool-stablecoin"
  | "protocol-allowlist"
  | "apy-floor"
  | "tvl-floor"
  | "supply-map-unavailable"
  | "source-blocked";

export interface AutoLendingEligibilityVerdict {
  eligible: boolean;
  reasonCodes: AutoLendingEligibilityReasonCode[];
  requiredMinTvlUsd: number;
}

/** Canonical explained verdict for deterministic auto-lending publication. */
export function explainDeterministicAutoLendingEligibility(params: {
  stablecoinId: string;
  pool: DlPool;
  safetyScore?: number;
  safetySnapshotAvailable: boolean;
  stablecoinSupplyById: Map<string, number>;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
}): AutoLendingEligibilityVerdict {
  const requiredMinTvlUsd = getRequiredLendingOpportunityTvlUsd({
    stablecoinId: params.stablecoinId,
    poolChain: params.pool.chain,
    stablecoinSupplyById: params.stablecoinSupplyById,
    stablecoinSupplyMapState: params.stablecoinSupplyMapState,
  });
  const reasonCodes: AutoLendingEligibilityReasonCode[] = [];
  if (params.stablecoinSupplyMapState !== "ok") reasonCodes.push("supply-map-unavailable");

  if (isAutoLendingCollisionBlockedForStablecoin(params.stablecoinId, params.pool)) {
    reasonCodes.push("collision");
  }
  if (
    params.safetySnapshotAvailable &&
    !AUTO_LENDING_SAFETY_BYPASS_IDS.has(params.stablecoinId) &&
    (params.safetyScore ?? 0) < MIN_SAFETY_SCORE_FOR_YIELD
  ) {
    reasonCodes.push("safety-score");
  }
  if (params.pool.exposure !== "single") reasonCodes.push("pool-exposure");
  if (!params.pool.stablecoin) reasonCodes.push("pool-stablecoin");
  if (!LENDING_PROTOCOL_ALLOWLIST.has(params.pool.project)) reasonCodes.push("protocol-allowlist");
  if (params.pool.apy < MIN_LENDING_POOL_APY) reasonCodes.push("apy-floor");
  if (params.pool.tvlUsd < requiredMinTvlUsd) reasonCodes.push("tvl-floor");
  if (isBlockedYieldOpportunitySource({ poolMeta: params.pool.poolMeta, symbol: params.pool.symbol })) {
    reasonCodes.push("source-blocked");
  }

  return {
    eligible: reasonCodes.length === 0,
    reasonCodes,
    requiredMinTvlUsd,
  };
}

function passesLendingOpportunitySizeGate(params: {
  stablecoinId: string;
  poolChain?: string | null;
  sourceTvlUsd: number | null | undefined;
  baseMinTvlUsd?: number;
  stablecoinSupplyById: Map<string, number>;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
}): boolean {
  if (typeof params.sourceTvlUsd !== "number" || !Number.isFinite(params.sourceTvlUsd) || params.sourceTvlUsd <= 0) {
    return false;
  }

  return params.sourceTvlUsd >= getRequiredLendingOpportunityTvlUsd({
    stablecoinId: params.stablecoinId,
    poolChain: params.poolChain,
    baseMinTvlUsd: params.baseMinTvlUsd,
    stablecoinSupplyById: params.stablecoinSupplyById,
    stablecoinSupplyMapState: params.stablecoinSupplyMapState,
  });
}

const FINAL_TVL_ELIGIBILITY_YIELD_TYPES: Record<string, true> = {
  "lending-opportunity": true,
  "fixed-yield": true,
  "structured-tranche": true,
};

/**
 * Final fail-closed TVL eligibility pass for external venue rows.
 * Removes lending-opportunity / fixed-yield / structured-tranche candidates when
 * stablecoin supply is unavailable, measured sourceTvlUsd is missing, or TVL is
 * below max(chain absolute floor, supply share). Never admits on absolute floor alone.
 * Native yield types (nav-appreciation, rebase, governance-set, lending-vault) are untouched.
 * Discovery-time size gates keep their absolute-floor fallback when supply is missing.
 */
export function enforceExternalOpportunityTvlEligibility(
  resolved: ResolvedYieldEntry[],
  stablecoinSupplyById: Map<string, number>,
): { "tvl-null": number; "tvl-thin": number; "supply-unavailable": number } {
  let tvlNullDrops = 0;
  let tvlThinDrops = 0;
  let supplyUnavailableDrops = 0;
  let writeIdx = 0;

  for (let readIdx = 0; readIdx < resolved.length; readIdx += 1) {
    const entry = resolved[readIdx]!;
    const source = entry.yield;
    const yieldType = source?.yieldType;
    if (!source || !yieldType || !FINAL_TVL_ELIGIBILITY_YIELD_TYPES[yieldType]) {
      resolved[writeIdx] = entry;
      writeIdx += 1;
      continue;
    }

    const supplyUsd = stablecoinSupplyById.get(entry.id);
    if (typeof supplyUsd !== "number" || !Number.isFinite(supplyUsd) || supplyUsd <= 0) {
      supplyUnavailableDrops += 1;
      continue;
    }

    const sourceTvlUsd = source.sourceTvlUsd;
    if (typeof sourceTvlUsd !== "number" || !Number.isFinite(sourceTvlUsd)) {
      tvlNullDrops += 1;
      continue;
    }

    const requiredTvlUsd = Math.max(
      getLendingOpportunityAbsoluteTvlFloor(source.chain ?? null),
      supplyUsd * MIN_LENDING_POOL_TVL_SHARE_OF_STABLECOIN_SUPPLY,
    );
    if (sourceTvlUsd < requiredTvlUsd) {
      tvlThinDrops += 1;
      continue;
    }

    resolved[writeIdx] = entry;
    writeIdx += 1;
  }

  resolved.length = writeIdx;

  if (tvlNullDrops > 0 || tvlThinDrops > 0 || supplyUnavailableDrops > 0) {
    logWorkerEvent({
      scope: "handler",
      level: "info",
      event: "external-opportunity-tvl-eligibility",
      message: "Dropped external opportunity candidates failing final TVL eligibility",
      job: "sync-yield-data",
      metadata: {
        "tvl-null": tvlNullDrops,
        "tvl-thin": tvlThinDrops,
        "supply-unavailable": supplyUnavailableDrops,
      },
    });
  }

  return {
    "tvl-null": tvlNullDrops,
    "tvl-thin": tvlThinDrops,
    "supply-unavailable": supplyUnavailableDrops,
  };
}

function matchesExplicitYieldPool(
  pool: DlPool,
  config: (typeof EXPLICIT_YIELD_SOURCE_POOL_MAP)[string][number],
): boolean {
  const expectedChain = config.expectedChain ? normalizeYieldPoolChain(config.expectedChain) : null;

  if (pool.exposure !== "single") return false;
  if (config.expectedProject && pool.project !== config.expectedProject) return false;
  if (config.expectedSymbol && pool.symbol.trim().toLowerCase() !== config.expectedSymbol.trim().toLowerCase()) {
    return false;
  }
  if (expectedChain && normalizeYieldPoolChain(pool.chain) !== expectedChain) return false;
  if (pool.apy < (config.minApy ?? MIN_LENDING_POOL_APY)) return false;
  if (pool.tvlUsd < (config.minTvlUsd ?? MIN_LENDING_POOL_TVL_USD)) return false;
  return true;
}

export type YieldCandidateAppendStatus = "appended" | "duplicate" | "size-gated" | "missing-meta";

function isExternalYieldOpportunityType(yieldType: YieldType | undefined): boolean {
  return yieldType === "lending-opportunity" || yieldType === "fixed-yield";
}

function isThirdPartyYieldOpportunityType(yieldType: YieldType | undefined): boolean {
  return isExternalYieldOpportunityType(yieldType) || yieldType === "structured-tranche";
}

interface AppendOptionalYieldCandidateInput {
  resolved: ResolvedYieldEntry[];
  entry: ResolvedYieldCandidate;
  meta: { id: string; symbol: string; contracts?: Array<{ chain?: string }>; } | null;
  stablecoinSupplyById: Map<string, number>;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
}

export function appendOptionalYieldCandidate(input: AppendOptionalYieldCandidateInput): YieldCandidateAppendStatus {
  const { resolved, entry, meta } = input;
  if (!meta) {
    return "missing-meta";
  }

  if (
    isExternalYieldOpportunityType(entry.yield.yieldType) &&
    !passesLendingOpportunitySizeGate({
      stablecoinId: meta.id,
      poolChain: entry.chain ?? meta.contracts?.[0]?.chain ?? null,
      sourceTvlUsd: entry.yield.sourceTvlUsd,
      stablecoinSupplyById: input.stablecoinSupplyById,
      stablecoinSupplyMapState: input.stablecoinSupplyMapState,
    })
  ) {
    return "size-gated";
  }

  if (resolved.some((resolvedEntry) => resolvedEntry.id === meta.id && resolvedEntry.yield?.sourceKey === entry.yield.sourceKey)) {
    return "duplicate";
  }

  resolved.push({
    id: meta.id,
    symbol: meta.symbol,
    yield: {
      ...entry.yield,
      chain: entry.yield.chain ?? entry.chain ?? null,
    },
  });

  return "appended";
}

function appendResolvedYieldCandidates(
  resolved: ResolvedYieldEntry[],
  entries: ResolvedYieldCandidate[],
  stablecoinSupplyById: Map<string, number>,
  stablecoinSupplyMapState: StablecoinSupplyMapState,
): void {
  const identityLookups = buildYieldIdentityLookups();
  let blockedDrops = 0;
  let ambiguousDrops = 0;
  let unresolvedDrops = 0;
  let sizeGateDrops = 0;

  for (const entry of entries) {
    if (
      isExternalYieldOpportunityType(entry.yield.yieldType) &&
      isBlockedYieldOpportunitySource({ yieldSource: entry.yield.yieldSource })
    ) {
      blockedDrops += 1;
      continue;
    }

    if (entry.stablecoinId) {
      const meta = getActiveStablecoinMeta(entry.stablecoinId);
      if (!meta) {
        unresolvedDrops += 1;
        continue;
      }
      const result = appendOptionalYieldCandidate({
        resolved,
        entry,
        meta,
        stablecoinSupplyById,
        stablecoinSupplyMapState,
      });
      if (result === "size-gated") {
        sizeGateDrops += 1;
      } else if (result === "missing-meta") {
        unresolvedDrops += 1;
      }
      continue;
    }

    const resolution = resolveYieldCandidateStablecoinId(entry, identityLookups);
    if (resolution.status !== "matched" || !resolution.stablecoinId) {
      if (resolution.status === "ambiguous") {
        ambiguousDrops += 1;
      } else {
        unresolvedDrops += 1;
      }
      continue;
    }

    const meta = getActiveStablecoinMeta(resolution.stablecoinId);
    if (!meta) {
      continue;
    }

    const result = appendOptionalYieldCandidate({
      resolved,
      entry,
      meta,
      stablecoinSupplyById,
      stablecoinSupplyMapState,
    });
    if (result === "size-gated") {
      sizeGateDrops += 1;
    }
  }

  if (blockedDrops > 0 || ambiguousDrops > 0 || unresolvedDrops > 0 || sizeGateDrops > 0) {
    logWorkerEventArgs("handler", "warn",
      `[yield-sync] Dropped optional protocol candidates: blocked=${blockedDrops}, ambiguous=${ambiguousDrops}, unresolved=${unresolvedDrops}, sizeGate=${sizeGateDrops}`,
    );
  }
}

function appendResolvedAutoDiscoveredYield(
  resolved: ResolvedYieldEntry[],
  autoDiscoveredIds: Set<string>,
  meta: { id: string; symbol: string },
  pool: Pick<DlPool, "apy" | "apyBase" | "apyReward" | "pool" | "tvlUsd" | "project" | "symbol"> & { chain?: string | null },
): void {
  const yieldType = resolveYieldTypeLabel({ id: meta.id, dataSource: "defillama-auto", pool });
  resolved.push({
    id: meta.id,
    symbol: meta.symbol,
    yield: {
      currentApy: pool.apy,
      apyBase: pool.apyBase,
      apyReward: pool.apyReward,
      sourcePool: pool.pool,
      sourceTvlUsd: pool.tvlUsd,
      dataSource: "defillama-auto",
      yieldType,
      yieldSource: resolveYieldSourceLabel({
        id: meta.id,
        dataSource: yieldType === "lending-opportunity" ? "defillama-auto" : "defillama",
        project: pool.project,
      }),
      exchangeRate: null,
      sourceKey: pool.pool,
      project: pool.project,
      chain: pool.chain ?? null,
    },
  });
  autoDiscoveredIds.add(meta.id);
}

function getResolvedEntryKey(entry: ResolvedYieldEntry): string | null {
  return entry.yield ? `${entry.id}:${entry.yield.sourceKey}` : null;
}


function inferLinkedVariantDeploymentPlace(
  variantKind: string | undefined,
  childYieldType: YieldType | undefined,
): YieldDeploymentPlace | null {
  if (variantKind === "strategy-vault") return "strategy-vault";
  if (variantKind === "savings-passthrough") return "native-wrapper";
  if (variantKind === "risk-absorption" || variantKind === "bond-maturity") return "structured-tranche";
  if (childYieldType === "lp-receipt") return "lp-or-dex";
  if (childYieldType === "lending-vault") return "strategy-vault";
  if (childYieldType === "nav-appreciation" || childYieldType === "rebase") return "native-wrapper";
  if (childYieldType === "governance-set" || childYieldType === "fee-sharing") return "issuer-savings";
  return null;
}

function resolveLinkedVariantChain(
  childId: string,
  source: ResolvedYield,
  contracts: Array<{ chain?: string }> | undefined,
): string | null {
  if (source.sourceRisk?.venueChain) return normalizeYieldPoolChain(source.sourceRisk.venueChain);
  if (source.chain) return normalizeYieldPoolChain(source.chain);
  const onChainConfig = ON_CHAIN_RATE_CONFIGS.find((config) => config.stablecoinId === childId);
  if (onChainConfig) return normalizeYieldPoolChain(onChainConfig.chain);

  const uniqueChains = [...new Set((contracts ?? []).flatMap((contract) => (contract.chain ? [contract.chain] : [])))];
  return uniqueChains.length === 1 ? normalizeYieldPoolChain(uniqueChains[0]!) : null;
}

function buildLinkedVariantSourceRisk(params: {
  childId: string;
  childYieldType: YieldType | undefined;
  variantKind: string | undefined;
  contracts: Array<{ chain?: string }> | undefined;
  source: ResolvedYield;
}): YieldSourceRisk {
  const existing = params.source.sourceRisk ?? {};
  const venueProtocol =
    existing.venueProtocol ??
    params.source.project ??
    YIELD_VARIANT_CHILD_VENUE_PROTOCOLS[params.childId] ??
    null;
  const venueChain = resolveLinkedVariantChain(params.childId, params.source, params.contracts);

  return {
    ...existing,
    deploymentPlace:
      existing.deploymentPlace ?? inferLinkedVariantDeploymentPlace(params.variantKind, params.childYieldType),
    venueProtocol,
    venueChain,
  };
}

function hasParentSourcePool(resolved: ResolvedYieldEntry[], parentId: string, sourcePool: string | null): boolean {
  if (!sourcePool) return false;
  return resolved.some((entry) => entry.id === parentId && entry.yield?.sourcePool === sourcePool);
}

export function appendLinkedVariantParentYieldSources(resolved: ResolvedYieldEntry[]): number {
  const existingKeys = new Set(
    resolved
      .map(getResolvedEntryKey)
      .filter((key): key is string => key != null),
  );
  const existingSourcePools = new Set(
    resolved
      .flatMap((entry) => entry.yield?.sourcePool ? [`${entry.id}:${entry.yield.sourcePool}`] : []),
  );
  const additions: ResolvedYieldEntry[] = [];

  for (const entry of resolved) {
    if (!entry.yield || entry.yield.observationKind === "anchor-only") continue;
    if (entry.yield.dataSource === "defillama-auto") continue;

    const childMeta = getActiveStablecoinMeta(entry.id);
    if (!childMeta?.variantOf) continue;

    const parentMeta = getActiveStablecoinMeta(childMeta.variantOf);
    if (!parentMeta) continue;

    const effectiveYieldType = entry.yield.yieldType ?? childMeta.yieldConfig?.yieldType;
    if (isThirdPartyYieldOpportunityType(effectiveYieldType)) continue;

    const sourcePoolKey = entry.yield.sourcePool ? `${parentMeta.id}:${entry.yield.sourcePool}` : null;
    if (
      sourcePoolKey
      && (existingSourcePools.has(sourcePoolKey) || hasParentSourcePool(additions, parentMeta.id, entry.yield.sourcePool))
    ) {
      continue;
    }

    const sourceKey = `linked-variant:${childMeta.id}:${entry.yield.sourceKey}`;
    const entryKey = `${parentMeta.id}:${sourceKey}`;
    if (existingKeys.has(entryKey)) continue;

    additions.push({
      id: parentMeta.id,
      symbol: parentMeta.symbol,
      yield: {
        ...entry.yield,
        sourceKey,
        yieldSource: entry.yield.yieldSource ?? childMeta.yieldConfig?.yieldSource,
        // Holding the deposit asset does not earn a wrapper's NAV yield. The
        // parent projection therefore represents the action of acquiring the
        // child receipt token, while the original child row remains intrinsic.
        yieldType: "lending-opportunity",
        project:
          entry.yield.sourceRisk?.venueProtocol ??
          entry.yield.project ??
          YIELD_VARIANT_CHILD_VENUE_PROTOCOLS[childMeta.id],
        chain: resolveLinkedVariantChain(childMeta.id, entry.yield, childMeta.contracts),
        sourceRisk: buildLinkedVariantSourceRisk({
          childId: childMeta.id,
          childYieldType: effectiveYieldType,
          variantKind: childMeta.variantKind,
          contracts: childMeta.contracts,
          source: entry.yield,
        }),
      },
    });
    existingKeys.add(entryKey);
    if (sourcePoolKey) {
      existingSourcePools.add(sourcePoolKey);
    }
  }

  resolved.push(...additions);
  return additions.length;
}

function isAlreadyResolved(resolved: ResolvedYieldEntry[], id: string, sourceKey: string): boolean {
  return resolved.some((entry) => entry.id === id && entry.yield?.sourceKey === sourceKey);
}

function appendExplicitPoolSources(
  resolved: ResolvedYieldEntry[],
  dlPools: DlPool[],
  stablecoinSupplyById: Map<string, number>,
  stablecoinSupplyMapState: StablecoinSupplyMapState,
): void {
  for (const [stablecoinId, configs] of Object.entries(EXPLICIT_YIELD_SOURCE_POOL_MAP)) {
    const meta = getActiveStablecoinMeta(stablecoinId);
    if (!meta) continue;

    for (const config of configs) {
      if (isAlreadyResolved(resolved, stablecoinId, config.poolId)) {
        continue;
      }

      const pool = dlPools.find((entry) => entry.pool === config.poolId);
      if (!pool || !matchesExplicitYieldPool(pool, config)) {
        continue;
      }
      if (
        config.yieldType === "lending-opportunity" &&
        !passesLendingOpportunitySizeGate({
          stablecoinId,
          poolChain: config.expectedChain ?? pool.chain,
          sourceTvlUsd: pool.tvlUsd,
          baseMinTvlUsd: config.minTvlUsd ?? getLendingOpportunityAbsoluteTvlFloor(config.expectedChain ?? pool.chain),
          stablecoinSupplyById,
          stablecoinSupplyMapState,
        })
      ) {
        continue;
      }

      resolved.push({
        id: meta.id,
        symbol: meta.symbol,
        yield: {
          currentApy: pool.apy,
          apyBase: pool.apyBase,
          apyReward: pool.apyReward,
          sourcePool: pool.pool,
          sourceTvlUsd: pool.tvlUsd,
          dataSource: config.dataSource ?? "defillama",
          exchangeRate: null,
          sourceKey: pool.pool,
          yieldSource: config.yieldSource,
          yieldType: config.yieldType,
          project: pool.project,
          chain: pool.chain,
        },
      });
    }
  }
}

function appendDeterministicAutoLending(params: {
  resolved: ResolvedYieldEntry[];
  dlPools: DlPool[];
  safetyScores: Map<string, SafetyScoreSnapshot>;
  safetySnapshotAvailable: boolean;
  stablecoinSupplyById: Map<string, number>;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
  autoDiscoveredIds: Set<string>;
}): number {
  let deterministicCount = 0;

  for (const [stablecoinId, poolId] of Object.entries(AUTO_LENDING_POOL_MAP).sort(([a], [b]) => a.localeCompare(b))) {
    if (params.autoDiscoveredIds.has(stablecoinId)) continue;

    const pool = params.dlPools.find((entry) => entry.pool === poolId);
    if (!pool) continue;
    const eligibility = explainDeterministicAutoLendingEligibility({
      stablecoinId,
      pool,
      safetyScore: params.safetyScores.get(stablecoinId)?.score,
      safetySnapshotAvailable: params.safetySnapshotAvailable,
      stablecoinSupplyById: params.stablecoinSupplyById,
      stablecoinSupplyMapState: params.stablecoinSupplyMapState,
    });
    if (!eligibility.eligible) continue;

    if (isAlreadyResolved(params.resolved, stablecoinId, poolId)) {
      continue;
    }

    const meta = getActiveStablecoinMeta(stablecoinId);
    if (!meta) continue;

    appendResolvedAutoDiscoveredYield(params.resolved, params.autoDiscoveredIds, meta, pool);
    deterministicCount++;
  }

  return deterministicCount;
}

function appendDynamicAutoLending(params: {
  resolved: ResolvedYieldEntry[];
  dlPools: DlPool[];
  safetyScores: Map<string, SafetyScoreSnapshot>;
  safetySnapshotAvailable: boolean;
  stablecoinSupplyById: Map<string, number>;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
  autoDiscoveredIds: Set<string>;
  reservedPoolIds: Set<string>;
}): number {
  let dynamicCount = 0;

  const lendingCandidates = ACTIVE_STABLECOINS.filter(
    (meta) =>
      !params.autoDiscoveredIds.has(meta.id)
      && meta.flags.pegCurrency !== "GOLD"
      && meta.flags.pegCurrency !== "SILVER"
      && (
        !params.safetySnapshotAvailable
        || (params.safetyScores.get(meta.id)?.score ?? 0) >= MIN_SAFETY_SCORE_FOR_YIELD
      ),
  );
  const identityLookups = buildYieldIdentityLookups();

  for (const meta of lendingCandidates) {
    const chainFilter = buildDlChainFilter(meta);
    const contractAddresses = getTrackedContractAddresses(meta);
    const allowSymbolMatch = chainFilter
      ? Array.from(chainFilter).every((chain) => canUseSymbolOnlyYieldMatch(meta, identityLookups, chain))
      : canUseSymbolOnlyYieldMatch(meta, identityLookups, null);

    const sameSymbolCounts = new Map<string, number>();
    for (const candidate of params.dlPools) {
      if (candidate.exposure !== "single" || normalizeDexSymbol(candidate.symbol) !== normalizeDexSymbol(meta.symbol)) continue;
      const chain = normalizeYieldPoolChain(candidate.chain);
      if (chain) sameSymbolCounts.set(chain, (sameSymbolCounts.get(chain) ?? 0) + 1);
    }
    const pool = findBestLendingPool(
      meta.symbol,
      params.dlPools,
      LENDING_PROTOCOL_ALLOWLIST,
      {
        minApy: MIN_LENDING_POOL_APY,
        minTvlUsd: 0,
        contractAddresses,
        chainFilter,
        allowSymbolMatch,
        reservedPoolIds: params.reservedPoolIds,
        isBlockedPool: (candidate) => {
          if (isAutoLendingCollisionBlockedForStablecoin(meta.id, candidate)) return true;
          const chain = normalizeYieldPoolChain(candidate.chain);
          if (
            meta.flags.yieldBearing
            && normalizeDexSymbol(candidate.symbol) === normalizeDexSymbol(meta.symbol)
            && (YIELD_POOL_MAP[meta.id] != null || (chain && (sameSymbolCounts.get(chain) ?? 0) > 1))
            && candidate.pool !== YIELD_POOL_MAP[meta.id]
          ) return true;
          return !passesLendingOpportunitySizeGate({
            stablecoinId: meta.id,
            poolChain: candidate.chain,
            sourceTvlUsd: candidate.tvlUsd,
            stablecoinSupplyById: params.stablecoinSupplyById,
            stablecoinSupplyMapState: params.stablecoinSupplyMapState,
          });
        },
      },
    );
    if (!pool) continue;

    if (isAlreadyResolved(params.resolved, meta.id, pool.pool)) {
      continue;
    }

    const fullPool = params.dlPools.find((candidate) => candidate.pool === pool.pool)!;
    appendResolvedAutoDiscoveredYield(params.resolved, params.autoDiscoveredIds, meta, fullPool);
    dynamicCount++;
  }

  return dynamicCount;
}

function logNewVariantScan(dlPools: DlPool[]): void {
  const trackedSymbols = new Set(ACTIVE_STABLECOINS.map((meta) => meta.symbol.toUpperCase()));
  const knownVariantSymbols = new Set(
    Object.values(YIELD_VARIANT_MAP).map((variant) => variant.variantSymbol.toUpperCase()),
  );
  const newVariants = scanForNewVariants(dlPools, trackedSymbols, knownVariantSymbols);
  if (newVariants.length > 0) {
    logWorkerEventArgs("handler", "info",
      `[sync-yield-data] Variant scanner found ${newVariants.length} new wrapper tokens:`,
      newVariants.map((variant) => `${variant.variantSymbol} (${variant.baseSymbol}, ${variant.chain}, $${(variant.tvlUsd / 1e6).toFixed(1)}M)`).join(", "),
    );
  }
}

export function appendPoolFamilyYieldSources(params: {
  resolved: ResolvedYieldEntry[];
  dlPools: DlPool[];
  supplementalCandidates: ResolvedYieldCandidate[];
  safetyScores: Map<string, SafetyScoreSnapshot>;
  safetySnapshotAvailable: boolean;
  stablecoinSupplyById: Map<string, number>;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
}): void {
  appendResolvedYieldCandidates(
    params.resolved,
    params.supplementalCandidates,
    params.stablecoinSupplyById,
    params.stablecoinSupplyMapState,
  );

  if (params.dlPools.length === 0) return;

  appendExplicitPoolSources(
    params.resolved,
    params.dlPools,
    params.stablecoinSupplyById,
    params.stablecoinSupplyMapState,
  );

  const reservedExplicitPoolIds = buildReservedYieldPoolIds();
  const autoDiscoveredIds = new Set<string>();
  if (!params.safetySnapshotAvailable) {
    logWorkerEventArgs("handler", "warn", JSON.stringify({
      scope: "sync-yield-data",
      message: "V9 safety snapshot unavailable; retaining eligible auto-lending candidates as unrated",
    }));
  }

  const deterministicCount = appendDeterministicAutoLending({
    resolved: params.resolved,
    dlPools: params.dlPools,
    safetyScores: params.safetyScores,
    safetySnapshotAvailable: params.safetySnapshotAvailable,
    stablecoinSupplyById: params.stablecoinSupplyById,
    stablecoinSupplyMapState: params.stablecoinSupplyMapState,
    autoDiscoveredIds,
  });

  const dynamicCount = appendDynamicAutoLending({
    resolved: params.resolved,
    dlPools: params.dlPools,
    safetyScores: params.safetyScores,
    safetySnapshotAvailable: params.safetySnapshotAvailable,
    stablecoinSupplyById: params.stablecoinSupplyById,
    stablecoinSupplyMapState: params.stablecoinSupplyMapState,
    autoDiscoveredIds,
    reservedPoolIds: reservedExplicitPoolIds,
  });

  logWorkerEventArgs("handler", "info",
    `[sync-yield-data] Auto-discovery: ${deterministicCount + dynamicCount} lending pools (${deterministicCount} deterministic, ${dynamicCount} dynamic)`,
  );

  logNewVariantScan(params.dlPools);
}

function buildConfigByStablecoinId<T extends { stablecoinId: string }>(configs: readonly T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const config of configs) {
    byId.set(config.stablecoinId, config);
  }
  return byId;
}

function resolveMeasuredSourceTvlUsd(params: {
  nativePoolId: string | null;
  dlPoolByPoolId: Map<string, DlPool>;
  onChainTvlUsd?: number | null;
}): number | null {
  if (params.nativePoolId) {
    const pinned = params.dlPoolByPoolId.get(params.nativePoolId);
    const pinnedTvl = pinned?.tvlUsd;
    if (typeof pinnedTvl === "number" && Number.isFinite(pinnedTvl) && pinnedTvl > 0) {
      return pinnedTvl;
    }
  }
  const onChainTvl = params.onChainTvlUsd;
  if (typeof onChainTvl === "number" && Number.isFinite(onChainTvl) && onChainTvl > 0) {
    return onChainTvl;
  }
  return null;
}

function getBenchmarkSourceObservedAt(meta: ParsedYieldBenchmarkMeta): number | null {
  return meta.lastMarketFetchedAt ?? meta.fetchedAt ?? null;
}

export async function loadTier1PrevRateRows(
  db: D1Database,
  tier1CandidateIds: string[],
  sevenDaysAgoSec: number,
): Promise<Map<string, { exchangeRate: number | null; recordedAt: number }>> {
  const tier1PrevRateRows = new Map<string, { exchangeRate: number | null; recordedAt: number }>();
  const candidateIds = [...new Set(tier1CandidateIds)];
  if (candidateIds.length === 0) return tier1PrevRateRows;

  const inClause = buildInClause(candidateIds);
  const result = await db
    .prepare(
      `SELECT /* pharos:yield-sync:tier1-previous-rate */
         stablecoin_id, exchange_rate, recorded_at
       FROM (
         SELECT stablecoin_id, exchange_rate, recorded_at,
                ROW_NUMBER() OVER (
                  PARTITION BY stablecoin_id
                  ORDER BY recorded_at DESC, rowid DESC
                ) AS row_rank
           FROM yield_history
          WHERE stablecoin_id IN (${inClause.sql})
            AND recorded_at <= ?
            AND exchange_rate > 0
            AND (publication_generation_id IS NULL OR publication_state = 'published')
       )
       WHERE row_rank = 1`,
    )
    .bind(...inClause.binds, sevenDaysAgoSec)
    .all<{ stablecoin_id: string; exchange_rate: number | null; recorded_at: number }>();
  for (const row of result.results ?? []) {
    if (tier1PrevRateRows.has(row.stablecoin_id)) continue;
    tier1PrevRateRows.set(row.stablecoin_id, {
      exchangeRate: row.exchange_rate,
      recordedAt: row.recorded_at,
    });
  }
  return tier1PrevRateRows;
}

export async function resolveTrackedYieldSources(params: {
  db: D1Database;
  startSec: number;
  sevenDaysAgoSec: number;
  dlPools: DlPool[];
  onChainRates: Map<string, { rate: number; sourceTvlUsd?: number | null }>;
  safetyScores: Map<string, SafetyScoreSnapshot>;
  riskFreeRates: ParsedYieldBenchmarkRegistry;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  coingeckoApiKey?: string | null;
  onOptionalSourceOutcome?: (outcome: { label: string; outcome: "failed" | "timeout" }) => void;
}): Promise<YieldResolutionResult> {
  const resolved: ResolvedYieldEntry[] = [];
  const tier1PrevRates = new Map<string, number | null>();
  const envelopeRejections: YieldResolutionResult["envelopeRejections"] = [];
  const reservedExplicitPoolIds = buildReservedYieldPoolIds();
  const onChainRateConfigById = buildConfigByStablecoinId(ON_CHAIN_RATE_CONFIGS);
  const rateDerivedConfigById = buildConfigByStablecoinId(RATE_DERIVED_CONFIGS);
  const dlPoolByPoolId = new Map<string, DlPool>();
  for (const pool of params.dlPools) {
    if (!dlPoolByPoolId.has(pool.pool)) {
      dlPoolByPoolId.set(pool.pool, pool);
    }
  }
  const tier1CandidateIds: string[] = [];
  for (const meta of ACTIVE_YIELD_BEARING_STABLECOINS) {
    if (onChainRateConfigById.has(meta.id) && params.onChainRates.has(meta.id)) {
      tier1CandidateIds.push(meta.id);
    }
  }
  const tier1PrevRateRows = await loadTier1PrevRateRows(params.db, tier1CandidateIds, params.sevenDaysAgoSec);

  for (const meta of ACTIVE_YIELD_BEARING_STABLECOINS) {
    if (params.signal?.aborted) {
      throw params.signal.reason instanceof Error
        ? params.signal.reason
        : new Error("sync-yield-data resolution aborted");
    }

    const id = meta.id;
    const symbol = meta.symbol;
    let hasAnySource = false;
    const rateConfig = onChainRateConfigById.get(id);
    const onChainRate = rateConfig ? params.onChainRates.get(id) : undefined;
    // B26 — a zero or non-finite read is a failed read, not a 0% observation.
    // Publishing it would write `exchange_rate: 0` (the next run's anchor) plus an
    // `apy: 0` seed row; the lane stays unresolved and the other lanes still run.
    if (rateConfig && onChainRate && Number.isFinite(onChainRate.rate) && onChainRate.rate > 0) {
      const { rate } = onChainRate;
      const prevRow = tier1PrevRateRows.get(id);
      tier1PrevRates.set(id, prevRow?.exchangeRate ?? null);
      const nativePoolId = YIELD_POOL_MAP[id] ?? null;
      const sourceTvlUsd = resolveMeasuredSourceTvlUsd({
        nativePoolId,
        dlPoolByPoolId,
        onChainTvlUsd: onChainRate.sourceTvlUsd,
      });

      if (prevRow?.exchangeRate && prevRow.exchangeRate > 0) {
        const actualDays = (params.startSec - prevRow.recordedAt) / DAY_SECONDS;
        const apy = computeApyFromRate(rate, prevRow.exchangeRate, actualDays);
        const sourceKey = buildOnChainSourceKey(id);
        if (typeof apy === "number" && isDeterministicApyWithinSanityBounds(apy)) {
          resolved.push({
            id,
            symbol,
            yield: {
              currentApy: apy,
              apyBase: apy,
              apyReward: null,
              sourcePool: nativePoolId,
              sourceTvlUsd,
              dataSource: "onchain",
              exchangeRate: rate,
              sourceKey,
              sourceObservedAt: params.startSec,
              comparisonAnchorObservedAt: prevRow.recordedAt,
            },
          });
          hasAnySource = true;
        } else {
          envelopeRejections.push({
            stablecoinId: id,
            symbol,
            sourceKey,
            computedApy: typeof apy === "number" ? Number(apy.toFixed(6)) : null,
            rejectionReason: typeof apy === "number" ? "apy-sanity-envelope" : apy.reason,
            exchangeRate: rate,
            previousExchangeRate: prevRow.exchangeRate,
            anchorObservedAt: prevRow.recordedAt,
            actualDays: Number(actualDays.toFixed(4)),
          });
        }
      } else {
        resolved.push({
          id,
          symbol,
          yield: {
            observationKind: "anchor-only",
            currentApy: 0,
            apyBase: null,
            apyReward: null,
            sourcePool: nativePoolId,
            sourceTvlUsd,
            dataSource: "onchain",
            exchangeRate: rate,
            sourceKey: buildOnChainSourceKey(id),
            sourceObservedAt: params.startSec,
            comparisonAnchorObservedAt: null,
          },
        });
      }
    }

    const alreadyResolvedKeys = new Set(
      resolved.flatMap((entry) => entry.id === id && entry.yield != null ? [entry.yield.sourceKey] : []),
    );
    const weightedPoolGroup = YIELD_WEIGHTED_POOL_GROUPS[id];
    const weightedPoolGroupSource = weightedPoolGroup
      ? buildWeightedYieldPoolGroupSource(weightedPoolGroup, params.dlPools)
      : null;
    const weightedPoolGroupMemberIds = new Set(
      weightedPoolGroupSource && weightedPoolGroup ? weightedPoolGroup.poolIds : [],
    );
    if (weightedPoolGroupSource && !alreadyResolvedKeys.has(weightedPoolGroupSource.sourceKey)) {
      resolved.push({ id, symbol, yield: weightedPoolGroupSource });
      alreadyResolvedKeys.add(weightedPoolGroupSource.sourceKey);
      hasAnySource = true;
    }

    const dlSources = matchAllDlPools(id, symbol, params.dlPools, YIELD_POOL_MAP, YIELD_VARIANT_MAP, {
      chainFilter: buildDlChainFilter(meta),
      contractAddresses: getTrackedContractAddresses(meta),
      reservedPoolIds: reservedExplicitPoolIds,
      skipBaseSymbolFallback: rateConfig != null,
    });
    for (const dlPool of dlSources) {
      if (
        weightedPoolGroupMemberIds.has(dlPool.pool) ||
        alreadyResolvedKeys.has(dlPool.pool) ||
        !Number.isFinite(dlPool.apy)
      ) {
        continue;
      }

      const fullPool = dlPoolByPoolId.get(dlPool.pool);
      if (!fullPool) continue;

      const variant = YIELD_VARIANT_MAP[id];
      const isVariantPool = variant != null && dlPool.pool !== YIELD_POOL_MAP[id];
      resolved.push({
        id,
        symbol,
        yield: {
          currentApy: fullPool.apy,
          apyBase: fullPool.apyBase,
          apyReward: fullPool.apyReward,
          sourcePool: fullPool.pool,
          sourceTvlUsd: fullPool.tvlUsd,
          dataSource: "defillama",
          exchangeRate: null,
          sourceKey: fullPool.pool,
          yieldSource: isVariantPool ? variant.yieldSource : undefined,
          yieldType: resolveYieldTypeLabel({
            id,
            dataSource: "defillama",
            explicitType: isVariantPool ? variant.yieldType : undefined,
          }),
          project: fullPool.project,
          chain: fullPool.chain,
        },
      });
      alreadyResolvedKeys.add(dlPool.pool);
      hasAnySource = true;
    }

    const allDlSourcesZero = hasAnySource
      && resolved
        .filter((entry): entry is typeof entry & { yield: NonNullable<typeof entry.yield> } => entry.id === id && entry.yield != null)
        .every((entry) => entry.yield.currentApy === 0);

    const shouldTryPriceDerived =
      (meta.flags.navToken || PRICE_DERIVED_FALLBACK_IDS.has(id))
      && isPriceDerivedYieldEligible(id, INTENTIONAL_GAP_REASONS[id])
      && (!hasAnySource || allDlSourcesZero);
    if (shouldTryPriceDerived) {
      const priceDerived = await getPriceDerivedApy(params.db, id);
      if (priceDerived != null) {
        const nativePoolId = YIELD_POOL_MAP[id] ?? null;
        resolved.push({
          id,
          symbol,
          yield: {
            currentApy: priceDerived.apy,
            apyBase: priceDerived.apy,
            apyReward: null,
            sourcePool: nativePoolId,
            sourceTvlUsd: resolveMeasuredSourceTvlUsd({
              nativePoolId,
              dlPoolByPoolId,
            }),
            dataSource: "price-derived",
            exchangeRate: null,
            sourceKey: "price-derived",
            sourceObservedAt: priceDerived.sourceObservedAt,
            comparisonAnchorObservedAt: priceDerived.comparisonAnchorObservedAt,
          },
        });
        hasAnySource = true;
      }
    }

    const rateDerivedConfig = rateDerivedConfigById.get(id);
    if (rateDerivedConfig) {
      const dependencies = resolveYieldBenchmarkDependencies({
        stablecoinId: id,
        dataSource: "rate-derived",
        benchmarks: params.riskFreeRates,
        benchmarkCurrency: null,
        nowSec: params.startSec,
      });
      const benchmarkSelection = resolveBenchmarkForStablecoin({
        stablecoinId: id,
        benchmarks: params.riskFreeRates,
        benchmarkCurrency: dependencies.productKey,
      });
      // Retained market evidence is usable with degraded qualification; a
      // hardcoded fallback is not a measured product return.
      if (!(benchmarkSelection.meta.isFallback && benchmarkSelection.meta.lastMarketRate == null)) {
        const apy = Math.max(0, benchmarkSelection.meta.rate - rateDerivedConfig.spreadBps / 100);
        resolved.push({
          id,
          symbol,
          yield: {
            currentApy: apy,
            apyBase: apy,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "rate-derived",
            exchangeRate: null,
            sourceKey: "rate-derived",
            yieldSource: rateDerivedConfig.label,
            sourceObservedAt: getBenchmarkSourceObservedAt(benchmarkSelection.meta),
            comparisonAnchorObservedAt: null,
            benchmarkOverrideKey: rateDerivedConfig.benchmarkOverrideKey ?? null,
          },
        });
        hasAnySource = true;
      }
    }

    const trackedOptionalEntries = TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.get(id) ?? [];
    for (const entry of trackedOptionalEntries) {
      throwIfAborted(params.signal);
      if (resolved.some((resolvedEntry) => resolvedEntry.id === id && resolvedEntry.yield?.sourceKey === entry.sourceKey)) {
        continue;
      }

      const optionalYield = await entry.run({
        db: params.db,
        startSec: params.startSec,
        signal: params.signal,
        chainRpcs: params.chainRpcs,
        coingeckoApiKey: params.coingeckoApiKey,
        onOutcome: params.onOptionalSourceOutcome,
      });
      if (!optionalYield) continue;

      resolved.push({ id, symbol, yield: optionalYield });
      if (optionalYield.observationKind !== "anchor-only") hasAnySource = true;
    }

    if (!hasAnySource) {
      resolved.push({ id, symbol, yield: null });
    }
  }

  for (const entry of STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY) {
    throwIfAborted(params.signal);
    const matchingTrackedEntry = TRACKED_META_BY_ID.get(entry.stablecoinId);
    if (!matchingTrackedEntry) continue;
    if (resolved.some((resolvedEntry) => resolvedEntry.id === entry.stablecoinId && resolvedEntry.yield?.sourceKey === entry.sourceKey)) {
      continue;
    }

    const optionalYield = await entry.run({
      db: params.db,
      startSec: params.startSec,
      signal: params.signal,
      chainRpcs: params.chainRpcs,
      coingeckoApiKey: params.coingeckoApiKey,
      onOutcome: params.onOptionalSourceOutcome,
    });
    if (!optionalYield) continue;

    resolved.push({
      id: matchingTrackedEntry.id,
      symbol: matchingTrackedEntry.symbol,
      yield: optionalYield,
    });
  }

  return { resolved, tier1PrevRates, envelopeRejections };
}

interface ResolveYieldSourcesParams {
  db: D1Database;
  startSec: number;
  sevenDaysAgoSec: number;
  dlPools: DlPool[];
  onChainRates: Map<string, { rate: number; sourceTvlUsd?: number | null }>;
  safetyScores: Map<string, SafetyScoreSnapshot>;
  safetySnapshotAvailable: boolean;
  riskFreeRates: ParsedYieldBenchmarkRegistry;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  coingeckoApiKey?: string | null;
  supplementalCandidates?: ResolvedYieldCandidate[];
  stablecoinSupplyById: Map<string, number>;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
  onOptionalSourceOutcome?: (outcome: YieldOptionalSourceOutcome) => void;
}

export async function resolveYieldSources({
  db,
  startSec,
  sevenDaysAgoSec,
  dlPools,
  onChainRates,
  safetyScores,
  safetySnapshotAvailable,
  riskFreeRates,
  signal,
  chainRpcs,
  coingeckoApiKey,
  supplementalCandidates = [],
  stablecoinSupplyById,
  stablecoinSupplyMapState,
  onOptionalSourceOutcome,
}: ResolveYieldSourcesParams): Promise<YieldResolutionResult> {
  const trackedResolution = await resolveTrackedYieldSources({
    db,
    startSec,
    sevenDaysAgoSec,
    dlPools,
    onChainRates,
    safetyScores,
    riskFreeRates,
    signal,
    chainRpcs,
    coingeckoApiKey,
    onOptionalSourceOutcome,
  });

  appendPoolFamilyYieldSources({
    resolved: trackedResolution.resolved,
    dlPools,
    supplementalCandidates,
    safetyScores,
    safetySnapshotAvailable,
    stablecoinSupplyById,
    stablecoinSupplyMapState,
  });

  const linkedVariantSourceCount = appendLinkedVariantParentYieldSources(trackedResolution.resolved);
  if (linkedVariantSourceCount > 0) {
    logWorkerEventArgs("handler", "info", `[sync-yield-data] Linked variant projection: ${linkedVariantSourceCount} parent sources`);
  }

  enforceExternalOpportunityTvlEligibility(trackedResolution.resolved, stablecoinSupplyById);

  return trackedResolution;
}
