import { describe, expect, it } from "vitest";
import { normalizeDexScoreDetails } from "../dex-liquidity-response";

describe("P4 route observation API compatibility", () => {
  it("marks old score-component envelopes as explicitly unknown", () => {
    const result = normalizeDexScoreDetails(
      JSON.stringify({
        tvlDepth: 10,
        volumeActivity: 20,
        poolQuality: 30,
        durability: 40,
        pairDiversity: 50,
      }),
    );

    expect(result.exitRouteObservations).toBeNull();
    expect(result.exitRouteObservationCoverage).toMatchObject({
      status: "unknown",
      capabilityMatrixVersion: "unknown",
      unsupportedReasons: { producerEnvelopeAbsent: 1 },
    });
  });

  it("parses a valid additive route observation envelope", () => {
    const result = normalizeDexScoreDetails(
      JSON.stringify({
        tvlDepth: 10,
        exitRouteObservations: [
          {
            routeId: "dex:usdc:cg-tickers:coinbase",
            routeFamily: "dex-orderbook",
            scope: { kind: "venue", venue: "coinbase", protocol: "coinbase" },
            requestedNotionalUsd: 1_000_000,
            settlementHorizonSec: 300,
            maxCostBps: 200,
            executableUsd: 500_000,
            completionRatio: 0.5,
            output: { kind: "fiat", currency: "USD" },
            evidenceKind: "direct-orderbook-depth",
            confidence: "medium",
            scoreEligible: false,
            observedAt: 1_720_000_000,
            freshnessSeconds: 0,
            commonModeKeys: ["protocol:coinbase", "fiat:usd"],
            capacityCurve: [
              {
                requestedNotionalUsd: 1_000_000,
                maxCostBps: 200,
                executableUsd: 500_000,
                completionRatio: 0.5,
              },
            ],
          },
        ],
        exitRouteObservationCoverage: {
          status: "populated",
          capabilityMatrixVersion: "p4a.1",
          retainedPoolCount: 1,
          observationCount: 1,
          scoreEligibleObservationCount: 0,
          unsupportedPoolCount: 0,
          evidenceCounts: { "direct-orderbook-depth": 1 },
          unsupportedReasons: {},
        },
      }),
    );

    expect(result.exitRouteObservations).toEqual([
      expect.objectContaining({
        routeId: "dex:usdc:cg-tickers:coinbase",
        evidenceKind: "direct-orderbook-depth",
      }),
    ]);
    expect(result.exitRouteObservationCoverage).toMatchObject({ status: "populated", observationCount: 1 });
  });

  it("quarantines malformed observations without dropping score components", () => {
    const result = normalizeDexScoreDetails(
      JSON.stringify({
        tvlDepth: 10,
        exitRouteObservations: [{ routeId: "incomplete" }],
      }),
    );

    expect(result.scoreComponents).toBeNull();
    expect(result.exitRouteObservations).toBeNull();
    expect(result.exitRouteObservationCoverage.status).toBe("unknown");
  });
});
