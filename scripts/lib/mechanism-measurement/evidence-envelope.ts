interface MeasuredMetricsInput {
  collateralizationRatio: number;
  liquidationCapacityRatio: number;
}

interface NotApplicableMetricsInput {
  collateralizationRationale: string;
  liquidationCapacityRationale: string;
}

export function buildMeasuredMetrics({
  collateralizationRatio,
  liquidationCapacityRatio,
}: MeasuredMetricsInput) {
  return {
    collateralizationRatio,
    liquidationCapacityRatio,
    applicability: {
      collateralizationRatio: { state: "measured" as const },
      liquidationCapacityRatio: { state: "measured" as const },
    },
  };
}

export function buildNotApplicableMetrics({
  collateralizationRationale,
  liquidationCapacityRationale,
}: NotApplicableMetricsInput) {
  return {
    collateralizationRatio: null,
    liquidationCapacityRatio: null,
    applicability: {
      collateralizationRatio: { state: "not-applicable" as const, rationale: collateralizationRationale },
      liquidationCapacityRatio: { state: "not-applicable" as const, rationale: liquidationCapacityRationale },
    },
  };
}

export function buildMeasurementCompleteness(blockers: string[] = []) {
  return { complete: blockers.length === 0, blockers };
}
