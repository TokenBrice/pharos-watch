import { describe, expect, it } from "vitest";
import {
  decodeLiveReserveRedemptionTelemetry,
  LiveReserveDiagnosticsSchema,
  LiveReserveRedemptionTelemetrySchema,
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

  it.each([
    [{ capacityUsd: 0, dailyLimitUsd: 0 }, true],
    [{ capacityRatioOfSupply: 1, feeBps: 10_000, sourceTimestamp: 0 }, true],
    [{ capacityUsd: 100, dailyLimitUsd: -1 }, false],
    [{ capacityUsd: null }, false],
    [{ feeBps: "9000" }, false],
    [{ sourceTimestamp: -1 }, false],
    [{ routeStatus: "closed" }, false],
    [{ routeStatusReviewedAt: "2026-02-30" }, false],
    [{ sourceUrls: ["ftp://issuer.example"] }, false],
    [{ outputAssetKeys: ["asset:a", "asset:a"] }, false],
    [{ outputValuation: { sourceId: "test", observedAt: 0, unitValueUsd: 1,
      basketWeights: [{ assetId: "a", weight: 0.6 }, { assetId: "b", weight: 0.6 }] } }, false],
  ])("keeps structural decoding aligned with the response schema for %j", (telemetry, valid) => {
    expect(LiveReserveRedemptionTelemetrySchema.safeParse(telemetry).success).toBe(valid);
    expect(decodeLiveReserveRedemptionTelemetry({ redemption: telemetry }).status).toBe(valid ? "valid" : "invalid");
  });

  it("distinguishes absence, invalid roots, and valid measured zero with extensions", () => {
    expect(decodeLiveReserveRedemptionTelemetry({}).status).toBe("absent");
    expect(decodeLiveReserveRedemptionTelemetry({ redemption: undefined }).status).toBe("absent");
    for (const redemption of [null, [], "invalid"]) {
      expect(decodeLiveReserveRedemptionTelemetry({ redemption }).status).toBe("invalid");
    }
    const telemetry = { capacityUsd: 0, v9RouteAttempt: { status: "accepted", state: { measured: 0 } } };
    expect(decodeLiveReserveRedemptionTelemetry({ redemption: telemetry })).toEqual({ status: "valid", telemetry });
  });

  it("preserves stored valid source URL evidence verbatim during decoding", () => {
    const decoded = decodeLiveReserveRedemptionTelemetry({ redemption: {
      capacityUsd: 100,
      sourceUrls: ["https://issuer.example", "https://issuer.example/", "https://issuer.example/redeem"],
    } });
    expect(decoded).toEqual({ status: "valid", telemetry: {
      capacityUsd: 100, sourceUrls: ["https://issuer.example", "https://issuer.example/", "https://issuer.example/redeem"],
    } });
  });

  it.each([null, "0", -1, Number.NaN, Infinity])("rejects malformed raw deviation %s", (rawSumDeviation) => {
    expect(LiveReserveDiagnosticsSchema.safeParse({ rawSumDeviation }).success).toBe(false);
  });

  it("retains auxiliary diagnostics and reviewed rounding omission without publishing zero", () => {
    const diag = { publishedAllocationSumPct: 99, roundingEnvelopePct: 2 };
    expect(LiveReserveDiagnosticsSchema.parse(diag)).toEqual(diag);
    expect(LiveReserveDiagnosticsSchema.parse({ rawSumDeviation: 0 }).rawSumDeviation).toBe(0);
  });
});
