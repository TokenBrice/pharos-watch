import type { DepegPendingIncident, PegSummaryCoin } from "@shared/types/peg";
import type { StressSignalEntry } from "@shared/types/stress";
import { THREAT_BAND_ORDER, isThreatBand, type OpenIncidentEvidence } from "@shared/lib/classification";
import { isCurrentDeviationHeld, resolvePriceObservedAtSec } from "@/lib/current-peg";

export interface DepegTrackerRow {
  coin: PegSummaryCoin;
  dews: StressSignalEntry | null;
  pendingIncident?: DepegPendingIncident | null;
  /** Latest trusted observation of this coin's open confirmed incident. */
  openIncidentEvidence?: OpenIncidentEvidence | null;
  /** Circulating USD; null is unavailable, undefined is not read yet. */
  marketCapUsd?: number | null;
}

/** The row's current deviation was read against a closed reference market, so it is held. */
export function isDeviationHeld(row: DepegTrackerRow): boolean {
  return isCurrentDeviationHeld(row.coin.pegCurrency, resolvePriceObservedAtSec(row.coin), row.coin.currentDeviationBps);
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
  // A held deviation is unavailable, not a small one.
  if (!isDeviationHeld(row)) score += Math.abs(row.coin.currentDeviationBps ?? 0);
  return score;
}
