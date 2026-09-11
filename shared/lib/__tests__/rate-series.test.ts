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

  it("selects exact interior points and the later interpolation interval", () => {
    const series = [
      { timestamp: 100, rate: 1 },
      { timestamp: 160, rate: 7 },
      { timestamp: 300, rate: 3 },
      { timestamp: 500, rate: 11 },
    ];
    expect(interpolateRateAtTimestamp(series, 160)).toBe(7);
    expect(interpolateRateAtTimestamp(series, 350)).toBe(5);
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

    mergeDateRates(target, "2026-01-01", { eur: 0.93, gbp: 0.79 });

    expect(target).toEqual({
      "2026-01-01": { eur: 0.93, gbp: 0.79 },
    });
  });

  it("inserts a first bucket and treats null rates as a no-op", () => {
    const target = {};
    mergeDateRates(target, "2026-01-01", null);
    expect(target).toEqual({});
    mergeDateRates(target, "2026-01-01", { eur: 0.91 });
    mergeDateRates(target, "2026-01-01", null);
    expect(target).toEqual({ "2026-01-01": { eur: 0.91 } });
  });
});

describe("bucketTimestampToUtcDay", () => {
  it("rounds down to the UTC day start", () => {
    expect(bucketTimestampToUtcDay(86_401)).toBe(86_400);
  });
});
