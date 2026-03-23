import { describe, expect, it } from "vitest";
import { getCacheFreshnessStatus, getCacheImpactStatus } from "@/lib/status/cache-health";

describe("cache-health", () => {
  it("keeps a >1.5x but <=2.0x cache ratio in degraded instead of stale", () => {
    expect(
      getCacheFreshnessStatus({
        ageSeconds: 3168,
        maxAge: 1800,
      }),
    ).toBe("degraded");
  });

  it("still treats source-stale fallback modes as stale public impact", () => {
    expect(
      getCacheImpactStatus({
        ageSeconds: 3168,
        maxAge: 1800,
        healthy: false,
        sourceStatus: "stale",
      }),
    ).toBe("stale");
  });

  it("marks degraded cache ratios as degraded public impact when the source is otherwise live", () => {
    expect(
      getCacheImpactStatus({
        ageSeconds: 3168,
        maxAge: 1800,
        healthy: false,
      }),
    ).toBe("degraded");
  });
});
