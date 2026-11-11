export const ZEPHYR_YIELD_HISTORY_POLICY = {
  stablecoinId: "zys-zephyr-protocol",
  symbol: "ZYS",
  sourceKey: "protocol-api:zys-zephyr-protocol",
  observationBucketSec: 3600,
  recordedAtClock: "source-observation",
} as const;

const HISTORY_POLICIES = new Map<string, { recordedAtClock: "source-observation" }>([
  [ZEPHYR_YIELD_HISTORY_POLICY.sourceKey, ZEPHYR_YIELD_HISTORY_POLICY],
]);

export function usesYieldObservationHistoryClock(sourceKey: string): boolean {
  return HISTORY_POLICIES.get(sourceKey)?.recordedAtClock === "source-observation";
}

export function getYieldHistorySampleAt(
  sourceKey: string,
  sourceObservedAt: number | null | undefined,
  fallbackRecordedAt: number,
): number {
  return usesYieldObservationHistoryClock(sourceKey)
    ? sourceObservedAt ?? fallbackRecordedAt
    : fallbackRecordedAt;
}
