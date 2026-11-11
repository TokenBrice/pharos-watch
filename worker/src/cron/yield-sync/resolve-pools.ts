import { EXTERNAL_OPPORTUNITY_YIELD_TYPES } from "@shared/lib/yield-opportunity-risk";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { CHAIN_META, normalizeChainId } from "@shared/types/chain-identity";
import type { StablecoinMeta, YieldType } from "@shared/types/core";
import { normalizeDexSymbol } from "../../lib/dex-cron-constants";
import { normalizeTokenAddress } from "../dex-liquidity/token-resolution";
import { logWorkerEventArgs, logWorkerEvent } from "../../lib/structured-log";
import type { DlPool, ResolvedYieldCandidate, ResolvedYieldEntry, SafetyScoreSnapshot } from "./types";
import { resolveYieldSourceLabel, resolveYieldTypeLabel } from "./source-risk";
import { MIN_LENDING_POOL_APY, MIN_LENDING_POOL_TVL_SHARE_OF_STABLECOIN_SUPPLY, MIN_LENDING_POOL_TVL_USD, MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM, MIN_SAFETY_SCORE_FOR_YIELD } from "../../lib/yield-config/policy";
import { findBestLendingPool, isBlockedYieldOpportunitySource } from "../yield-helpers";
import { type StablecoinSupplyMapState } from "./state";
import { AUTO_LENDING_POOL_MAP, AUTO_LENDING_SAFETY_BYPASS_IDS, isAutoLendingCollisionBlockedForStablecoin, LENDING_PROTOCOL_ALLOWLIST } from "../../lib/yield-config/yield-config-lending-protocols";
import { EXPLICIT_YIELD_SOURCE_POOL_MAP } from "../../lib/yield-config/yield-config-explicit-pools";
import { YIELD_POOL_MAP } from "../../lib/yield-config/yield-config-pools";
import { YIELD_VARIANT_MAP } from "../../lib/yield-config/yield-config-variants";
import { buildYieldIdentityLookups, canUseSymbolOnlyYieldMatch, getTrackedContracts, resolveYieldCandidateStablecoinId } from "./identity";

export function buildDlChainFilter(
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

export function getTrackedContractAddresses(
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

export function getActiveStablecoinMeta(stablecoinId: string) {
  return ACTIVE_STABLECOINS.find((meta) => meta.id === stablecoinId);
}

export function buildReservedYieldPoolIds(): Set<string> {
  return new Set([
    ...Object.values(YIELD_POOL_MAP),
    ...Object.values(AUTO_LENDING_POOL_MAP),
    ...Object.values(EXPLICIT_YIELD_SOURCE_POOL_MAP)
      .flat()
      .map((config) => config.poolId),
  ]);
}

export function normalizeYieldPoolChain(chain: string | null | undefined): string | null {
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
  if (isBlockedYieldOpportunitySource(params.pool)) {
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

const FINAL_TVL_ELIGIBILITY_YIELD_TYPES: Record<string, true> = Object.fromEntries(
  [...EXTERNAL_OPPORTUNITY_YIELD_TYPES].map((yieldType) => [yieldType, true as const]),
);

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

export function isThirdPartyYieldOpportunityType(yieldType: YieldType | undefined): boolean {
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
      isBlockedYieldOpportunitySource({
        project: entry.yield.project ?? entry.yield.venueProtocol,
        pool: entry.yield.sourcePool,
        yieldSource: entry.yield.yieldSource,
      })
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
