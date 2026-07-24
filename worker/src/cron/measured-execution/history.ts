import {
  DexMeasuredExecutionObservationHistorySchema,
  type DexMeasuredExecutionObservationHistory,
  type DexMeasuredExecutionProfile,
} from "@shared/types/measured-execution";

export interface DexMeasuredExecutionHistoryCycle {
  generationId: string;
  publishedAt: number;
  status: "measured" | "failed";
  operationalFailure: boolean;
  profile: DexMeasuredExecutionProfile | null;
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
    return {
      requestedNotionalUsd: point.requestedNotionalUsd,
      maxCostBps: point.maxCostBps,
      executableUsd,
      completionRatio: executableUsd / point.requestedNotionalUsd,
      ...(executionCostBps == null ? {} : { executionCostBps }),
    };
  });
  return result.some((point) => point === null)
    ? null
    : (result as DexMeasuredExecutionObservationHistory["conservativeCapacityCurve"]);
}

/**
 * Summarizes complete published producer cycles inside the score freshness
 * window. Only verified measured profiles influence the conservative curve.
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
  const successful = activeCycles.filter(
    (cycle): cycle is DexMeasuredExecutionHistoryCycle & { profile: DexMeasuredExecutionProfile } =>
      cycle.status === "measured" &&
      !cycle.operationalFailure &&
      cycle.profile !== null &&
      cycle.profile.quoteGenerationId === cycle.generationId,
  );
  if (successful.length === 0) return null;
  const capacityCurve = conservativeCurve(successful.map((cycle) => cycle.profile));
  if (capacityCurve === null) return null;

  let consecutiveSuccessCount = 0;
  for (const cycle of activeCycles) {
    if (cycle.status !== "measured" || cycle.profile === null) break;
    consecutiveSuccessCount += 1;
  }
  const latestOperationalFailureAt =
    activeCycles.find((cycle) => cycle.status === "failed" && cycle.operationalFailure)?.publishedAt ?? null;

  const result = DexMeasuredExecutionObservationHistorySchema.safeParse({
    completeProducerCycleCount: activeCycles.length,
    successfulObservationCount: successful.length,
    consecutiveSuccessCount,
    observationWindowStartedAt: Math.min(...activeCycles.map((cycle) => cycle.publishedAt)),
    observationWindowEndedAt: Math.max(...activeCycles.map((cycle) => cycle.publishedAt)),
    latestOperationalFailureAt,
    conservativeStatistic: "pointwise-minimum",
    conservativeCapacityCurve: capacityCurve,
  });
  return result.success ? result.data : null;
}
