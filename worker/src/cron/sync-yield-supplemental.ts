import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { setCacheIfNewer } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { normalizeTokenAddress } from "./dex-liquidity/token-resolution";
import { buildYieldSupplementalSourcesCache } from "./yield-sync/cache";
import {
  COMPOUND_V3_COMETS,
  fetchAaveV3SupplyRates,
  fetchBeefySources,
  fetchCompoundV3SupplyRates,
  fetchMorphoVaultSources,
  fetchPendleMarketSources,
  fetchYearnKongSources,
  type AaveV3RateTarget,
} from "./yield-sync/sources";
import type { ResolvedYieldCandidate } from "./yield-sync/types";

const YIELD_SUPPLEMENTAL_CACHE_KEY = "yield:supplemental-sources:v1";
const AAVE_SUPPORTED_CHAINS = new Set(["ethereum", "arbitrum", "base"]);

function getTrackedContractAddress(stablecoinId: string, chain: string): string | null {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const contract = meta?.contracts?.find((entry) => entry.chain === chain && entry.address);
  return contract?.address ?? null;
}

function buildAaveTargets(): AaveV3RateTarget[] {
  const targets: AaveV3RateTarget[] = [];

  for (const meta of ACTIVE_STABLECOINS) {
    for (const contract of meta.contracts ?? []) {
      if (
        AAVE_SUPPORTED_CHAINS.has(contract.chain) &&
        contract.address &&
        !targets.some((target) => target.stablecoinId === meta.id && target.chain === contract.chain)
      ) {
        targets.push({
          stablecoinId: meta.id,
          symbol: meta.symbol,
          chain: contract.chain,
          assetAddress: contract.address,
        });
      }
    }
  }

  return targets;
}

function buildAaveSourceKey(stablecoinId: string, chain: string, assetAddress: string | null): string {
  const normalizedAddress = normalizeTokenAddress(assetAddress ?? "");
  return normalizedAddress
    ? `aave-v3-onchain:${chain}:${normalizedAddress}`
    : `aave-v3-onchain:${chain}:${stablecoinId}`;
}

function buildSupplementalCandidateDedupKey(candidate: ResolvedYieldCandidate): string | null {
  const sourceKey = candidate.yield?.sourceKey?.trim();
  if (!sourceKey) return null;

  const chain = (candidate.chain ?? "").trim().toLowerCase();
  const address = normalizeTokenAddress(candidate.address ?? "");
  const symbol = candidate.symbol.trim().toUpperCase();
  const identity = address || symbol;
  return `${sourceKey}|${chain}|${identity}`;
}

function dedupeCandidates(
  candidates: ResolvedYieldCandidate[],
): { candidates: ResolvedYieldCandidate[]; droppedCount: number } {
  const byDedupKey = new Map<string, ResolvedYieldCandidate>();
  let droppedCount = 0;

  for (const candidate of candidates) {
    const dedupKey = buildSupplementalCandidateDedupKey(candidate);
    if (!dedupKey) continue;

    const existing = byDedupKey.get(dedupKey);
    if (!existing) {
      byDedupKey.set(dedupKey, candidate);
      continue;
    }

    droppedCount += 1;
    if ((candidate.yield.currentApy ?? 0) > (existing.yield.currentApy ?? 0)) {
      byDedupKey.set(dedupKey, candidate);
    }
  }

  return {
    candidates: [...byDedupKey.values()],
    droppedCount,
  };
}

export async function syncYieldSupplemental(
  db: D1Database,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const [morphoVaults, pendleMarkets, yearnKongVaults, beefyVaults] = await Promise.all([
    fetchMorphoVaultSources(signal),
    fetchPendleMarketSources(signal),
    fetchYearnKongSources(signal),
    fetchBeefySources(signal),
  ]);

  const sourceFamilyCounts: Record<string, number> = {
    morpho: morphoVaults.length,
    pendle: pendleMarkets.length,
    yearnKong: yearnKongVaults.length,
    beefy: beefyVaults.length,
    compoundV3: 0,
    aaveV3: 0,
  };

  const candidates: ResolvedYieldCandidate[] = [
    ...morphoVaults,
    ...pendleMarkets,
    ...yearnKongVaults,
    ...beefyVaults,
  ];

  const compoundRates = await fetchCompoundV3SupplyRates([...COMPOUND_V3_COMETS], signal, chainRpcs);
  for (const result of compoundRates) {
    const target = COMPOUND_V3_COMETS.find(
      (entry) =>
        result.yield.sourceKey === `protocol-api:compound-v3-supply:${entry.chain}:${entry.comet.toLowerCase()}`,
    );
    if (!target) continue;
    candidates.push({
      symbol: target.symbol,
      chain: target.chain,
      address: getTrackedContractAddress(result.stablecoinId, target.chain),
      yield: result.yield,
    });
  }
  sourceFamilyCounts.compoundV3 = compoundRates.length;

  const aaveTargets = buildAaveTargets();
  if (aaveTargets.length > 0) {
    const { rates: aaveRates } = await fetchAaveV3SupplyRates(aaveTargets, signal, chainRpcs);
    for (const [stablecoinId, { apy, chain }] of aaveRates) {
      const meta = TRACKED_META_BY_ID.get(stablecoinId);
      if (!meta || apy <= 0) continue;
      const assetAddress = getTrackedContractAddress(stablecoinId, chain);
      candidates.push({
        symbol: meta.symbol,
        chain,
        address: assetAddress,
        yield: {
          currentApy: apy,
          apyBase: apy,
          apyReward: null,
          sourcePool: null,
          sourceTvlUsd: null,
          // These are protocol-native lending-market readers, not Tier 1
          // deterministic wrapper sources like ERC-4626 exchange-rate reads.
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: buildAaveSourceKey(stablecoinId, chain, assetAddress),
          yieldSource: `Aave v3 (${chain})`,
          yieldType: "lending-opportunity",
          sourceObservedAt: startSec,
          comparisonAnchorObservedAt: null,
        },
      });
    }
    sourceFamilyCounts.aaveV3 = aaveRates.size;
  }

  const rawCandidateCount = candidates.length;
  const { candidates: dedupedCandidates, droppedCount } = dedupeCandidates(candidates);
  if (dedupedCandidates.length === 0) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        rowsRead: rawCandidateCount,
        rowsWritten: 0,
        rowsDropped: droppedCount,
        sourceCoverage: {
          rawSupplementalCandidates: rawCandidateCount,
          dedupedSupplementalCandidates: 0,
          supplementalCandidatesWritten: 0,
          sourceFamilyCounts,
        },
        fallbackMode: "empty-snapshot",
        cacheWriteSkipped: true,
      }),
    };
  }

  await setCacheIfNewer(
    db,
    YIELD_SUPPLEMENTAL_CACHE_KEY,
    buildYieldSupplementalSourcesCache(dedupedCandidates, startSec),
    startSec,
  );

  return {
    itemCount: dedupedCandidates.length,
    metadata: JSON.stringify({
      rowsRead: rawCandidateCount,
      rowsWritten: dedupedCandidates.length,
      rowsDropped: droppedCount,
      sourceCoverage: {
        rawSupplementalCandidates: rawCandidateCount,
        dedupedSupplementalCandidates: dedupedCandidates.length,
        supplementalCandidatesWritten: dedupedCandidates.length,
        sourceFamilyCounts,
      },
      fallbackMode: null,
      cacheWriteSkipped: false,
    }),
  };
}
