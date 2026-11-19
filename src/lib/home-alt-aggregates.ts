import { getPegDeviationLevel, type PegDeviationLevel } from "@shared/lib/classification";
import { readUnroundedPublishedDeviation } from "@/lib/current-peg";

export type PegDeviationBuckets = Record<PegDeviationLevel, number>;

// Bucket coins by absolute peg deviation in basis points, using the shared peg-deviation
// levels (see PEG_DEVIATION_LEVEL_MIN_BPS). Coins without a deviation reading are skipped
// (not bucketed as "healthy"), and a reading held behind a closed reference market is not
// a reading at all.
export function bucketByDeviationBps(
  coins: ReadonlyArray<NonNullable<Parameters<typeof readUnroundedPublishedDeviation>[1]> & { pegCurrency?: string | null }>,
): PegDeviationBuckets {
  const buckets: PegDeviationBuckets = { healthy: 0, mild: 0, moderate: 0, severe: 0 };
  for (const coin of coins) {
    const { deviationBps } = readUnroundedPublishedDeviation(coin.pegCurrency, coin);
    if (deviationBps != null) buckets[getPegDeviationLevel(Math.abs(deviationBps))] += 1;
  }
  return buckets;
}
