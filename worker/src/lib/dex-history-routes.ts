import {
  DexExitRouteObservationsSchema, ExitRouteObservationCoverageSchema, type DexExitRouteObservation,
  type ExitRouteObservationCoverage,
} from "@shared/types/exit-route";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { WEEK_SECONDS } from "@shared/lib/time-constants";
import { DEX_MEASURED_FRESHNESS_MAX_SEC } from "@shared/types/measured-execution";
import { normalizeDexLiquidityEvidence } from "./dex-liquidity";
import { safeJsonParse } from "./api-cache-read";
import type { DexHistoryRow, NormalizedDexScoreDetails } from "./dex-liquidity-response";

export function parseDexHistoryRouteSummary(json: string | null) {
  const raw = safeJsonParse<unknown>(json, null, "dex-liquidity-history:exit_route_summary_json");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const summary = raw as Record<string, unknown>;
  const observations = DexExitRouteObservationsSchema.safeParse(summary.observations);
  const coverage = ExitRouteObservationCoverageSchema.safeParse(summary.coverage);
  return {
    ...(observations.success ? { exitRouteObservations: observations.data } : {}),
    ...(coverage.success ? { exitRouteObservationCoverage: coverage.data } : {}),
  };
}

// Only the exact-address Curve reserve simulator is compatible across these releases.
// v7.54 changed CryptoSwap measured quotes; v7.56 changed pool matching; v7.57 adds Monad.
const CURVE_RESERVE_MODEL_VERSIONS = new Set(["7.53", "7.54", "7.55", "7.56", "7.57"]);

function historicalModelIdentity(route: DexExitRouteObservation, version: string, matrix: string): string | null {
  if (route.scope.kind !== "chain-contract") return null;
  const { chain, contractOrPoolId } = route.scope;
  const address = contractOrPoolId.startsWith(chain + ":") ? contractOrPoolId.slice(chain.length + 1) : contractOrPoolId;
  if (route.evidenceKind === "reserve-based-amm-simulation" && route.scope.protocol === "curve" &&
      (!route.reserveModelId || route.reserveModelId === "curve-stableswap-exact") &&
      matrix === "p4a.10" && CURVE_RESERVE_MODEL_VERSIONS.has(version) &&
      canonicalEvmAddress(address, { allowZero: false }) &&
      route.scope.chain !== "monad") {
    return "curve-stableswap-exact:p4a.10";
  }
  // A source change or different release requires new model-equivalence evidence.
  if (route.adapterProfileId) return version + ":" + route.adapterProfileId;
  if (route.evidenceKind === "reserve-based-amm-simulation" && route.reserveModelId) return version + ":" + route.reserveModelId;
  return null;
}

function comparisonKey(route: DexExitRouteObservation, version: string, matrix: string, utcDay: number) {
  if (!route.scoreEligible || route.scope.kind !== "chain-contract" || route.output.kind !== "tracked-stablecoin" ||
      route.output.assetKeys?.length !== 1 || route.output.trackedAssetIds?.length !== 1 ||
      route.freshnessSeconds > DEX_MEASURED_FRESHNESS_MAX_SEC || bucketUnixSecondsToUtcDay(route.observedAt) !== utcDay) {
    return null;
  }
  const modelId = historicalModelIdentity(route, version, matrix);
  if (modelId == null) return null;
  // A route ID identifies the inventory and payout. The same ID can carry a different quote contract.
  return JSON.stringify([
    route.routeId, route.routeFamily, route.scope.chain, route.scope.contractOrPoolId, route.scope.protocol,
    route.output.trackedAssetIds[0], route.output.assetKeys[0],
    route.requestedNotionalUsd, route.maxCostBps, route.settlementHorizonSec,
    route.evidenceKind, modelId, route.adapterProfileId, route.executionModelId,
    route.executionCertificate?.reviewDigest, route.executionCertificate?.capacityBasis,
    route.observationHistory?.conservativeStatistic,
  ]);
}

function consistentCoverage(routes: readonly DexExitRouteObservation[], coverage?: ExitRouteObservationCoverage) {
  return coverage?.status === "populated" && coverage.observationCount === routes.length &&
    coverage.scoreEligibleObservationCount === routes.filter((route) => route.scoreEligible).length &&
    new Set(routes.map((route) => route.routeId)).size === routes.length;
}

export function comparableWeeklyExitBaselines(
  current: NormalizedDexScoreDetails, currentVersion: string | null, currentUpdatedAt: number,
  history: DexHistoryRow | undefined,
) {
  const currentRoutes = current.exitRouteObservations;
  const previousVersion = history?.methodology_version;
  if (!currentVersion || !previousVersion || !history?.exit_route_summary_json ||
      !currentRoutes || !consistentCoverage(currentRoutes, current.exitRouteObservationCoverage) ||
      history.snapshot_date !== bucketUnixSecondsToUtcDay(currentUpdatedAt) - WEEK_SECONDS) return null;
  try {
    if (normalizeDexLiquidityEvidence(history).coverageClass === "unobserved") return null;
  } catch {
    return null;
  }
  const { exitRouteObservations: previous, exitRouteObservationCoverage: coverage } =
    parseDexHistoryRouteSummary(history.exit_route_summary_json);
  const matrix = current.exitRouteObservationCoverage.capabilityMatrixVersion;
  if (!previous || !consistentCoverage(previous, coverage) || coverage?.capabilityMatrixVersion !== matrix) return null;

  const baselineByKey = new Map<string, DexExitRouteObservation>();
  for (const prior of previous) {
    const key = comparisonKey(prior, previousVersion, matrix, history.snapshot_date);
    if (key) baselineByKey.set(key, prior);
  }
  const currentDay = bucketUnixSecondsToUtcDay(currentUpdatedAt);
  return currentRoutes.flatMap((route) => {
    const key = comparisonKey(route, currentVersion, matrix, currentDay);
    const prior = key && baselineByKey.get(key);
    return prior ? [{ routeId: route.routeId, observedAt: prior.observedAt, executableUsd: prior.executableUsd }] : [];
  });
}
