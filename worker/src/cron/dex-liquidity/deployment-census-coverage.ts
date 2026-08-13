import { getDexDiscoveryProviders } from "@shared/lib/dex-deployment-coverage";
import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import type { ExitRouteObservationCoverage } from "@shared/types/market";
import type { ContractDeployment } from "@shared/types/core";
import { tryParseJson } from "../../lib/json-parse";
import { estimateDiscoverySweepPeriodSec } from "../dex-discovery/target-window";
import { isRetryableDiscoveryInaccessibleReason } from "../dex-discovery/deployment-outcomes";
import { DISCOVERY_TIERS } from "../dex-discovery/types";

const DEX_ROUTE_CAPABILITY_MATRIX_VERSION = "p4a.8";
const DEX_DISCOVERY_PROVIDER_IDS = new Set([
  "coingecko",
  "geckoterminal",
  "dexscreener",
  "curve",
  "horizon",
]);

/**
 * Freshness floor for every coin. The lowest-priority discovery cohort is
 * eligible daily, so two daily windows bound one missed/deferred crawl without
 * turning an indefinitely old outcome into current known-empty evidence. Coins
 * whose footprint only sweeps across several runs raise this through
 * `resolveDexDeploymentCensusMaxAgeSec()`.
 */
export const DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC =
  DISCOVERY_TIERS.DORMANT_INTERVAL_SEC * 2;

/**
 * Slack on top of one estimated sweep. The static window count is a floor: a run
 * that reaches only part of its window resumes mid-window, so a windowed tail can
 * legitimately land a fraction of a sweep late.
 */
const DEX_DEPLOYMENT_CENSUS_SWEEP_HEADROOM = 1.5;

/**
 * Allowed census-row age for one coin's footprint.
 *
 * A footprint the discovery crawl finishes in a single run keeps the global
 * two-dormant-window bound exactly. A footprint whose priced provider queries
 * exceed the per-coin budget is crawled in rotating windows, so a full census
 * sweep takes several runs and its window tail is older than two days by design.
 * Those coins are allowed their estimated sweep period plus headroom instead of
 * cycling through stale/missing outcomes forever. The bound is derived statically
 * from the registry footprint, the discovery pricing table, and the tier cadence,
 * so it needs no additional persistence.
 */
export function resolveDexDeploymentCensusMaxAgeSec(
  deployments: readonly ContractDeployment[],
): number {
  const sweepPeriodSec = estimateDiscoverySweepPeriodSec(deployments);
  return Math.max(
    DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC,
    Math.ceil(sweepPeriodSec * DEX_DEPLOYMENT_CENSUS_SWEEP_HEADROOM),
  );
}

export interface DexDeploymentCensusRow {
  stablecoin_id: string;
  chain: string;
  contract_address: string;
  outcome: "observed_pools" | "verified_no_pools" | "provider_inaccessible";
  provider_set_json: string;
  reason: string;
  observed_pool_count: number;
  observed_at: number;
  discovery_last_crawl_at: number | null;
}

export type DexPlaceholderCoverageState =
  | "complete-empty"
  | "pools-lost-before-scoring"
  | "provider-outage"
  | "unsupported-method"
  | "discovery-deferral"
  | "validation-failure";

export interface DexPlaceholderCoverageClassification {
  state: DexPlaceholderCoverageState;
  coverage: ExitRouteObservationCoverage;
  census: {
    expectedDeploymentCount: number;
    reviewedDeploymentCount: number;
    verifiedNoPoolsCount: number;
    observedPoolsCount: number;
    providerInaccessibleCount: number;
    missingOutcomeCount: number;
    staleOutcomeCount: number;
    supersededOutcomeCount: number;
    invalidOutcomeCount: number;
    unsupportedChainDeploymentCount: number;
    unsupportedChains: string[];
    oldestObservedAtSec: number | null;
    newestObservedAtSec: number | null;
    maxAgeSec: number;
    reasonCounts: Record<string, number>;
  };
}

function deploymentKey(chain: string, address: string): string {
  return canonicalExitRouteAssetKey(chain, address);
}

function increment(
  counts: Record<string, number>,
  reason: string,
  amount = 1,
): void {
  if (amount <= 0) return;
  counts[reason] = (counts[reason] ?? 0) + amount;
}

function parseProviderCount(raw: string): number | null {
  const parsed = tryParseJson(raw, "dex deployment census provider set");
  return Array.isArray(parsed) &&
    new Set(parsed).size === parsed.length &&
    parsed.every(
      (provider) =>
        typeof provider === "string" &&
        DEX_DISCOVERY_PROVIDER_IDS.has(provider),
    )
    ? parsed.length
    : null;
}

function buildCoverage(
  status: ExitRouteObservationCoverage["status"],
  reasonCounts: Record<string, number>,
): ExitRouteObservationCoverage {
  return {
    status,
    capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
    retainedPoolCount: 0,
    observationCount: 0,
    scoreEligibleObservationCount: 0,
    scoreEligiblePoolCount: 0,
    scoreEligibleCapabilityPoolCount: 0,
    unsupportedPoolCount: 0,
    evidenceCounts: {},
    unsupportedReasons: reasonCounts,
  };
}

