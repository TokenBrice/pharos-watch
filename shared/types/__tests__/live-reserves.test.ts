import { describe, expect, it } from "vitest";
import {
  decodeLiveReserveRedemptionTelemetry,
  LiveReserveDiagnosticsSchema,
  LiveReserveRedemptionTelemetrySchema,
  emptyReserveCompositionOverview,
  ReserveCompositionOverviewSchema,
} from "../live-reserves";
import { StatusResponseSchema } from "../status";
import { unavailableReserveComposition } from "../../lib/status-reserve-composition";
import { statusResponse } from "./status.test-support";

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

describe("reserve overview progress evidence", () => {
  it("preserves measured in-progress counts without inventing missing legacy measurements", () => {
    const overview = emptyReserveCompositionOverview();
    for (const inProgressCoins of [0, 12]) {
      expect(ReserveCompositionOverviewSchema.parse({ ...overview, inProgressCoins }).inProgressCoins).toBe(inProgressCoins);
    }
    const legacy = { ...overview };
    delete legacy.inProgressCoins;
    expect(ReserveCompositionOverviewSchema.parse(legacy).inProgressCoins).toBeUndefined();
  });

  it("round-trips adapter reliability availability without defaulting legacy payloads", () => {
    const overview = emptyReserveCompositionOverview();
    expect(overview.adapterReliabilityAvailability).toBeUndefined();
    expect(ReserveCompositionOverviewSchema.parse(overview).adapterReliabilityAvailability).toBeUndefined();
    for (const availability of [
      { status: "available" },
      { status: "unavailable", reason: "reserve_adapter_reliability_query_failed" },
    ] as const) {
      expect(ReserveCompositionOverviewSchema.parse({ ...overview, adapterReliabilityAvailability: availability })
        .adapterReliabilityAvailability).toEqual(availability);
    }
    for (const invalid of [{ status: "unavailable" }, { status: "unavailable", reason: "other" }, { status: "unknown" }, null]) {
      expect(ReserveCompositionOverviewSchema.safeParse({ ...overview, adapterReliabilityAvailability: invalid }).success)
        .toBe(false);
    }
  });

  it.each([-1, 0.5, Number.NaN, Infinity, null])("rejects invalid in-progress counts: %s", (inProgressCoins) => {
    expect(ReserveCompositionOverviewSchema.safeParse({
      ...emptyReserveCompositionOverview(), inProgressCoins,
    }).success).toBe(false);
  });

  it("preserves null in-progress evidence for an unavailable status observation", () => {
    const parsed = StatusResponseSchema.parse({ ...statusResponse(), reserveComposition: unavailableReserveComposition() });
    expect(parsed.reserveComposition.inProgressCoins).toBeNull();
    const legacy = unavailableReserveComposition();
    delete legacy.inProgressCoins;
    expect(StatusResponseSchema.parse({ ...statusResponse(), reserveComposition: legacy }).reserveComposition.inProgressCoins)
      .toBeUndefined();
  });
});
