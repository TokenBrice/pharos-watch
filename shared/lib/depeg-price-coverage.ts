import type { DepegPriceCoverage } from "../types/market";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "./depeg-closure";

/** Never bridge a missed run, an explicit gap, or unrecorded legacy history. */
export function advanceDepegPriceCoverage(
  previous: DepegPriceCoverage | null | undefined,
  now: number,
  observation: NonNullable<DepegPriceCoverage["lastObservationKind"]>,
): DepegPriceCoverage {
  const lastTrustedObservationAt = previous?.lastTrustedObservationAt ?? null;
  // Repeated/older runs cannot rewind trusted clocks or overwrite a newer observation.
  if (lastTrustedObservationAt != null && now <= lastTrustedObservationAt) return previous!;
  if (observation === "blind") {
    if (previous?.lastObservationKind === "blind" && previous.gapStartedAt != null) return previous;
    return {
      intervals: previous?.intervals ?? [],
      atParIntervals: previous?.atParIntervals ?? [],
      lastTrustedObservationAt,
      gapStartedAt: previous?.gapStartedAt ?? now,
      lastObservationKind: observation,
    };
  }
  const atPar = observation === "trusted-at-par";
  const previousKind = previous?.lastObservationKind ??
    (previous?.gapStartedAt == null ? "trusted-off-peg" : "blind");
  const intervals = (atPar ? previous?.atParIntervals : previous?.intervals)?.map(
    ([start, end]) => [start, end] as [number, number],
  ) ?? [];
  const last = intervals[intervals.length - 1];
  if (last && previousKind === observation && lastTrustedObservationAt != null &&
      last[1] === lastTrustedObservationAt &&
      (atPar || previous?.gapStartedAt == null) &&
      now - lastTrustedObservationAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC) {
    last[1] = now;
  } else {
    intervals.push([now, now]);
  }
  return {
    intervals: atPar ? previous?.intervals ?? [] : intervals,
    atParIntervals: atPar ? intervals : previous?.atParIntervals ?? [],
    lastTrustedObservationAt: now,
    gapStartedAt: atPar ? previous?.gapStartedAt ?? now : null,
    lastObservationKind: observation,
  };
}
