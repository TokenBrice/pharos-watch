import { beforeEach, describe, expect, it, vi } from "vitest";
import type { D1CapacityAssessment } from "@shared/types/status";
import { refreshD1CapacityMonitoring } from "../d1-capacity-monitor";

vi.mock("../d1-usage", () => ({
  getD1CapacityAssessmentFromCloudflare: vi.fn(),
}));

import { getD1CapacityAssessmentFromCloudflare } from "../d1-usage";

function assessment(overrides: Partial<D1CapacityAssessment> = {}): D1CapacityAssessment {
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

describe("refreshD1CapacityMonitoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps capacity telemetry available without an alert side effect", async () => {
    const expected = assessment();
    vi.mocked(getD1CapacityAssessmentFromCloudflare).mockResolvedValue(expected);

    await expect(refreshD1CapacityMonitoring({} as D1Database, {} as never, 1_783_661_028)).resolves.toEqual({
      assessment: expected,
      error: null,
    });
  });

  it("returns capacity-observation failure telemetry without alert reporting", async () => {
    vi.mocked(getD1CapacityAssessmentFromCloudflare).mockRejectedValue(new Error("control plane unavailable"));

    await expect(refreshD1CapacityMonitoring({} as D1Database, {} as never, 1_783_661_028)).resolves.toEqual({
      assessment: null,
      error: "control plane unavailable",
    });
  });
});
