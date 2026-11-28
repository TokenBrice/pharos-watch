import {
  DexExitRouteObservationsSchema, ExitRouteObservationCoverageSchema, type DexExitRouteObservation,
  type ExitRouteObservationCoverage,
} from "@shared/types/exit-route";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { DAY_SECONDS, WEEK_SECONDS } from "@shared/lib/time-constants";
import { DEX_MEASURED_FRESHNESS_MAX_SEC } from "@shared/types/measured-execution";
import { isDexExitPayoutConversion } from "@shared/lib/exit-route-output";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
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

// The generation clock dates the run start. A quote can be captured during the
// run or just before midnight and be evaluated in the following daily snapshot.
function inPublicationWindow(route: DexExitRouteObservation, day: number, from: number, until: number) {
  const evidence = route.ammExecutionEvidence;
  const earliestCapture = evidence
    ? Math.min(route.observedAt, evidence.inputReference.observedAt, evidence.outputReference.observedAt)
    : route.observedAt;
  const oldest = route.freshnessBasisAt ?? earliestCapture;
  const newest = evidence
    ? Math.max(route.observedAt, evidence.inputReference.observedAt, evidence.outputReference.observedAt)
    : route.observedAt;
  const evaluatedAt = oldest + route.freshnessSeconds;
  return route.freshnessSeconds <= DEX_MEASURED_FRESHNESS_MAX_SEC && oldest >= from && oldest <= earliestCapture &&
    evaluatedAt >= newest && evaluatedAt <= until && bucketUnixSecondsToUtcDay(evaluatedAt) === day;
}

function comparisonKey(route: DexExitRouteObservation, version: string, matrix: string) {
  if (!route.scoreEligible || route.scope.kind !== "chain-contract" || route.output.kind !== "tracked-stablecoin" ||
      route.output.assetKeys?.length !== 1 || route.output.trackedAssetIds?.length !== 1) {
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
  assetId: string, current: NormalizedDexScoreDetails, currentVersion: string | null, currentUpdatedAt: number,
  history: DexHistoryRow | undefined,
) {
  const now = Math.floor(Date.now() / 1000);
  const currentRoutes = current.exitRouteObservations;
  const previousVersion = history?.methodology_version;
  if (currentUpdatedAt > now || !currentVersion || !previousVersion || !history?.exit_route_summary_json ||
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
    const day = history.snapshot_date;
    if (!inPublicationWindow(prior, day, day - DEX_MEASURED_FRESHNESS_MAX_SEC, day + DAY_SECONDS - 1)) continue;
    const key = comparisonKey(prior, previousVersion, matrix);
    if (key) baselineByKey.set(key, prior);
  }
  const currentDay = bucketUnixSecondsToUtcDay(currentUpdatedAt);
  const until = Math.min(now, currentUpdatedAt + DEX_MEASURED_FRESHNESS_MAX_SEC);
  return currentRoutes.flatMap((route) => {
    if (isDexExitPayoutConversion(assetId, route.output.trackedAssetIds ?? [], ACTIVE_META_BY_ID) ||
        !inPublicationWindow(route, currentDay, currentUpdatedAt - DEX_MEASURED_FRESHNESS_MAX_SEC, until)) return [];
    const key = comparisonKey(route, currentVersion, matrix);
    const prior = key && baselineByKey.get(key);
    return prior ? [{ routeId: route.routeId, observedAt: prior.observedAt, executableUsd: prior.executableUsd }] : [];
  });
}
