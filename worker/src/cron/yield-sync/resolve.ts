import { logWorkerEventArgs } from "../../lib/structured-log";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { resolveTrackedYieldSources } from "./resolve-tracked-sources";
import { appendLinkedVariantParentYieldSources, appendPoolFamilyYieldSources, enforceExternalOpportunityTvlEligibility } from "./resolve-helpers";
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
  onChainRates: Map<string, { rate: number; sourceTvlUsd?: number | null }>;
  safetyScores: Map<string, SafetyScoreSnapshot>;
  safetySnapshotAvailable: boolean;
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
    stablecoinSupplyById,
  });

  const linkedVariantSourceCount = appendLinkedVariantParentYieldSources(trackedResolution.resolved);
  if (linkedVariantSourceCount > 0) {
    logWorkerEventArgs("handler", "info", `[sync-yield-data] Linked variant projection: ${linkedVariantSourceCount} parent sources`);
  }

  enforceExternalOpportunityTvlEligibility(trackedResolution.resolved, stablecoinSupplyById);

  return trackedResolution;
}
