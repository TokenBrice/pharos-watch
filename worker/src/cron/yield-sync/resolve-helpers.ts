import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { resolveChainId } from "@shared/lib/chains";
import {
  MIN_LENDING_POOL_APY,
  MIN_LENDING_POOL_TVL_SHARE_OF_STABLECOIN_SUPPLY,
  MIN_LENDING_POOL_TVL_USD,
  MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM,
  MIN_SAFETY_SCORE_FOR_YIELD,
} from "../../lib/constants";
import { findBestLendingPool, isBlockedYieldOpportunitySource } from "../yield-helpers";
import {
  AUTO_LENDING_POOL_MAP,
  AUTO_LENDING_SAFETY_BYPASS_IDS,
  EXPLICIT_YIELD_SOURCE_POOL_MAP,
  LENDING_PROTOCOL_ALLOWLIST,
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
} from "../yield-config";
import { buildDlChainFilter, buildYieldIdentityLookups, canUseSymbolOnlyYieldMatch, getTrackedContractAddresses, resolveYieldCandidateStablecoinId } from "./identity";
import type {
  DlPool,
  ResolvedYieldCandidate,
  ResolvedYieldEntry,
  SafetyScoreSnapshot,
} from "./types";
import { scanForNewVariants } from "./variant-scanner";

const SMALL_ECOSYSTEM_CHAINS = new Set(["solana", "sui", "aptos", "cardano", "stacks"]);
const OPTIONAL_SINGLE_SOURCE_TIMEOUT_MS = 12_000;

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

function getLendingOpportunityAbsoluteTvlFloor(chain: string | null | undefined): number {
  const normalizedChain = normalizeYieldPoolChain(chain);
  return normalizedChain && SMALL_ECOSYSTEM_CHAINS.has(normalizedChain)
    ? MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM
    : MIN_LENDING_POOL_TVL_USD;
}

function shouldApplyStablecoinSupplySizeGate(stablecoinId: string): boolean {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return false;
  return meta.flags.pegCurrency !== "GOLD" && meta.flags.pegCurrency !== "SILVER";
}

function getRequiredLendingOpportunityTvlUsd(params: {
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
      entry.yield.yieldType === "lending-opportunity" &&
      isBlockedYieldOpportunitySource({ yieldSource: entry.yield.yieldSource })
    ) {
      blockedDrops += 1;
      continue;
    }

    if (entry.stablecoinId) {
      const meta = TRACKED_META_BY_ID.get(entry.stablecoinId);
      if (!meta) {
        unresolvedDrops += 1;
        continue;
      }
      if (
        entry.yield.yieldType === "lending-opportunity" &&
        !passesLendingOpportunitySizeGate({
          stablecoinId: entry.stablecoinId,
          poolChain: entry.chain ?? meta.contracts?.[0]?.chain ?? null,
          sourceTvlUsd: entry.yield.sourceTvlUsd,
          stablecoinSupplyById,
        })
      ) {
        sizeGateDrops += 1;
        continue;
      }
      if (resolved.some((resolvedEntry) => resolvedEntry.id === meta.id && resolvedEntry.yield?.sourceKey === entry.yield.sourceKey)) {
        continue;
      }
      resolved.push({ id: meta.id, symbol: meta.symbol, yield: entry.yield });
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

    const meta = TRACKED_META_BY_ID.get(resolution.stablecoinId);
    if (!meta) continue;
    if (
      entry.yield.yieldType === "lending-opportunity" &&
      !passesLendingOpportunitySizeGate({
        stablecoinId: resolution.stablecoinId,
        poolChain: entry.chain ?? meta.contracts?.[0]?.chain ?? null,
        sourceTvlUsd: entry.yield.sourceTvlUsd,
        stablecoinSupplyById,
      })
    ) {
      sizeGateDrops += 1;
      continue;
    }
    if (resolved.some((resolvedEntry) => resolvedEntry.id === meta.id && resolvedEntry.yield?.sourceKey === entry.yield.sourceKey)) {
      continue;
    }
    resolved.push({ id: meta.id, symbol: meta.symbol, yield: entry.yield });
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
  pool: Pick<DlPool, "apy" | "apyBase" | "apyReward" | "pool" | "tvlUsd" | "project">,
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
    },
  });
  autoDiscoveredIds.add(meta.id);
}

