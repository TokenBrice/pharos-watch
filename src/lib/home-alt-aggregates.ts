import { getPegDeviationLevel, type PegDeviationLevel } from "@shared/lib/classification";
import { isCurrentDeviationHeld, resolvePriceObservedAtSec } from "@/lib/current-peg";

export type PegDeviationBuckets = Record<PegDeviationLevel, number>;

// Bucket coins by absolute peg deviation in basis points, using the shared peg-deviation
// levels (see PEG_DEVIATION_LEVEL_MIN_BPS). Coins without a deviation reading are skipped
// (not bucketed as "healthy"), and a reading held behind a closed reference market is not
// a reading at all.
export function bucketByDeviationBps(
  coins: ReadonlyArray<{
    currentDeviationBps?: number | null;
    pegCurrency?: string | null;
    priceObservedAt?: number | null;
    priceUpdatedAt?: number | null;
  }>,
): PegDeviationBuckets {
  const buckets: PegDeviationBuckets = { healthy: 0, mild: 0, moderate: 0, severe: 0 };
  for (const coin of coins) {
    const raw = coin.currentDeviationBps;
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    if (isCurrentDeviationHeld(coin.pegCurrency, resolvePriceObservedAtSec(coin), raw)) continue;
    buckets[getPegDeviationLevel(Math.abs(raw))] += 1;
  }
  return buckets;
}
