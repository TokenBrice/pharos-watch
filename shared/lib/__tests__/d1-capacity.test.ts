import { describe, expect, it } from "vitest";
import {
  assessD1Capacity,
  assessD1QuotaUsage,
  D1_PAID_MONTHLY_INCLUDED_ALLOWANCE,
  D1_QUOTA_PROJECTION_DAYS,
  getD1CapacityImpactStatus,
} from "../d1-capacity";

const NOW = 1_783_661_028;
const GB = 1_000_000_000;

describe("assessD1Capacity", () => {
  it.each([
    [5.99 * GB, "normal", null, 60],
    [6 * GB, "watch", 60, 75],
    [7.5 * GB, "warning", 75, 90],
    [9 * GB, "critical", 90, 100],
    [10 * GB, "critical", 90, null],
  ] as const)("classifies the 60/75/90 thresholds for %s bytes", (size, state, crossed, next) => {
    const result = assessD1Capacity({ observedAt: NOW, databaseSizeBytes: size });
    expect(result.thresholdState).toBe(state);
    expect(result.crossedThresholdPercent).toBe(crossed);
    expect(result.nextThresholdPercent).toBe(next);
  });

  it("forecasts from the shortest valid regression window", () => {
    const current = { observedAt: NOW, databaseSizeBytes: 7 * GB };
    const result = assessD1Capacity(current, [
      { observedAt: NOW - 29 * 86_400, databaseSizeBytes: 4.1 * GB },
      { observedAt: NOW - 15 * 86_400, databaseSizeBytes: 5.5 * GB },
      current,
    ]);

    expect(result.forecastBasis).toBe("linear-window");
    expect(result.conservativeWindow).toBe("30d");
    expect(result.growthBytesPerDay).toBe(100_000_000);
    expect(result.daysUntilExhaustion).toBe(30);
    expect(result.nextThresholdPercent).toBe(75);
    expect(result.nextThresholdAt).toBe(NOW + 5 * 86_400);
  });

  it("does not invent an exhaustion date from insufficient or shrinking history", () => {
    const insufficient = assessD1Capacity(
      { observedAt: NOW, databaseSizeBytes: 4.1 * GB },
      [{ observedAt: NOW - 3600, databaseSizeBytes: 4 * GB }],
    );
    expect(insufficient.forecastBasis).toBe("insufficient-history");
    expect(insufficient.exhaustionAt).toBeNull();

    const shrinking = assessD1Capacity(
      { observedAt: NOW, databaseSizeBytes: 4 * GB },
      [
        { observedAt: NOW - 3 * 86_400, databaseSizeBytes: 4.3 * GB },
        { observedAt: NOW - 2 * 86_400, databaseSizeBytes: 4.2 * GB },
        { observedAt: NOW - 86_400, databaseSizeBytes: 4.1 * GB },
      ],
    );
    expect(shrinking.forecastBasis).toBe("non-growing");
    expect(shrinking.growthBytesPerDay).toBeNull();
    expect(shrinking.exhaustionAt).toBeNull();
  });

  it("maps watch, warning, and critical thresholds onto health severity", () => {
    expect(getD1CapacityImpactStatus("normal")).toBe("healthy");
    expect(getD1CapacityImpactStatus("watch")).toBe("healthy");
    expect(getD1CapacityImpactStatus("warning")).toBe("degraded");
    expect(getD1CapacityImpactStatus("critical")).toBe("stale");
  });

  it("keeps hourly min/max capacity observations so intra-day swings stay visible", () => {
    const result = assessD1Capacity(
      { observedAt: NOW, databaseSizeBytes: 4_200_000_000 },
      [
        { observedAt: NOW - 30 * 3_600, databaseSizeBytes: 3_800_000_000 },
        { observedAt: NOW - 20 * 3_600, databaseSizeBytes: 4_700_000_000 },
        { observedAt: NOW - 8 * 3_600, databaseSizeBytes: 3_600_000_000 },
        { observedAt: NOW - 3_600, databaseSizeBytes: 4_100_000_000 },
      ],
    );

    expect(result.hourlyMinMax24h).toEqual({
      windowSeconds: 86_400,
      sampleCount: 4,
      minDatabaseSizeBytes: 3_600_000_000,
      maxDatabaseSizeBytes: 4_700_000_000,
      swingBytes: 1_100_000_000,
    });
  });
});

