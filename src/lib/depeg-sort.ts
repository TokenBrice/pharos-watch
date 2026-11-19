import type { DepegPendingIncident, PegSummaryCoin } from "@shared/types/peg";
import type { StressSignalEntry } from "@shared/types/stress";
import { THREAT_BAND_ORDER, isThreatBand, type OpenIncidentEvidence } from "@shared/lib/classification";
import { readPublishedDeviation } from "@/lib/current-peg";

export interface DepegTrackerRow {
  coin: PegSummaryCoin;
  dews: StressSignalEntry | null;
  pendingIncident?: DepegPendingIncident | null;
  /** Latest trusted observation of this coin's open confirmed incident. */
  openIncidentEvidence?: OpenIncidentEvidence | null;
  /** Circulating USD; null is unavailable, undefined is not read yet. */
  marketCapUsd?: number | null;
}

export function readTrackerDeviation(row: DepegTrackerRow) {
  return readPublishedDeviation(row.coin.pegCurrency, row.coin);
}

/** Composite sort for default "needs attention" ordering */
export function attentionScore(row: DepegTrackerRow): number {
  let score = row.coin.activeDepeg ? 1_000_000 : 0;
  // Pending confirmation should stay ahead of ordinary warning rows.
  if (row.pendingIncident) score += 500_000;
  // DEWS band: DANGER=40000, WARNING=30000, ALERT=20000, WATCH=10000, CALM=0
  const band = row.dews?.band;
  const bandOrder = band && isThreatBand(band) ? THREAT_BAND_ORDER[band] : THREAT_BAND_ORDER.CALM;
  score += bandOrder * 10_000;
  const { deviationBps } = readTrackerDeviation(row);
  if (deviationBps != null) score += Math.abs(deviationBps);
  return score;
}
