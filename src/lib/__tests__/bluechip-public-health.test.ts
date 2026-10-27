import { describe, expect, it } from "vitest";
import { bluechipObservationText } from "@/lib/bluechip";
import { BLUECHIP_OBSERVATION_MAX_AGE_SEC, isBluechipRatingCurrent } from "@shared/lib/bluechip-freshness";
import { makeUnreportedBluechipRating } from "@shared/test-utils/bluechip.test-support";

const NOW = 1_790_000_000;

describe("bluechip public provenance", () => {
  it("shows the original observation date without changing 48h Selector admission", () => {
    const expired = { ...makeUnreportedBluechipRating(), lastObservedAt: NOW - BLUECHIP_OBSERVATION_MAX_AGE_SEC - 1,
      observationState: "current" as const, observationReason: null };
    expect(isBluechipRatingCurrent(expired, NOW)).toBe(false);
    expect(bluechipObservationText(expired.lastObservedAt, NOW)).toBe("Observed 2026-09-19");

    const atBoundary = { ...expired, lastObservedAt: NOW - BLUECHIP_OBSERVATION_MAX_AGE_SEC };
    expect(isBluechipRatingCurrent(atBoundary, NOW)).toBe(true);
  });

  it.each(["http-404", "empty-data", "no-grade"] as const)("keeps immediate %s exclusion independent of the date", (reason) => {
    const rating = { ...makeUnreportedBluechipRating(), lastObservedAt: NOW, observationState: "retained" as const,
      observationReason: reason };
    expect(isBluechipRatingCurrent(rating, NOW)).toBe(false);
    expect(bluechipObservationText(rating.lastObservedAt, NOW)).toBe("Observed 2026-09-21");
  });

  it.each([null, undefined, Number.NaN, NOW + 1])("withholds a date for clock %s", (clock) => {
    expect(bluechipObservationText(clock, NOW)).toBe("Observation date unavailable");
  });
});
