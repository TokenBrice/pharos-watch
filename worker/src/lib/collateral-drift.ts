import { isReserveDriftThresholdExceeded } from "@shared/lib/status-thresholds";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { computeCollateralQualityFromReserves } from "@shared/lib/report-cards";
import { loadFreshIndependentLiveReserveMap } from "./live-reserves-store";

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

/**
 * Load fresh live reserves and compare with curated reserve metadata.
 * Returns coins with score drift above the shared reserve-drift threshold and coins that fell back to curated.
 */
export async function checkCollateralDrift(db: D1Database): Promise<CollateralDriftResult> {
  const liveReserveMap = await loadFreshIndependentLiveReserveMap(db);
  const driftCoins: CollateralDriftEntry[] = [];
  const fallbackCoins: string[] = [];

  for (const meta of ACTIVE_STABLECOINS) {
    if (!meta.liveReservesConfig) continue;

    const liveSlices = liveReserveMap.get(meta.id);
    if (!liveSlices) {
      fallbackCoins.push(meta.id);
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