describe("assessD1QuotaUsage", () => {
  const observedFor = (allowance: number, percent: number) => (allowance * percent) / 100 / D1_QUOTA_PROJECTION_DAYS;

  it.each([
    [79.99, "normal", null, 80],
    [80, "watch", 80, 95],
    [94.99, "watch", 80, 95],
    [95, "warning", 95, null],
    [100, "warning", 95, null],
    [140, "warning", 95, null],
  ] as const)("classifies the 80/95 floors for rows read at %s%%", (percent, state, crossed, next) => {
    const result = assessD1QuotaUsage({
      rowsRead24h: observedFor(D1_PAID_MONTHLY_INCLUDED_ALLOWANCE.rowsRead, percent),
      rowsWritten24h: 0,
    });

    expect(result.rowsRead.includedMonthlyAllowance).toBe(25_000_000_000);
    expect(result.rowsRead.utilizationPercent).toBeCloseTo(percent, 2);
    expect(result.rowsRead.thresholdState).toBe(state);
    expect(result.rowsRead.crossedThresholdPercent).toBe(crossed);
    expect(result.rowsRead.nextThresholdPercent).toBe(next);
  });

  it.each([
    [79.99, "normal", null, 80],
    [80, "watch", 80, 95],
    [94.99, "watch", 80, 95],
    [95, "warning", 95, null],
    [100, "warning", 95, null],
  ] as const)("classifies the 80/95 floors for rows written at %s%%", (percent, state, crossed, next) => {
    const result = assessD1QuotaUsage({
      rowsRead24h: 0,
      rowsWritten24h: observedFor(D1_PAID_MONTHLY_INCLUDED_ALLOWANCE.rowsWritten, percent),
    });

    expect(result.rowsWritten.includedMonthlyAllowance).toBe(50_000_000);
    expect(result.rowsWritten.utilizationPercent).toBeCloseTo(percent, 2);
    expect(result.rowsWritten.thresholdState).toBe(state);
    expect(result.rowsWritten.crossedThresholdPercent).toBe(crossed);
    expect(result.rowsWritten.nextThresholdPercent).toBe(next);
  });

  it("projects the trailing 24h volume across a 30-day month", () => {
    const result = assessD1QuotaUsage({ rowsRead24h: 802_194_915, rowsWritten24h: 1_537_840 });

    expect(result.rowsRead.projectedMonthly).toBe(802_194_915 * 30);
    expect(result.rowsWritten.projectedMonthly).toBe(1_537_840 * 30);
    expect(result.rowsRead.utilizationPercent).toBeCloseTo(96.26, 2);
    expect(result.rowsWritten.utilizationPercent).toBeCloseTo(92.27, 2);
  });

  it("keeps unavailable usage unavailable instead of inventing zero", () => {
    const result = assessD1QuotaUsage({ rowsRead24h: null, rowsWritten24h: 1_500_000 });

    expect(result.rowsRead).toEqual({
      observed24h: null,
      projectedMonthly: null,
      includedMonthlyAllowance: 25_000_000_000,
      utilizationPercent: null,
      thresholdState: "unavailable",
      crossedThresholdPercent: null,
      nextThresholdPercent: null,
    });
    expect(result.rowsWritten.thresholdState).toBe("normal");
    expect(result.rowsWritten.utilizationPercent).toBeCloseTo(90, 2);
  });

  it("treats malformed observations as unavailable rather than healthy zero", () => {
    const result = assessD1QuotaUsage({
      rowsRead24h: Number.NaN,
      rowsWritten24h: -1,
    });

    expect(result.rowsRead.thresholdState).toBe("unavailable");
    expect(result.rowsRead.utilizationPercent).toBeNull();
    expect(result.rowsWritten.thresholdState).toBe("unavailable");
    expect(result.rowsWritten.utilizationPercent).toBeNull();
  });
});
