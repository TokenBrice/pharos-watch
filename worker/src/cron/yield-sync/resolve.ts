import type { ChainRpcConfig } from "../../lib/chain-registry";
import { resolveTrackedYieldSources } from "./resolve-tracked-sources";
import { appendLinkedVariantParentYieldSources, appendPoolFamilyYieldSources } from "./resolve-helpers";
import { type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import type {
  DlPool,
  ResolvedYieldCandidate,
  SafetyScoreSnapshot,
  YieldResolutionResult,
} from "./types";

interface ResolveYieldSourcesParams {
  db: D1Database;
  startSec: number;
  sevenDaysAgoSec: number;
  dlPools: DlPool[];
  onChainRates: Map<string, { rate: number }>;
  safetyScores: Map<string, SafetyScoreSnapshot>;
  safetySnapshotAvailable: boolean;
  expectedModel: "v9";
  riskFreeRates: ParsedYieldBenchmarkRegistry;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  coingeckoApiKey?: string | null;
  supplementalCandidates?: ResolvedYieldCandidate[];
  stablecoinSupplyById: Map<string, number>;
}

export async function resolveYieldSources({
  db,
  startSec,
  sevenDaysAgoSec,
  dlPools,
  onChainRates,
  safetyScores,
  safetySnapshotAvailable,
  expectedModel,
  riskFreeRates,
  signal,
  chainRpcs,
  coingeckoApiKey,
  supplementalCandidates = [],
  stablecoinSupplyById,
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
  });

  appendPoolFamilyYieldSources({
    resolved: trackedResolution.resolved,
    dlPools,
    supplementalCandidates,
    safetyScores,
    safetySnapshotAvailable,
    expectedModel,
    stablecoinSupplyById,
  });

  const linkedVariantSourceCount = appendLinkedVariantParentYieldSources(trackedResolution.resolved);
  if (linkedVariantSourceCount > 0) {
    console.log(`[sync-yield-data] Linked variant projection: ${linkedVariantSourceCount} parent sources`);
  }

  return trackedResolution;
}
