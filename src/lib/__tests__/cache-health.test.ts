import { describe, expect, it } from "vitest";
import { getCacheImpactStatus } from "@shared/lib/cache-health";

describe("cache-health", () => {
  it("does not let stale producer source status escalate degraded cache age to stale public impact", () => {
    expect(
      getCacheImpactStatus({
        ageSeconds: 16000,
        maxAge: 1800,
        healthy: false,
        sourceStatus: "stale",
      }),
    ).toBe("degraded");
  });

});
