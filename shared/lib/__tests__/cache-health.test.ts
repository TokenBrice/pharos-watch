import { describe, expect, it } from "vitest";
import { getCacheFreshnessStatus, getCacheImpactStatus } from "../cache-health";
import type { CacheStatus } from "../../types/status";

function cache(overrides: Partial<CacheStatus> = {}): CacheStatus {
  return {
    ageSeconds: 300,
    maxAge: 1_800,
    healthy: true,
    ...overrides,
  };
}

describe("cache health impact", () => {
  it("keeps stale producer source status informational while availability cache age is fresh", () => {
    expect(getCacheImpactStatus(cache({ sourceStatus: "stale" }))).toBe("healthy");
  });

  it("marks the cache stale only when the availability age budget is stale", () => {
    expect(getCacheImpactStatus(cache({ ageSeconds: 22_000, maxAge: 1_800, sourceStatus: "fresh" }))).toBe("stale");
  });

  describe("yield-data per-cache override (producer grace 3x/6x)", () => {
    // yield-data availability budget = its hourly producer interval; global 8x/12x would
    // keep a multi-hour-stale ranking "healthy". The override degrades past 3x, stales past 6x.
    const yieldCache = (ageSeconds: number): CacheStatus => cache({ ageSeconds, maxAge: 3_600 });

    it("stays healthy through two missed hourly publishes (ratio <= 3x)", () => {
      expect(getCacheImpactStatus(yieldCache(7_400), "yield-data")).toBe("healthy");
      expect(getCacheFreshnessStatus(yieldCache(10_800), "yield-data")).toBe("healthy");
    });

    it("degrades past 3x", () => {
      expect(getCacheImpactStatus(yieldCache(10_801), "yield-data")).toBe("degraded");
    });

    it("goes stale past 6x while the same age is only degraded under the global bands", () => {
      expect(getCacheImpactStatus(yieldCache(21_601), "yield-data")).toBe("stale");
      // Without the override key, 21601/3600 ≈ 6.0x is still inside the global 8x band.
      expect(getCacheImpactStatus(yieldCache(21_601))).toBe("healthy");
    });
  });
});
