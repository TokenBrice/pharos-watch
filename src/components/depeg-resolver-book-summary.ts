import {
  getLiveCurrentDeviationBps,
  getPeakDeviationBps,
  getResolution,
  type DdrDisplayRow,
} from "@/components/depeg-resolver-row-card-model";
import { DDR_RESOLUTION_TIER_VALUES, type DdrResolutionTier } from "@shared/types/depeg-resolver";

/**
 * Below this the "past peak" test is snapshot jitter, not a real move. A bare
 * 2% margin is only 2bps at a 100bps event threshold.
 */
const PAST_PEAK_FLOOR_BPS = 25;

/**
 * Has the live gap to peg opened up beyond this event's benchmark peak?
 *
 * The current side must be live: `getCurrentDeviationBps()` deliberately returns
 * the lock-time value for frozen predictions, which would rank incidents by
 * where they were when their forecast sealed rather than where they are now.
 * The baseline is the event's peak deviation, so this says "past its worst" —
 * not "worse than at lock", which this data cannot support.
 */
export function isPastEventPeak(row: DdrDisplayRow): boolean {
  const live = getLiveCurrentDeviationBps(row);
  if (live == null) return false;
  const peak = Math.abs(getPeakDeviationBps(row));
  if (peak <= 0) return false;
  return Math.abs(live) > peak + Math.max(PAST_PEAK_FLOOR_BPS, peak * 0.02);
}

/**
 * Worklist order: incidents now past their own worst first, then the widest live
 * gap to peg, then a stable identity so equally urgent rows cannot reshuffle
 * between refreshes on API row order. DDR rows are not control-board rows, so
 * the board's attention comparator does not apply.
 */
export function compareResolverUrgency(a: DdrDisplayRow, b: DdrDisplayRow): number {
  const pastPeakDelta = Number(isPastEventPeak(b)) - Number(isPastEventPeak(a));
  if (pastPeakDelta !== 0) return pastPeakDelta;
  const deviationDelta =
    Math.abs(getLiveCurrentDeviationBps(b) ?? 0) - Math.abs(getLiveCurrentDeviationBps(a) ?? 0);
  if (deviationDelta !== 0) return deviationDelta;
  const idDelta = a.stablecoinId.localeCompare(b.stablecoinId);
  return idDelta !== 0 ? idDelta : String(a.eventId).localeCompare(String(b.eventId));
}

export interface ResolverBookSummary {
  total: number;
  tierCounts: Record<DdrResolutionTier, number>;
  pastPeakCount: number;
}

/**
 * One derivation of the whole resolver book, shared by the hero's recovery
 * posture and the resolver module's own header, so the two can never disagree.
 */
export function summarizeResolverBook(rows: readonly DdrDisplayRow[]): ResolverBookSummary {
  const tierCounts = {} as Record<DdrResolutionTier, number>;
  for (const tier of DDR_RESOLUTION_TIER_VALUES) tierCounts[tier] = 0;
  let pastPeakCount = 0;
  for (const row of rows) {
    tierCounts[getResolution(row).tier] += 1;
    if (isPastEventPeak(row)) pastPeakCount += 1;
  }
  return { total: rows.length, tierCounts, pastPeakCount };
}
