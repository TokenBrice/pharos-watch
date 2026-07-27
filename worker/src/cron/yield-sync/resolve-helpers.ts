import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { resolveChainId } from "@shared/lib/chains";
import type { YieldRiskConfigProtocol } from "@shared/lib/yield-source-risk-registry";
import type { YieldType } from "@shared/types/core";
import type { YieldDeploymentPlace, YieldSourceRisk } from "@shared/types/yield";
import {
  MIN_LENDING_POOL_APY,
  MIN_LENDING_POOL_TVL_SHARE_OF_STABLECOIN_SUPPLY,
  MIN_LENDING_POOL_TVL_USD,
  MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  MIN_SAFETY_SCORE_FOR_YIELD,
} from "../../lib/constants";
import { findBestLendingPool, isBlockedYieldOpportunitySource, meetsLendingPoolCoreEligibility } from "../yield-helpers";
import {
  AUTO_LENDING_POOL_MAP,
  AUTO_LENDING_SAFETY_BYPASS_IDS,
  EXPLICIT_YIELD_SOURCE_POOL_MAP,
  isAutoLendingCollisionBlockedForStablecoin,
  LENDING_PROTOCOL_ALLOWLIST,
  ON_CHAIN_RATE_CONFIGS,
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
} from "../yield-config";
import { buildDlChainFilter, buildYieldIdentityLookups, canUseSymbolOnlyYieldMatch, getTrackedContractAddresses, resolveYieldCandidateStablecoinId } from "./identity";
import type {
  DlPool,
  ResolvedYield,
  ResolvedYieldCandidate,
  ResolvedYieldEntry,
  SafetyScoreSnapshot,
} from "./types";
import { scanForNewVariants } from "./variant-scanner";

export const CHAIN_LENDING_TVL_FLOOR_USD: Record<string, number> = {
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

export function buildReservedYieldPoolIds(): Set<string> {
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
  return resolveChainId(chain) ?? chain.toLowerCase();
}

export function getLendingOpportunityAbsoluteTvlFloor(chain: string | null | undefined): number {
  const normalizedChain = normalizeYieldPoolChain(chain);
  return normalizedChain && CHAIN_LENDING_TVL_FLOOR_USD[normalizedChain] != null
    ? CHAIN_LENDING_TVL_FLOOR_USD[normalizedChain]
    : MIN_LENDING_POOL_TVL_USD;
}

function shouldApplyStablecoinSupplySizeGate(stablecoinId: string): boolean {
  const meta = getActiveStablecoinMeta(stablecoinId);
  if (!meta) return false;
  return meta.flags.pegCurrency !== "GOLD" && meta.flags.pegCurrency !== "SILVER";
}

export function getRequiredLendingOpportunityTvlUsd(params: {
  stablecoinId: string;
  poolChain?: string | null;
  baseMinTvlUsd?: number;
  stablecoinSupplyById: Map<string, number>;
}): number {
  const absoluteFloor = params.baseMinTvlUsd ?? getLendingOpportunityAbsoluteTvlFloor(params.poolChain);
  if (!shouldApplyStablecoinSupplySizeGate(params.stablecoinId)) {
    return absoluteFloor;
  }

  const supplyUsd = params.stablecoinSupplyById.get(params.stablecoinId);
  if (typeof supplyUsd !== "number" || !Number.isFinite(supplyUsd) || supplyUsd <= 0) {
    return absoluteFloor;
  }

  return Math.max(absoluteFloor, supplyUsd * MIN_LENDING_POOL_TVL_SHARE_OF_STABLECOIN_SUPPLY);
}

function passesLendingOpportunitySizeGate(params: {
  stablecoinId: string;
  poolChain?: string | null;
  sourceTvlUsd: number | null | undefined;
  baseMinTvlUsd?: number;
  stablecoinSupplyById: Map<string, number>;
}): boolean {
  if (!shouldApplyStablecoinSupplySizeGate(params.stablecoinId)) {
    return true;
  }

  if (typeof params.sourceTvlUsd !== "number" || !Number.isFinite(params.sourceTvlUsd) || params.sourceTvlUsd <= 0) {
    return false;
  }

  return params.sourceTvlUsd >= getRequiredLendingOpportunityTvlUsd({
    stablecoinId: params.stablecoinId,
    poolChain: params.poolChain,
    baseMinTvlUsd: params.baseMinTvlUsd,
    stablecoinSupplyById: params.stablecoinSupplyById,
  });
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
    });
    if (result === "size-gated") {
      sizeGateDrops += 1;
    }
  }

  if (blockedDrops > 0 || ambiguousDrops > 0 || unresolvedDrops > 0 || sizeGateDrops > 0) {
    console.warn(
      `[yield-sync] Dropped optional protocol candidates: blocked=${blockedDrops}, ambiguous=${ambiguousDrops}, unresolved=${unresolvedDrops}, sizeGate=${sizeGateDrops}`,
    );
  }
}

