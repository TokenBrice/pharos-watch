import type { ChainRpcConfig } from "../../lib/chain-registry";
import { resolveTrackedYieldSources } from "./resolve-tracked-sources";
import { appendPoolFamilyYieldSources } from "./resolve-helpers";
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
    stablecoinSupplyById,
  });

  return trackedResolution;
}
