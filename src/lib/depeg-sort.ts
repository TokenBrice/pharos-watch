import type { PegSummaryCoin, StressSignalEntry } from "@shared/types";
import { THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";

export interface DepegTrackerRow {
  coin: PegSummaryCoin;
  dews: StressSignalEntry | null;
}

/** Composite sort for default "needs attention" ordering */
export function attentionScore(row: DepegTrackerRow): number {
  // Active depeg = huge boost (1_000_000)
  let score = row.coin.activeDepeg ? 1_000_000 : 0;
  // DEWS band: DANGER=40000, WARNING=30000, ALERT=20000, WATCH=10000, CALM=0
  const band = row.dews?.band;
  const bandOrder = band && isThreatBand(band) ? THREAT_BAND_ORDER[band] : THREAT_BAND_ORDER.CALM;
  score += bandOrder * 10_000;
  // Absolute deviation for fine-grained ordering
  score += Math.abs(row.coin.currentDeviationBps ?? 0);
  return score;
}