export function buildDexKnownEmptyRouteCoverage(): ExitRouteObservationCoverage {
  return buildCoverage("populated", {});
}

/**
 * Classify a zero-scoring-pool publication row against the exact active
 * deployment census. Only a complete, fresh, all-successful reviewed scope can
 * become known-empty. Every other shape remains explicit unknown evidence.
 * Freshness uses this coin's own bound (`resolveDexDeploymentCensusMaxAgeSec`),
 * which is the global bound for every footprint the crawl finishes in one run.
 *
 * The census reports per chain (owner ruling R1-D, 2026-07-29). A deployment on
 * a chain with no registered discovery provider is a standing scope limit, not a
 * failed observation, so it is carried as an explicit unsupported remainder
 * instead of poisoning the provider-supported chains of the same asset. An asset
 * whose whole footprint is unsupported stays unknown exactly as before.
 */
export function classifyDexPlaceholderCoverage(params: {
  deployments: readonly ContractDeployment[];
  outcomeRows: readonly DexDeploymentCensusRow[];
  nowSec: number;
  censusAvailable?: boolean;
}): DexPlaceholderCoverageClassification {
  const reasonCounts: Record<string, number> = {};
  // Freshness is per coin: a windowed footprint cannot refresh every row inside
  // the global bound, so it is judged against its own sweep period.
  const maxAgeSec = resolveDexDeploymentCensusMaxAgeSec(params.deployments);
  const unsupportedChainByKey = new Map<string, string>();
  const expectedKeys = new Set<string>();
  for (const deployment of params.deployments) {
    const key = deploymentKey(deployment.chain, deployment.address);
    if (getDexDiscoveryProviders(deployment.chain, deployment.address).length === 0) {
      unsupportedChainByKey.set(key, deployment.chain);
    } else {
      expectedKeys.add(key);
    }
  }
  const unsupportedChains = [...new Set(unsupportedChainByKey.values())].sort();
  const rowsByKey = new Map<string, DexDeploymentCensusRow[]>();
  for (const row of params.outcomeRows) {
    const key = deploymentKey(row.chain, row.contract_address);
    if (!expectedKeys.has(key)) continue;
    const rows = rowsByKey.get(key) ?? [];
    rows.push(row);
    rowsByKey.set(key, rows);
  }

  let verifiedNoPoolsCount = 0;
  let observedPoolsCount = 0;
  let providerInaccessibleCount = unsupportedChainByKey.size;
  let unsupportedMethodOutcomeCount = 0;
  let missingOutcomeCount = 0;
  let staleOutcomeCount = 0;
  let supersededOutcomeCount = 0;
  let invalidOutcomeCount = 0;
  let oldestObservedAtSec: number | null = null;
  let newestObservedAtSec: number | null = null;

  // The unsupported remainder is a registry fact, so it is reported whether or
  // not the census table could be read.
  increment(
    reasonCounts,
    "deploymentCensusUnsupportedMethod",
    unsupportedChainByKey.size,
  );

  if (params.censusAvailable === false) {
    missingOutcomeCount = expectedKeys.size;
    increment(reasonCounts, "deploymentCensusUnavailable");
  } else if (expectedKeys.size === 0) {
    if (unsupportedChainByKey.size === 0) {
      increment(reasonCounts, "deploymentCensusNoReviewedScope");
    }
  } else {
    for (const key of expectedKeys) {
      const rows = rowsByKey.get(key) ?? [];
      if (rows.length === 0) {
        missingOutcomeCount++;
        continue;
      }
      if (rows.length !== 1) {
        invalidOutcomeCount += rows.length;
        continue;
      }
      const row = rows[0]!;
      if (
        !Number.isInteger(row.observed_at) ||
        row.observed_at <= 0 ||
        !Number.isInteger(row.observed_pool_count) ||
        row.observed_pool_count < 0
      ) {
        invalidOutcomeCount++;
        continue;
      }
      oldestObservedAtSec =
        oldestObservedAtSec === null
          ? row.observed_at
          : Math.min(oldestObservedAtSec, row.observed_at);
      newestObservedAtSec =
        newestObservedAtSec === null
          ? row.observed_at
          : Math.max(newestObservedAtSec, row.observed_at);
      if (
        row.observed_at > params.nowSec ||
        params.nowSec - row.observed_at > maxAgeSec
      ) {
        staleOutcomeCount++;
      }

      const providerCount = parseProviderCount(row.provider_set_json);
      if (providerCount === null) {
        invalidOutcomeCount++;
        continue;
      }
      if (row.outcome === "verified_no_pools") {
        if (
          !Number.isInteger(row.discovery_last_crawl_at) ||
          (row.discovery_last_crawl_at ?? 0) <= 0 ||
          (row.discovery_last_crawl_at ?? 0) > params.nowSec
        ) {
          invalidOutcomeCount++;
          continue;
        }
        if ((row.discovery_last_crawl_at ?? 0) > row.observed_at) {
          supersededOutcomeCount++;
          continue;
        }
        if (row.observed_pool_count !== 0 || providerCount === 0) {
          invalidOutcomeCount++;
        } else {
          verifiedNoPoolsCount++;
        }
      } else if (row.outcome === "observed_pools") {
        if (row.observed_pool_count <= 0 || providerCount === 0) {
          invalidOutcomeCount++;
        } else {
          observedPoolsCount++;
        }
      } else if (row.outcome === "provider_inaccessible") {
        if (row.observed_pool_count !== 0) {
          invalidOutcomeCount++;
        } else if (providerCount === 0) {
          providerInaccessibleCount++;
          unsupportedMethodOutcomeCount++;
          increment(reasonCounts, "deploymentCensusUnsupportedMethod");
        } else if (isRetryableDiscoveryInaccessibleReason(row.reason)) {
          // Transport/budget misses stay a discovery deferral. Treating them as
          // a provider outage published "a data feed failed" for healthy
          // GeckoTerminal/DexScreener chains the crawl simply did not finish.
          missingOutcomeCount++;
        } else {
          providerInaccessibleCount++;
          increment(reasonCounts, "deploymentCensusProviderOutage");
        }
      } else {
        invalidOutcomeCount++;
      }
    }
  }

  increment(reasonCounts, "deploymentCensusMissingOutcome", missingOutcomeCount);
  increment(reasonCounts, "deploymentCensusStaleOutcome", staleOutcomeCount);
  increment(
    reasonCounts,
    "deploymentCensusSupersededOutcome",
    supersededOutcomeCount,
  );
  increment(reasonCounts, "deploymentCensusInvalidOutcome", invalidOutcomeCount);
  increment(
    reasonCounts,
    "deploymentCensusObservedPoolsWithoutScoredPool",
    observedPoolsCount,
  );

  const reviewedDeploymentCount =
    verifiedNoPoolsCount + observedPoolsCount + providerInaccessibleCount;
  let state: DexPlaceholderCoverageState;
  if (observedPoolsCount > 0) {
    state = "pools-lost-before-scoring";
  } else if (invalidOutcomeCount > 0) {
    state = "validation-failure";
  } else if (supersededOutcomeCount > 0) {
    state = "discovery-deferral";
  } else if (reasonCounts.deploymentCensusProviderOutage) {
    state = "provider-outage";
  } else if (unsupportedMethodOutcomeCount > 0) {
    // A provider-supported chain whose census row reports no provider is a
    // reviewable-scope defect, so it still poisons the asset.
    state = "unsupported-method";
  } else if (
    params.censusAvailable === false ||
    missingOutcomeCount > 0 ||
    staleOutcomeCount > 0
  ) {
    state = "discovery-deferral";
  } else if (expectedKeys.size === 0) {
    // Nothing reviewable: either an unsupported-only footprint or no registered
    // deployment at all.
    state = "unsupported-method";
  } else {
    // Every reviewable deployment is a fresh verified-empty result. Any
    // unsupported-chain remainder stays reported in `unsupportedReasons` and the
    // census counters instead of demoting the reviewed scope (R1-D).
    state = "complete-empty";
  }

  return {
    state,
    coverage: buildCoverage(
      state === "complete-empty" ? "populated" : "unknown",
      reasonCounts,
    ),
    census: {
      expectedDeploymentCount: expectedKeys.size + unsupportedChainByKey.size,
      reviewedDeploymentCount,
      verifiedNoPoolsCount,
      observedPoolsCount,
      providerInaccessibleCount,
      missingOutcomeCount,
      staleOutcomeCount,
      supersededOutcomeCount,
      invalidOutcomeCount,
      unsupportedChainDeploymentCount: unsupportedChainByKey.size,
      unsupportedChains,
      oldestObservedAtSec,
      newestObservedAtSec,
      maxAgeSec,
      reasonCounts,
    },
  };
}

export interface DexDeploymentCensusDetailParams {
  classification: DexPlaceholderCoverageClassification;
  generationId: string;
  publishedAtSec: number;
}

/** The published census block, shared by placeholder and zero-pool scored rows. */
export function buildDexDeploymentCensusDetail(
  params: DexDeploymentCensusDetailParams,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    state: params.classification.state,
    generationId: params.generationId,
    publishedAtSec: params.publishedAtSec,
    ...params.classification.census,
  };
}

export function buildDexPlaceholderScoreDetailsJson(
  params: DexDeploymentCensusDetailParams,
): string {
  return JSON.stringify({
    exitRouteObservations: [],
    exitRouteObservationCoverage: params.classification.coverage,
    dexDeploymentCensus: buildDexDeploymentCensusDetail(params),
  });
}
