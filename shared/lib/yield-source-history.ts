export const ZEPHYR_YIELD_HISTORY_POLICY = {
  stablecoinId: "zys-zephyr-protocol",
  symbol: "ZYS",
  sourceKey: "protocol-api:zys-zephyr-protocol",
  observationBucketSec: 3600,
  recordedAtClock: "source-observation",
} as const;

export const MORPHO_NET_YIELD_SOURCE_PREFIX = "protocol-api:morpho-net:";

export function isMorphoNetYieldSourceKey(sourceKey: string | null | undefined): boolean {
  return sourceKey?.replace(/^linked-variant:[^:]+:/, "").startsWith(MORPHO_NET_YIELD_SOURCE_PREFIX) === true;
}

export function usesYieldObservationHistoryClock(sourceKey: string): boolean {
  return sourceKey === ZEPHYR_YIELD_HISTORY_POLICY.sourceKey;
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
