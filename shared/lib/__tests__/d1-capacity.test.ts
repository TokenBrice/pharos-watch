import { describe, expect, it } from "vitest";
import {
  assessD1Capacity,
  D1_PAID_MAX_DATABASE_SIZE_BYTES,
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

  it("exposes 24h, 72h, 7d, and 30d slopes and uses the shortest valid one", () => {
    const current = { observedAt: NOW, databaseSizeBytes: 6 * GB };
    const observations = Array.from({ length: 8 * 24 + 1 }, (_, index) => ({
      observedAt: NOW - (8 * 24 - index) * 3600,
      databaseSizeBytes: 5.2 * GB + index * 5_000_000,
    }));
    const result = assessD1Capacity(current, observations);

    expect(result.growthWindows?.map((window) => window.window)).toEqual(["24h", "72h", "7d", "30d"]);
    expect(result.growthWindows?.map((window) => window.valid)).toEqual([true, true, true, false]);
    expect(result.growthWindows?.[3]?.growthBytesPerDay).not.toBeNull();
    expect(result.conservativeWindow).toBe("24h");
    expect(result.sampleCount).toBeGreaterThanOrEqual(22);
    expect(result.growthBytesPerDay).toBeGreaterThan(0);
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

  it("uses Cloudflare's paid-plan 10 GB database ceiling", () => {
    expect(D1_PAID_MAX_DATABASE_SIZE_BYTES).toBe(10_000_000_000);
  });

  it("maps watch, warning, and critical thresholds onto health severity", () => {
    expect(getD1CapacityImpactStatus("normal")).toBe("healthy");
    expect(getD1CapacityImpactStatus("watch")).toBe("healthy");
    expect(getD1CapacityImpactStatus("warning")).toBe("degraded");
    expect(getD1CapacityImpactStatus("critical")).toBe("stale");
  });
});
