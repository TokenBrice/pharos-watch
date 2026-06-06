export interface PegDeviationBuckets {
  tight: number;     // <= 25 bps
  loose: number;     // 25 < x <= 100 bps
  stressed: number;  // 100 < x <= 250 bps
  severe: number;    // > 250 bps
}

// Bucket coins by absolute peg deviation in basis points. Coins without a deviation
// reading are skipped (not bucketed as "tight").
export function bucketByDeviationBps(
  coins: ReadonlyArray<{ currentDeviationBps?: number | null }>,
): PegDeviationBuckets {
  const buckets: PegDeviationBuckets = { tight: 0, loose: 0, stressed: 0, severe: 0 };
  for (const coin of coins) {
    const raw = coin.currentDeviationBps;
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const abs = Math.abs(raw);
    if (abs <= 25) buckets.tight += 1;
    else if (abs <= 100) buckets.loose += 1;
    else if (abs <= 250) buckets.stressed += 1;
    else buckets.severe += 1;
  }
  return buckets;
}
