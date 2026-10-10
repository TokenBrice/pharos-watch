import { isReserveDriftThresholdExceeded } from "@shared/lib/status-thresholds";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
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
  observedIds: string[];
}

type CollateralDriftCoin = Pick<StablecoinMeta, "id" | "liveReservesConfig">
  & { reserves?: readonly Pick<ReserveSlice, "pct" | "risk">[] };

export function summarizeCollateralDriftFromLiveReserveMap(
  liveReserveMap: ReadonlyMap<string, ReserveSlice[]>,
  stablecoins: readonly CollateralDriftCoin[] = WORKER_ACTIVE_STABLECOINS,
): CollateralDriftResult {
  const driftCoins: CollateralDriftEntry[] = [];
  const fallbackCoins: string[] = [];
  const observedIds: string[] = [];

  for (const meta of stablecoins) {
    const config = meta.liveReservesConfig;
    if (!config || config.suspended || !meta.reserves?.length) continue;
    const adapter = getLiveReserveAdapterDefinition(config.adapter);
    if (adapter?.sourceModel !== "dynamic-mix" || adapter.evidenceClass !== "independent") continue;

    const liveSlices = liveReserveMap.get(meta.id);
    if (!liveSlices || liveSlices.length < MIN_COMPARABLE_COLLATERAL_DRIFT_SLICES) {
      fallbackCoins.push(meta.id);
      continue;
    }
    observedIds.push(meta.id);

    if (meta.reserves && meta.reserves.length > 0) {
      const liveScore = computeCollateralQualityFromReserves(liveSlices);
      const curatedScore = computeCollateralQualityFromReserves(meta.reserves);
      const delta = Math.abs(liveScore - curatedScore);
      if (isReserveDriftThresholdExceeded(delta)) {
        driftCoins.push({ id: meta.id, liveScore, curatedScore, delta });
      }
    }
  }

  return { driftCoins, fallbackCoins, observedIds };
}

/**
 * Load fresh live reserves and compare comparable multi-slice live mixes with curated reserve metadata.
 * Returns coins with score drift above the shared reserve-drift threshold and coins that fell back to curated.
 */
export async function checkCollateralDrift(db: D1Database): Promise<CollateralDriftResult> {
  const liveReserveMap = await loadFreshIndependentLiveReserveMap(db);
  return summarizeCollateralDriftFromLiveReserveMap(liveReserveMap);
}
