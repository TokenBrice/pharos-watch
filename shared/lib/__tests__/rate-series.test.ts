import { describe, expect, it } from "vitest";
import {
  bucketTimestampToUtcDay,
  enumerateDates,
  interpolateRateAtTimestamp,
  mergeDateRates,
} from "../rate-series";

describe("interpolateRateAtTimestamp", () => {
  it("returns null for an empty series", () => {
    expect(interpolateRateAtTimestamp([], 123)).toBeNull();
  });

  it("clamps to the nearest boundary outside the series range", () => {
    const series = [
      { timestamp: 100, rate: 1 },
      { timestamp: 200, rate: 2 },
    ];
    expect(interpolateRateAtTimestamp(series, 50)).toBe(1);
    expect(interpolateRateAtTimestamp(series, 250)).toBe(2);
  });

  it("linearly interpolates between surrounding points", () => {
    const series = [
      { timestamp: 100, rate: 1 },
      { timestamp: 200, rate: 3 },
    ];
    expect(interpolateRateAtTimestamp(series, 150)).toBe(2);
  });
});

describe("enumerateDates", () => {
  it("returns all UTC dates in the inclusive range", () => {
    expect(enumerateDates("2026-01-01", "2026-01-03")).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });
});

describe("mergeDateRates", () => {
  it("merges rates into an existing date bucket", () => {
    const target = {
      "2026-01-01": { eur: 0.91 },
    };

    mergeDateRates(target, "2026-01-01", { gbp: 0.79 });

    expect(target).toEqual({
      "2026-01-01": { eur: 0.91, gbp: 0.79 },
    });
  });
});

describe("bucketTimestampToUtcDay", () => {
  it("rounds down to the UTC day start", () => {
    expect(bucketTimestampToUtcDay(86_401)).toBe(86_400);
  });
});
