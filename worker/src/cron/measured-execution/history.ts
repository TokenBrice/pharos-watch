import {
  DEX_MEASURED_MATURE_SUCCESSFUL_CYCLE_COUNT,
  DexMeasuredExecutionObservationHistorySchema,
  getDexMeasuredExecutionFreshnessMaxSec,
  type DexMeasuredExecutionObservationHistory,
  type DexMeasuredExecutionProfile,
  type DexMeasuredLegacyHistoryProfile,
} from "@shared/types/measured-execution";
import { buildExitRouteCapacityPoint } from "@shared/lib/exit-route-capacity-point";
import {
  CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
  CURVE_STABLESWAP_MIN_SUCCESSFUL_OBSERVATIONS,
} from "./curve-stableswap";
import {
  CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  CURVE_STABLESWAP_NG_MIN_SUCCESSFUL_OBSERVATIONS,
} from "./curve-stableswap-ng";

// T1 activation, 2026-10-20T12:03:00Z. Remove this transition once all routes
// have mature hash-bound history or the existing source-age window expires.
export const MEASURED_LEGACY_TRANSITION_CUTOFF_SEC = 1_792_497_780;

function requiredHashBoundSuccesses(adapterProfileId: string): number {
  if (adapterProfileId === CURVE_STABLESWAP_ADAPTER_PROFILE_ID) {
    return CURVE_STABLESWAP_MIN_SUCCESSFUL_OBSERVATIONS;
  }
  if (adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID) {
    return CURVE_STABLESWAP_NG_MIN_SUCCESSFUL_OBSERVATIONS;
  }
  return DEX_MEASURED_MATURE_SUCCESSFUL_CYCLE_COUNT;
}

export interface DexMeasuredExecutionHistoryCycle {
  generationId: string;
  publishedAt: number;
  status: "measured" | "failed";
  operationalFailure: boolean;
  profile: DexMeasuredExecutionProfile | null;
  /** Count-only evidence; cannot supply current/LKG execution or capacity. */
  legacyProfile?: DexMeasuredLegacyHistoryProfile;
}

function pointKey(point: DexMeasuredExecutionProfile["capacityCurve"][number]): string {
  return `${point.requestedNotionalUsd}:${point.maxCostBps}`;
}

function supportingQuoteCostBps(
  profile: DexMeasuredExecutionProfile,
  point: DexMeasuredExecutionProfile["capacityCurve"][number],
  executableUsd: number,
): number | null {
  if (executableUsd <= 0 || point.executableUsd + 0.01 < executableUsd) return null;
  const proofCosts = profile.quoteProof
    .filter(
      (quote) =>
        quote.passesCostBound &&
        Math.abs(quote.inputUsd - executableUsd) <= 0.02 &&
        quote.costBps <= point.maxCostBps,
    )
    .map((quote) => quote.costBps);
  if (proofCosts.length > 0) return Math.max(...proofCosts);
  return Math.abs(point.executableUsd - executableUsd) <= 0.01
    ? point.executionCostBps ?? null
    : null;
}

function conservativeCurve(
  profiles: readonly DexMeasuredExecutionProfile[],
): DexMeasuredExecutionObservationHistory["conservativeCapacityCurve"] | null {
  const first = profiles[0];
  if (!first) return null;
  const curves = profiles.map(
    (profile) => new Map(profile.capacityCurve.map((point) => [pointKey(point), point] as const)),
  );
  const result = first.capacityCurve.map((point) => {
    const matching = curves.map((curve) => curve.get(pointKey(point)));
    if (matching.some((candidate) => candidate === undefined)) return null;
    const executableUsd = Math.min(...matching.map((candidate) => candidate!.executableUsd));
    const realizedCosts = profiles.map((profile, index) =>
      supportingQuoteCostBps(profile, matching[index]!, executableUsd),
    );
    const executionCostBps =
      executableUsd <= 0
        ? null
        : realizedCosts.every((cost): cost is number => cost != null)
          ? Math.max(...realizedCosts)
          : point.maxCostBps;
    return buildExitRouteCapacityPoint({
      requestedNotionalUsd: point.requestedNotionalUsd,
      maxCostBps: point.maxCostBps,
      capacityUsd: executableUsd,
      ...(executionCostBps == null ? {} : { executionCostBps }),
    }, { clampNegativeCapacity: true, usdDecimals: null, ratioDecimals: null });
  });
  return result.some((point) => point === null)
    ? null
    : (result as DexMeasuredExecutionObservationHistory["conservativeCapacityCurve"]);
}

