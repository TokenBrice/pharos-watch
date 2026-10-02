import type { DepegPriceCoverage } from "../types/market";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "./depeg-closure";

/** Never bridge a missed run, an explicit gap, or unrecorded legacy history. */
export function advanceDepegPriceCoverage(
  previous: DepegPriceCoverage | null | undefined,
  now: number,
  trustedOffPeg: boolean,
): DepegPriceCoverage {
  const intervals = previous?.intervals.map(([start, end]) => [start, end] as [number, number]) ?? [];
  const lastTrustedObservationAt = previous?.lastTrustedObservationAt ?? null;
  if (!trustedOffPeg) {
    return {
      intervals,
      lastTrustedObservationAt,
      gapStartedAt: previous?.gapStartedAt ?? now,
    };
  }
  // Repeated/older runs cannot rewind coverage clocks or extend an interval twice.
  if (lastTrustedObservationAt != null && now <= lastTrustedObservationAt) return previous!;
  const last = intervals[intervals.length - 1];
  if (last && previous?.gapStartedAt == null && lastTrustedObservationAt != null &&
      now - lastTrustedObservationAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC) {
    last[1] = now;
  } else {
    intervals.push([now, now]);
  }
  return { intervals, lastTrustedObservationAt: now, gapStartedAt: null };
}
