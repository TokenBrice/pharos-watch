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
    // yield-data availability budget = 1800s (post-V9 producer); global 8x/12x would
    // keep a multi-hour-stale ranking "healthy". The override degrades at 2x, stales at 4x.
    const yieldCache = (ageSeconds: number): CacheStatus => cache({ ageSeconds, maxAge: 1_800 });

    it("stays healthy through one missed post-V9 publish (ratio <= 2x)", () => {
      expect(getCacheImpactStatus(yieldCache(1_800), "yield-data")).toBe("healthy");
      expect(getCacheFreshnessStatus(yieldCache(3_500), "yield-data")).toBe("healthy");
    });

    it("degrades after two missed post-V9 publishes (ratio > 2x)", () => {
      expect(getCacheImpactStatus(yieldCache(3_700), "yield-data")).toBe("degraded");
    });

    it("goes stale past 4x while the same age is only degraded under the global bands", () => {
      expect(getCacheImpactStatus(yieldCache(7_500), "yield-data")).toBe("stale");
      // Without the override key, 7500/1800 ≈ 4.17x is still inside the global 8x band.
      expect(getCacheImpactStatus(yieldCache(7_500))).toBe("healthy");
    });
  });
});
