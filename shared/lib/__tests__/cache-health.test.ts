import { describe, expect, it } from "vitest";
import { getCacheImpactStatus } from "../cache-health";
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
});
