// Client-side aggregates for /home-alt/. Computes hero KPI and mini-card derivations
// directly from existing endpoints — no new worker work.

import { getCirculatingRaw, getPrevDayRaw } from "@shared/lib/supply";
import { CLIENT_ACTIVE_IDS } from "@shared/lib/stablecoins/client-registry";
import type { StablecoinData } from "@shared/types";

export interface VisibleMcap {
  totalUsd: number;
  prevDayUsd: number;
  change24hPct: number | null;
  nonUsdUsd: number;
  nonUsdShare: number | null;
}

// Total stablecoin market cap restricted to the publicly tracked active set.
// Implicitly excludes the 2 PSI shadow assets (ust-terra, iron-iron-finance) by
// only summing IDs in CLIENT_ACTIVE_IDS. Also computes the non-USD slice
// (anything whose pegType is not "peggedUSD") for the secondary headline.
export function selectVisibleMcap(coins: readonly StablecoinData[] | undefined): VisibleMcap {
  if (!coins || coins.length === 0) {
    return { totalUsd: 0, prevDayUsd: 0, change24hPct: null, nonUsdUsd: 0, nonUsdShare: null };
  }
  let totalUsd = 0;
  let prevDayUsd = 0;
  let nonUsdUsd = 0;
  for (const coin of coins) {
    if (!CLIENT_ACTIVE_IDS.has(coin.id)) continue;
    const mcap = getCirculatingRaw(coin);
    totalUsd += mcap;
    prevDayUsd += getPrevDayRaw(coin);
    if (coin.pegType && coin.pegType !== "peggedUSD") {
      nonUsdUsd += mcap;
    }
  }
  const change24hPct = prevDayUsd > 0 ? (totalUsd - prevDayUsd) / prevDayUsd : null;
  const nonUsdShare = totalUsd > 0 ? nonUsdUsd / totalUsd : null;
  return { totalUsd, prevDayUsd, change24hPct, nonUsdUsd, nonUsdShare };
}

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
