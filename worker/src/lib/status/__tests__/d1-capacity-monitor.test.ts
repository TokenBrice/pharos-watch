import { describe, expect, it } from "vitest";
import type { D1CapacityAssessment } from "@shared/types/status";
import { buildD1CapacityAlertPolicy } from "../d1-capacity-monitor";

function assessment(
  overrides: Partial<D1CapacityAssessment> = {},
): D1CapacityAssessment {
  return {
    observedAt: 1_783_661_028,
    databaseSizeBytes: 4_000_000_000,
    maximumSizeBytes: 10_000_000_000,
    utilizationRatio: 0.4,
    utilizationPercent: 40,
    thresholdState: "normal",
    crossedThresholdPercent: null,
    nextThresholdPercent: 60,
    sampleCount: 72,
    forecastBasis: "linear-30d",
    forecastSpanHours: 71,
    growthBytesPerDay: 100_000_000,
    nextThresholdAt: 1_800_941_028,
    exhaustionAt: 1_835_501_028,
    daysUntilExhaustion: 600,
    ...overrides,
  };
}

describe("buildD1CapacityAlertPolicy", () => {
  it("keeps normal utilization inactive", () => {
    expect(buildD1CapacityAlertPolicy(assessment())).toMatchObject({
      active: false,
      severity: "warning",
      fingerprint: { thresholdState: "normal" },
    });
  });

  it("raises a distinct critical incident at the 90% threshold", () => {
    const policy = buildD1CapacityAlertPolicy(assessment({
      databaseSizeBytes: 9_000_000_000,
      utilizationRatio: 0.9,
      utilizationPercent: 90,
      thresholdState: "critical",
      crossedThresholdPercent: 90,
      nextThresholdPercent: 100,
      daysUntilExhaustion: 10,
    }));

    expect(policy).toMatchObject({
      active: true,
      severity: "critical",
      fingerprint: { thresholdState: "critical" },
    });
    expect(policy.message).toContain("Forecast exhaustion in 10 days");
  });
});
