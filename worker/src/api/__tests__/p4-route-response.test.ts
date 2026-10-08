import { describe, expect, it } from "vitest";
import { MAX_DEX_EXIT_ROUTE_OBSERVATIONS } from "@shared/types/market";
import { normalizeDexScoreDetails } from "../../lib/dex-liquidity-response";
import { makeCoinbaseRouteObservation } from "./p4-route-response.test-support";

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
        exitRouteObservations: [makeCoinbaseRouteObservation()],
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
        volumeActivity: 20,
        poolQuality: 30,
        durability: 40,
        pairDiversity: 50,
        exitRouteObservations: [{ routeId: "incomplete" }],
      }),
    );

    expect(result.scoreComponents).toEqual({
      tvlDepth: 10, volumeActivity: 20, poolQuality: 30, durability: 40, pairDiversity: 50,
    });
    expect(result.exitRouteObservations).toBeNull();
    expect(result.exitRouteObservationCoverage.status).toBe("unknown");
  });

  it("yields null score components for a partial legacy envelope", () => {
    const result = normalizeDexScoreDetails(JSON.stringify({ tvlDepth: 10 }));

    expect(result.scoreComponents).toBeNull();
  });
  it("quarantines oversized observation envelopes", () => {
    const observation = makeCoinbaseRouteObservation();

    const result = normalizeDexScoreDetails(
      JSON.stringify({
        tvlDepth: 10,
        exitRouteObservations: Array.from({ length: MAX_DEX_EXIT_ROUTE_OBSERVATIONS + 1 }, (_, index) => ({
          ...observation,
          routeId: `${observation.routeId}:${index}`,
        })),
      }),
    );

    expect(result.exitRouteObservations).toBeNull();
    expect(result.exitRouteObservationCoverage.status).toBe("unknown");
  });
});