export async function runTimedOptionalSource<T>(
  label: string,
  signal: AbortSignal | undefined,
  fn: (budgetSignal: AbortSignal) => Promise<T>,
  fallback: T,
): Promise<T> {
  const budgetController = new AbortController();
  const timer = setTimeout(() => {
    budgetController.abort(new Error(`${label} timed out after ${Math.round(OPTIONAL_SINGLE_SOURCE_TIMEOUT_MS / 1000)}s`));
  }, OPTIONAL_SINGLE_SOURCE_TIMEOUT_MS);
  const budgetSignal = signal ? AbortSignal.any([signal, budgetController.signal]) : budgetController.signal;

  try {
    return await fn(budgetSignal);
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (budgetController.signal.aborted) {
      console.warn(`[yield] ${label} timed out; continuing without this source`);
    }
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export function appendPoolFamilyYieldSources(params: {
  resolved: ResolvedYieldEntry[];
  dlPools: DlPool[];
  supplementalCandidates: ResolvedYieldCandidate[];
  safetyScores: Map<string, SafetyScoreSnapshot>;
  stablecoinSupplyById: Map<string, number>;
}): void {
  appendResolvedYieldCandidates(params.resolved, params.supplementalCandidates, params.stablecoinSupplyById);

  if (params.dlPools.length > 0) {
    for (const [stablecoinId, configs] of Object.entries(EXPLICIT_YIELD_SOURCE_POOL_MAP)) {
      const meta = TRACKED_META_BY_ID.get(stablecoinId);
      if (!meta) continue;

      for (const config of configs) {
        if (params.resolved.some((entry) => entry.id === stablecoinId && entry.yield?.sourceKey === config.poolId)) {
          continue;
        }

        const pool = params.dlPools.find((entry) => entry.pool === config.poolId);
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
            stablecoinSupplyById: params.stablecoinSupplyById,
          })
        ) {
          continue;
        }

        params.resolved.push({
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
          },
        });
      }
    }
  }

  if (params.dlPools.length > 0) {
    const reservedExplicitPoolIds = buildReservedYieldPoolIds();
    const autoDiscoveredIds = new Set<string>();
    let autoCount = 0;
    let deterministicCount = 0;

    for (const [stablecoinId, poolId] of Object.entries(AUTO_LENDING_POOL_MAP)) {
      if (autoDiscoveredIds.has(stablecoinId)) continue;

      const pool = params.dlPools.find((entry) => entry.pool === poolId);
      if (!pool) continue;

      const safetyScore = params.safetyScores.get(stablecoinId)?.score ?? 0;
      const bypassSafety = AUTO_LENDING_SAFETY_BYPASS_IDS.has(stablecoinId);
      if (!bypassSafety && safetyScore < MIN_SAFETY_SCORE_FOR_YIELD) continue;

      const requiredMinTvlUsd = getRequiredLendingOpportunityTvlUsd({
        stablecoinId,
        poolChain: pool.chain,
        stablecoinSupplyById: params.stablecoinSupplyById,
      });

      const eligible =
        pool.exposure === "single"
        && pool.stablecoin
        && LENDING_PROTOCOL_ALLOWLIST.has(pool.project)
        && pool.apy >= MIN_LENDING_POOL_APY
        && pool.tvlUsd >= requiredMinTvlUsd;
      if (!eligible) continue;
      if (isBlockedYieldOpportunitySource({ poolMeta: pool.poolMeta, symbol: pool.symbol })) continue;

      if (params.resolved.some((entry) => entry.id === stablecoinId && entry.yield?.sourceKey === poolId)) {
        continue;
      }

      const meta = TRACKED_META_BY_ID.get(stablecoinId);
      if (!meta) continue;

      appendResolvedAutoDiscoveredYield(params.resolved, autoDiscoveredIds, meta, pool);
      autoCount++;
      deterministicCount++;
    }

    const lendingCandidates = ACTIVE_STABLECOINS.filter(
      (meta) =>
        !autoDiscoveredIds.has(meta.id)
        && meta.flags.pegCurrency !== "GOLD"
        && meta.flags.pegCurrency !== "SILVER"
        && (params.safetyScores.get(meta.id)?.score ?? 0) >= MIN_SAFETY_SCORE_FOR_YIELD,
    );

    for (const meta of lendingCandidates) {
      const primaryChain = meta.contracts?.[0]?.chain;
      const minTvlUsd = getRequiredLendingOpportunityTvlUsd({
        stablecoinId: meta.id,
        poolChain: primaryChain,
        stablecoinSupplyById: params.stablecoinSupplyById,
      });

      const identityLookups = buildYieldIdentityLookups();
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
          reservedPoolIds: reservedExplicitPoolIds,
        },
      );
      if (!pool) continue;

      if (params.resolved.some((entry) => entry.id === meta.id && entry.yield?.sourceKey === pool.pool)) {
        continue;
      }

      appendResolvedAutoDiscoveredYield(params.resolved, autoDiscoveredIds, meta, pool);
      autoCount++;
    }

    console.log(
      `[sync-yield-data] Auto-discovery: ${autoCount} lending pools (${deterministicCount} deterministic, ${autoCount - deterministicCount} dynamic)`,
    );

    const trackedSymbols = new Set(ACTIVE_STABLECOINS.map((meta) => meta.symbol.toUpperCase()));
    const knownVariantSymbols = new Set(
      Object.values(YIELD_VARIANT_MAP).map((variant) => variant.variantSymbol.toUpperCase()),
    );
    const newVariants = scanForNewVariants(params.dlPools, trackedSymbols, knownVariantSymbols);
    if (newVariants.length > 0) {
      console.log(
        `[sync-yield-data] Variant scanner found ${newVariants.length} new wrapper tokens:`,
        newVariants.map((variant) => `${variant.variantSymbol} (${variant.baseSymbol}, ${variant.chain}, $${(variant.tvlUsd / 1e6).toFixed(1)}M)`).join(", "),
      );
    }
  }
}
