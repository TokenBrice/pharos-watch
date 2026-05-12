import { describe, expect, it } from "vitest";
import { mergeRedemptionRouteStatus, REDEMPTION_ROUTE_STATUS_PRODUCER } from "../redemption-backstop-route-status";

const staticOpen = {
  routeStatus: "open" as const,
  routeStatusSource: "static-config" as const,
};

describe("mergeRedemptionRouteStatus", () => {
  it("documents the v4 D1-free producer choice", () => {
    expect(REDEMPTION_ROUTE_STATUS_PRODUCER).toMatchObject({
      model: "live-reserve-adapters-plus-static-policy",
      fetchesDuringRedemptionSync: false,
      overrideStore: "static-config",
      freshness: "sync-redemption-backstops-snapshot",
    });
  });

  it("prioritizes live adapter route status over configured feed status", () => {
    const result = mergeRedemptionRouteStatus({
      staticEvidence: staticOpen,
      liveEvidence: {
        routeStatus: "paused",
        routeStatusSource: "onchain",
        routeStatusReason: "Vault paused onchain",
        routeStatusReviewedAt: "2026-05-12",
      },
      feedEvidence: {
        origin: "protocol-feed",
        routeStatus: "open",
        routeStatusSource: "protocol-api",
      },
      allowSevereMarketOpenException: false,
    });

    expect(result.routeStatus).toBe("paused");
    expect(result.routeStatusSource).toBe("onchain");
    expect(result.impaired).toBe(true);
    expect(result.capsApplied).toEqual(["route-status-impairment"]);
    expect(result.notes).toEqual(["Vault paused onchain"]);
  });

  it("applies severe market impairment after an open protocol feed", () => {
    const result = mergeRedemptionRouteStatus({
      staticEvidence: staticOpen,
      feedEvidence: {
        origin: "protocol-feed",
        routeStatus: "open",
        routeStatusSource: "protocol-api",
      },
      severeMarketImplied: {
        routeStatus: "degraded",
        routeStatusSource: "market-implied",
        routeStatusReason: "Active severe depeg",
        routeStatusReviewedAt: "2026-05-12",
        activeDepegBps: 3000,
        activeDepegStartedAt: 1_777_000_000,
      },
      allowSevereMarketOpenException: false,
    });

    expect(result.routeStatus).toBe("degraded");
    expect(result.routeStatusSource).toBe("market-implied");
    expect(result.impaired).toBe(true);
    expect(result.capsApplied).toEqual(["market-implied-depeg-impairment"]);
  });

  it("lets strong live-direct routes keep live-open evidence during severe market impairment", () => {
    const result = mergeRedemptionRouteStatus({
      staticEvidence: staticOpen,
      liveEvidence: {
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
      severeMarketImplied: {
        routeStatus: "degraded",
        routeStatusSource: "market-implied",
        routeStatusReason: "Active severe depeg",
        routeStatusReviewedAt: "2026-05-12",
        activeDepegBps: 3000,
        activeDepegStartedAt: 1_777_000_000,
      },
      allowSevereMarketOpenException: true,
    });

    expect(result.routeStatus).toBe("open");
    expect(result.routeStatusSource).toBe("onchain");
    expect(result.impaired).toBe(false);
    expect(result.capsApplied).toEqual([]);
  });
});