function appendResolvedAutoDiscoveredYield(
  resolved: ResolvedYieldEntry[],
  autoDiscoveredIds: Set<string>,
  meta: { id: string; symbol: string },
  pool: Pick<DlPool, "apy" | "apyBase" | "apyReward" | "pool" | "tvlUsd" | "project"> & { chain?: string | null },
): void {
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

function getEffectiveYieldSource(entry: ResolvedYieldEntry, fallbackSource: string | undefined): string | undefined {
  const source = entry.yield?.yieldSource ?? fallbackSource;
  if (!source) return undefined;
  return source;
}

function getEffectiveYieldType(entry: ResolvedYieldEntry, fallbackType: YieldType | undefined): YieldType | undefined {
  return entry.yield?.yieldType ?? fallbackType;
}

const LINKED_VARIANT_REVIEWED_VENUE_BY_OWNER_ID: Readonly<Record<string, YieldRiskConfigProtocol>> = {
  "bbqusdc-steakhouse": "morpho-blue",
  "gtusdc-gauntlet": "morpho-blue",
  "gtusdcp-gauntlet": "morpho-blue",
  "sdai-sky": "spark-savings",
  "sgho-aave": "aave-v3",
  "steakusdc-steakhouse": "morpho-blue",
  "steakusdt-steakhouse": "morpho-blue",
  "stkgho-umbrella-aave": "aave-v3",
  "susdc-spark": "spark-savings",
  "susdt-spark": "spark-savings",
  "syrupusdc-maple": "maple",
  "syrupusdt-maple": "maple",
  "ybold-yearn": "yearn",
  "yvusdc-yearn": "yearn",
};

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
    LINKED_VARIANT_REVIEWED_VENUE_BY_OWNER_ID[params.childId] ??
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
    if (!entry.yield) continue;
    if (entry.yield.dataSource === "defillama-auto") continue;

    const childMeta = getActiveStablecoinMeta(entry.id);
    if (!childMeta?.variantOf) continue;

    const parentMeta = getActiveStablecoinMeta(childMeta.variantOf);
    if (!parentMeta) continue;

    const effectiveYieldType = getEffectiveYieldType(entry, childMeta.yieldConfig?.yieldType);
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
        yieldSource: getEffectiveYieldSource(entry, childMeta.yieldConfig?.yieldSource),
        // Holding the deposit asset does not earn a wrapper's NAV yield. The
        // parent projection therefore represents the action of acquiring the
        // child receipt token, while the original child row remains intrinsic.
        yieldType: "lending-opportunity",
        project:
          entry.yield.sourceRisk?.venueProtocol ??
          entry.yield.project ??
          LINKED_VARIANT_REVIEWED_VENUE_BY_OWNER_ID[childMeta.id],
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
  autoDiscoveredIds: Set<string>;
}): number {
  let deterministicCount = 0;

  for (const [stablecoinId, poolId] of Object.entries(AUTO_LENDING_POOL_MAP)) {
    if (params.autoDiscoveredIds.has(stablecoinId)) continue;

    const pool = params.dlPools.find((entry) => entry.pool === poolId);
    if (!pool) continue;
    if (isAutoLendingCollisionBlockedForStablecoin(stablecoinId, pool)) continue;

    if (params.safetySnapshotAvailable) {
      const safetyScore = params.safetyScores.get(stablecoinId)?.score ?? 0;
      const bypassSafety = AUTO_LENDING_SAFETY_BYPASS_IDS.has(stablecoinId);
      if (!bypassSafety && safetyScore < MIN_SAFETY_SCORE_FOR_YIELD) continue;
    }

    const requiredMinTvlUsd = getRequiredLendingOpportunityTvlUsd({
      stablecoinId,
      poolChain: pool.chain,
      stablecoinSupplyById: params.stablecoinSupplyById,
    });

    if (!meetsLendingPoolCoreEligibility(pool, {
      allowlist: LENDING_PROTOCOL_ALLOWLIST,
      minApy: MIN_LENDING_POOL_APY,
      minTvlUsd: requiredMinTvlUsd,
    })) continue;
    if (isBlockedYieldOpportunitySource({ poolMeta: pool.poolMeta, symbol: pool.symbol })) continue;

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
    const primaryChain = meta.contracts?.[0]?.chain;
    const minTvlUsd = getRequiredLendingOpportunityTvlUsd({
      stablecoinId: meta.id,
      poolChain: primaryChain,
      stablecoinSupplyById: params.stablecoinSupplyById,
    });

    const chainFilter = buildDlChainFilter(meta);
    const contractAddresses = getTrackedContractAddresses(meta);
    const allowSymbolMatch = chainFilter
      ? Array.from(chainFilter).every((chain) => canUseSymbolOnlyYieldMatch(meta, identityLookups, chain))
      : canUseSymbolOnlyYieldMatch(meta, identityLookups, null);

    const pool = findBestLendingPool(
      meta.symbol,
      params.dlPools,
      LENDING_PROTOCOL_ALLOWLIST,
      {
        minApy: MIN_LENDING_POOL_APY,
        minTvlUsd,
        contractAddresses,
        chainFilter,
        allowSymbolMatch,
        reservedPoolIds: params.reservedPoolIds,
        isBlockedPool: (candidate) => isAutoLendingCollisionBlockedForStablecoin(meta.id, candidate),
      },
    );
    if (!pool) continue;

    if (isAlreadyResolved(params.resolved, meta.id, pool.pool)) {
      continue;
    }

    appendResolvedAutoDiscoveredYield(params.resolved, params.autoDiscoveredIds, meta, pool);
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
    console.log(
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
  expectedModel: "v9";
  stablecoinSupplyById: Map<string, number>;
}): void {
  appendResolvedYieldCandidates(params.resolved, params.supplementalCandidates, params.stablecoinSupplyById);

  if (params.dlPools.length === 0) return;

  appendExplicitPoolSources(params.resolved, params.dlPools, params.stablecoinSupplyById);

  const reservedExplicitPoolIds = buildReservedYieldPoolIds();
  const autoDiscoveredIds = new Set<string>();
  if (!params.safetySnapshotAvailable) {
    const expectedModel = params.expectedModel ?? "unknown";
    console.warn(JSON.stringify({
      scope: "sync-yield-data",
      message: `${expectedModel.toUpperCase()} safety snapshot unavailable; retaining eligible auto-lending candidates as unrated`,
    }));
  }

  const deterministicCount = appendDeterministicAutoLending({
    resolved: params.resolved,
    dlPools: params.dlPools,
    safetyScores: params.safetyScores,
    safetySnapshotAvailable: params.safetySnapshotAvailable,
    stablecoinSupplyById: params.stablecoinSupplyById,
    autoDiscoveredIds,
  });

  const dynamicCount = appendDynamicAutoLending({
    resolved: params.resolved,
    dlPools: params.dlPools,
    safetyScores: params.safetyScores,
    safetySnapshotAvailable: params.safetySnapshotAvailable,
    stablecoinSupplyById: params.stablecoinSupplyById,
    autoDiscoveredIds,
    reservedPoolIds: reservedExplicitPoolIds,
  });

  console.log(
    `[sync-yield-data] Auto-discovery: ${deterministicCount + dynamicCount} lending pools (${deterministicCount} deterministic, ${dynamicCount} dynamic)`,
  );

  logNewVariantScan(params.dlPools);
}
