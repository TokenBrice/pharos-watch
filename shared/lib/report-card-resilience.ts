import type { ReserveSlice } from "../types";
import { roundScore } from "./math";
import { RESERVE_QUALITY_SCORE } from "./report-card-policy";

export { inferResilienceDefaults } from "./report-card-policy";

export function computeCollateralQualityFromReserves(reserves: ReserveSlice[]): number {
  const totalPct = reserves.reduce((sum, reserve) => sum + reserve.pct, 0);
  if (totalPct === 0) return 0;
  const weighted = reserves.reduce((sum, reserve) => sum + reserve.pct * (RESERVE_QUALITY_SCORE[reserve.risk] ?? 0), 0);
  return roundScore(weighted / totalPct);
}
