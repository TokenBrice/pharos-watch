import { isReserveDriftThresholdExceeded } from "@shared/lib/status-thresholds";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-card-policy";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { loadFreshIndependentLiveReserveMap } from "./live-reserves/store";

const MIN_COMPARABLE_COLLATERAL_DRIFT_SLICES = 2;

export interface CollateralDriftEntry {
  id: string;
  liveScore: number;
  curatedScore: number;
  delta: number;
}

export interface CollateralDriftResult {
  driftCoins: CollateralDriftEntry[];
  fallbackCoins: string[];
}

export function summarizeCollateralDriftFromLiveReserveMap(
  liveReserveMap: ReadonlyMap<string, ReserveSlice[]>,
  stablecoins: readonly StablecoinMeta[] = ACTIVE_STABLECOINS,
): CollateralDriftResult {
  const driftCoins: CollateralDriftEntry[] = [];
  const fallbackCoins: string[] = [];

  for (const meta of stablecoins) {
    if (!meta.liveReservesConfig) continue;

    const liveSlices = liveReserveMap.get(meta.id);
    if (!liveSlices) {
      fallbackCoins.push(meta.id);
      continue;
    }
    if (liveSlices.length < MIN_COMPARABLE_COLLATERAL_DRIFT_SLICES) {
      continue;
    }

    if (meta.reserves && meta.reserves.length > 0) {
      const liveScore = computeCollateralQualityFromReserves(liveSlices);
      const curatedScore = computeCollateralQualityFromReserves(meta.reserves);
      const delta = Math.abs(liveScore - curatedScore);
      if (isReserveDriftThresholdExceeded(delta)) {
        driftCoins.push({ id: meta.id, liveScore, curatedScore, delta });
      }
    }
  }

  return { driftCoins, fallbackCoins };
}

/**
 * Load fresh live reserves and compare comparable multi-slice live mixes with curated reserve metadata.
 * Returns coins with score drift above the shared reserve-drift threshold and coins that fell back to curated.
 */
export async function checkCollateralDrift(db: D1Database): Promise<CollateralDriftResult> {
  const liveReserveMap = await loadFreshIndependentLiveReserveMap(db);
  return summarizeCollateralDriftFromLiveReserveMap(liveReserveMap);
}
