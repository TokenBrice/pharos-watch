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

  describe("yield-data per-cache override (2x/4x)", () => {
    // yield-data availability budget = 3600s (hourly producer); global 8x/12x would
    // keep an 8h-stale ranking "healthy". The override degrades at 2x, stales at 4x.
    const yieldCache = (ageSeconds: number): CacheStatus => cache({ ageSeconds, maxAge: 3_600 });

    it("stays healthy through one missed hourly publish (ratio <= 2x)", () => {
      expect(getCacheImpactStatus(yieldCache(3_600), "yield-data")).toBe("healthy");
      expect(getCacheFreshnessStatus(yieldCache(7_000), "yield-data")).toBe("healthy");
    });

    it("degrades after two missed hourly publishes (ratio > 2x)", () => {
      expect(getCacheImpactStatus(yieldCache(7_400), "yield-data")).toBe("degraded");
    });

    it("goes stale past 4x while the same age is only degraded under the global bands", () => {
      expect(getCacheImpactStatus(yieldCache(15_000), "yield-data")).toBe("stale");
      // Without the override key, 15000/3600 ≈ 4.17x is still inside the global 8x band.
      expect(getCacheImpactStatus(yieldCache(15_000))).toBe("healthy");
    });
  });
});
