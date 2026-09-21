import { describe, expect, it } from "vitest";
import {
  LIVE_RESERVE_REDEMPTION_TELEMETRY_NUMBER_FIELD_KEYS,
  LiveReserveRedemptionTelemetrySchema,
  parseLiveReserveRedemptionTelemetryNumber,
} from "../live-reserves";

describe("live-reserve redemption telemetry numeric policy", () => {
  it("rejects impossible values the producer validator would reject", () => {
    expect(LiveReserveRedemptionTelemetrySchema.safeParse({ settlementDelaySec: -5 }).success).toBe(false);
    expect(LiveReserveRedemptionTelemetrySchema.safeParse({ capacityUsd: -1 }).success).toBe(false);
    expect(LiveReserveRedemptionTelemetrySchema.safeParse({ queueDepthUsd: -1 }).success).toBe(false);
    expect(LiveReserveRedemptionTelemetrySchema.safeParse({ minRedeemUsd: -1 }).success).toBe(false);
    expect(LiveReserveRedemptionTelemetrySchema.safeParse({ capacityRatioOfSupply: 1.5 }).success).toBe(false);
    expect(LiveReserveRedemptionTelemetrySchema.safeParse({ capacityRatioOfSupply: -0.1 }).success).toBe(false);
    expect(LiveReserveRedemptionTelemetrySchema.safeParse({ feeBps: 10_001 }).success).toBe(false);
    expect(LiveReserveRedemptionTelemetrySchema.safeParse({ feeBps: -1 }).success).toBe(false);
  });

  it("accepts the boundary values the policy allows", () => {
    const boundary = {
      capacityUsd: 0,
      capacityRatioOfSupply: 1,
      settlementDelaySec: 0,
      queueDepthUsd: 0,
      dailyLimitUsd: 0,
      minRedeemUsd: 0,
      feeBps: 10_000,
    };
    expect(LiveReserveRedemptionTelemetrySchema.safeParse(boundary).success).toBe(true);
  });

  it("drops policy-violating persisted fields for the D1 decoder, keeping the same rule as the response schema", () => {
    expect(parseLiveReserveRedemptionTelemetryNumber("settlementDelaySec", -5)).toBeNull();
    expect(parseLiveReserveRedemptionTelemetryNumber("capacityRatioOfSupply", 1.5)).toBeNull();
    expect(parseLiveReserveRedemptionTelemetryNumber("feeBps", 10_001)).toBeNull();
    expect(parseLiveReserveRedemptionTelemetryNumber("feeBps", "9000" as unknown)).toBeNull();
    expect(parseLiveReserveRedemptionTelemetryNumber("feeBps", Number.NaN)).toBeNull();
    expect(parseLiveReserveRedemptionTelemetryNumber("settlementDelaySec", 3_600)).toBe(3_600);

    // The decoder iterates exactly the policy's field set — no field can be
    // retained outside the shared rule.
    expect(LIVE_RESERVE_REDEMPTION_TELEMETRY_NUMBER_FIELD_KEYS).toEqual([
      "capacityUsd",
      "capacityRatioOfSupply",
      "sourceTimestamp",
      "blockNumber",
      "settlementDelaySec",
      "queueDepthUsd",
      "dailyLimitUsd",
      "minRedeemUsd",
      "feeBps",
    ]);
  });
});
