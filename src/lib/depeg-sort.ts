import type { PegSummaryCoin, StressSignalEntry } from "@/lib/types";

export interface DepegTrackerRow {
  coin: PegSummaryCoin;
  dews: StressSignalEntry | null;
}

/** DEWS threat bands ordered by severity for sorting */
export const BAND_ORDER: Record<string, number> = {
  CALM: 0,
  WATCH: 1,
  ALERT: 2,
  WARNING: 3,
  DANGER: 4,
};

/** Composite sort for default "needs attention" ordering */
export function attentionScore(row: DepegTrackerRow): number {
  // Active depeg = huge boost (1_000_000)
  let score = row.coin.activeDepeg ? 1_000_000 : 0;
  // DEWS band: DANGER=40000, WARNING=30000, ALERT=20000, WATCH=10000, CALM=0
  const band = row.dews?.band ?? "CALM";
  score += (BAND_ORDER[band] ?? 0) * 10_000;
  // Absolute deviation for fine-grained ordering
  score += Math.abs(row.coin.currentDeviationBps ?? 0);
  return score;
}
