import {
  toDexMeasuredExecutionPublicProfile,
  type DexMeasuredExecutionProfile,
} from "@shared/types/measured-execution";

export function toMaturePublicProfile(profile: DexMeasuredExecutionProfile) {
  return toDexMeasuredExecutionPublicProfile(profile, {
    observationHistory: {
      completeProducerCycleCount: 2,
      successfulObservationCount: 2,
      consecutiveSuccessCount: 2,
      observationWindowStartedAt: profile.quotedAt - 60,
      observationWindowEndedAt: profile.quotedAt,
      latestOperationalFailureAt: null,
      conservativeStatistic: "pointwise-minimum",
      conservativeCapacityCurve: profile.capacityCurve,
    },
  });
}
