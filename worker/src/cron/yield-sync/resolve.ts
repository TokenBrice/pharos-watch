import { logWorkerEventArgs } from "../../lib/structured-log";
import type { DlPool, ResolvedYieldCandidate, SafetyScoreSnapshot, YieldResolutionResult } from "./types";
import { isBlockedYieldOpportunitySource } from "./yield-helpers";
import { type StablecoinSupplyMapState } from "./state";
import { type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { YieldOptionalSourceOutcome } from "./sources-rpc";
import { appendLinkedVariantParentYieldSources } from "./resolve-linked-variants";
import { resolveTrackedYieldSources } from "./resolve-observations";
import { enforceExternalOpportunityTvlEligibility, appendPoolFamilyYieldSources } from "./resolve-pools";

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

export async function resolveYieldSources(params: ResolveYieldSourcesParams): Promise<YieldResolutionResult> {
  const { supplementalCandidates = [], ...sourceParams } = params;
  const trackedResolution = await resolveTrackedYieldSources(sourceParams);

  appendPoolFamilyYieldSources({
    ...sourceParams,
    resolved: trackedResolution.resolved,
    supplementalCandidates,
  });

  // Exact pins and supplemental sources obey the same reviewed holds as discovery.
  trackedResolution.resolved = trackedResolution.resolved.filter(({ yield: source }) =>
    !source || !isBlockedYieldOpportunitySource({
      project: source.project ?? source.venueProtocol,
      pool: source.sourcePool,
    })
  );

  const linkedVariantSourceCount = appendLinkedVariantParentYieldSources(trackedResolution.resolved);
  if (linkedVariantSourceCount > 0) {
    logWorkerEventArgs("handler", "info", `[sync-yield-data] Linked variant projection: ${linkedVariantSourceCount} parent sources`);
  }

  enforceExternalOpportunityTvlEligibility(trackedResolution.resolved, sourceParams.stablecoinSupplyById);

  return trackedResolution;
}
