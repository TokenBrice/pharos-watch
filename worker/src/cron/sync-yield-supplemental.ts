import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { setCacheIfNewer } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
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

function dedupeCandidates(candidates: ResolvedYieldCandidate[]): ResolvedYieldCandidate[] {
  const bySourceKey = new Map<string, ResolvedYieldCandidate>();
  for (const candidate of candidates) {
    if (!candidate.yield?.sourceKey) continue;
    bySourceKey.set(candidate.yield.sourceKey, candidate);
  }
  return [...bySourceKey.values()];
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
      candidates.push({
        symbol: meta.symbol,
        chain,
        address: getTrackedContractAddress(stablecoinId, chain),
        yield: {
          currentApy: apy,
          apyBase: apy,
          apyReward: null,
          sourcePool: null,
          sourceTvlUsd: null,
          dataSource: "onchain",
          exchangeRate: null,
          sourceKey: `aave-v3-onchain:${chain}`,
          yieldSource: `Aave v3 (${chain})`,
          yieldType: "lending-opportunity",
          sourceObservedAt: startSec,
          comparisonAnchorObservedAt: null,
        },
      });
    }
    sourceFamilyCounts.aaveV3 = aaveRates.size;
  }

  const dedupedCandidates = dedupeCandidates(candidates);
  if (dedupedCandidates.length === 0) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        rowsRead: 0,
        rowsWritten: 0,
        sourceCoverage: {
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
      rowsRead: dedupedCandidates.length,
      rowsWritten: dedupedCandidates.length,
      sourceCoverage: {
        supplementalCandidatesWritten: dedupedCandidates.length,
        sourceFamilyCounts,
      },
      fallbackMode: null,
      cacheWriteSkipped: false,
    }),
  };
}