/**
 * Summarizes complete published producer cycles inside the score freshness
 * window. Only source-eligible measured profiles at the assessment clock
 * influence success evidence and the conservative curve.
 */
export function summarizeDexMeasuredExecutionHistory(input: {
  cycles: readonly DexMeasuredExecutionHistoryCycle[];
  nowSec: number;
  freshnessMaxSec: number;
}): DexMeasuredExecutionObservationHistory | null {
  const windowStart = input.nowSec - input.freshnessMaxSec;
  const sortedCycles = [...input.cycles]
    .filter(
      (cycle) =>
        Number.isInteger(cycle.publishedAt) &&
        cycle.publishedAt >= windowStart &&
        cycle.publishedAt <= input.nowSec,
    )
    .sort(
      (left, right) =>
        right.publishedAt - left.publishedAt || right.generationId.localeCompare(left.generationId),
    );
  const cycles = [
    ...new Map(sortedCycles.map((cycle) => [cycle.generationId, cycle] as const)).values(),
  ];
  const deterministicFailureIndex = cycles.findIndex(
    (cycle) => cycle.status === "failed" && !cycle.operationalFailure,
  );
  const activeCycles =
    deterministicFailureIndex === -1 ? cycles : cycles.slice(0, deterministicFailureIndex + 1);
  const isEligibleSuccess = (
    cycle: DexMeasuredExecutionHistoryCycle,
  ): cycle is DexMeasuredExecutionHistoryCycle & { profile: DexMeasuredExecutionProfile } =>
    cycle.status === "measured" &&
    !cycle.operationalFailure &&
    cycle.profile !== null &&
    cycle.profile.quoteGenerationId === cycle.generationId &&
    Number.isFinite(cycle.profile.quotedAt) &&
    cycle.profile.quotedAt <= input.nowSec + 60 &&
    input.nowSec - cycle.profile.quotedAt <=
      getDexMeasuredExecutionFreshnessMaxSec(cycle.profile.adapterProfileId);
  const successful = activeCycles.filter(isEligibleSuccess);
  if (successful.length === 0) return null;
  const capacityCurve = conservativeCurve(successful.map((cycle) => cycle.profile));
  if (capacityCurve === null) return null;

  const legacyEnabled =
    successful.length < requiredHashBoundSuccesses(successful[0]!.profile.adapterProfileId);
  const isCountedSuccess = (cycle: DexMeasuredExecutionHistoryCycle): boolean => {
    if (isEligibleSuccess(cycle)) return true;
    const legacy = cycle.legacyProfile;
    return legacyEnabled &&
      cycle.status === "measured" && !cycle.operationalFailure &&
      cycle.profile === null && legacy !== undefined &&
      legacy.quoteGenerationId === cycle.generationId &&
      legacy.quotedAt < MEASURED_LEGACY_TRANSITION_CUTOFF_SEC &&
      legacy.quotedAt <= input.nowSec + 60 &&
      input.nowSec - legacy.quotedAt <= getDexMeasuredExecutionFreshnessMaxSec(legacy.adapterProfileId);
  };
  let successfulObservationCount = 0;
  let consecutiveSuccessCount = 0;
  let consecutive = true;
  for (const cycle of activeCycles) {
    if (!isCountedSuccess(cycle)) {
      consecutive = false;
      continue;
    }
    successfulObservationCount += 1;
    if (consecutive) consecutiveSuccessCount += 1;
  }
  const latestOperationalFailureAt =
    activeCycles.find((cycle) => cycle.status === "failed" && cycle.operationalFailure)?.publishedAt ?? null;

  const result = DexMeasuredExecutionObservationHistorySchema.safeParse({
    completeProducerCycleCount: activeCycles.length,
    successfulObservationCount,
    consecutiveSuccessCount,
    observationWindowStartedAt: Math.min(...activeCycles.map((cycle) => cycle.publishedAt)),
    observationWindowEndedAt: Math.max(...activeCycles.map((cycle) => cycle.publishedAt)),
    latestOperationalFailureAt,
    conservativeStatistic: "pointwise-minimum",
    conservativeCapacityCurve: capacityCurve,
  });
  return result.success ? result.data : null;
}
