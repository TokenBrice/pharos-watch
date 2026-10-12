import { getPegDeviationLevel, type PegDeviationLevel } from "@shared/lib/classification";

export type PegDeviationBuckets = Record<PegDeviationLevel, number>;

// Bucket coins by absolute peg deviation in basis points, using the shared peg-deviation
// levels (see PEG_DEVIATION_LEVEL_MIN_BPS). Coins without a deviation reading are skipped
// (not bucketed as "healthy").
export function bucketByDeviationBps(
  coins: ReadonlyArray<{ currentDeviationBps?: number | null }>,
): PegDeviationBuckets {
  const buckets: PegDeviationBuckets = { healthy: 0, mild: 0, moderate: 0, severe: 0 };
  for (const coin of coins) {
    const raw = coin.currentDeviationBps;
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    buckets[getPegDeviationLevel(Math.abs(raw))] += 1;
  }
  return buckets;
}
