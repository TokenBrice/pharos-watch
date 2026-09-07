import { describe, expect, it } from "vitest";
import { mergeRedemptionRouteStatus, REDEMPTION_ROUTE_STATUS_PRODUCER } from "../redemption-backstop/route-status";
import { severeMarketEvidence } from "./redemption-backstop-sources.test-support";

const staticOpen = {
  routeStatus: "open" as const,
  routeStatusSource: "static-config" as const,
};

describe("mergeRedemptionRouteStatus", () => {
  it("documents the v4 D1-free producer choice", () => {
    expect(REDEMPTION_ROUTE_STATUS_PRODUCER).toMatchObject({
      model: "live-reserve-adapters-plus-static-policy",
      fetchesDuringRedemptionSync: false,
      freshness: "sync-redemption-backstops-snapshot",
    });
  });

  it("prioritizes live adapter route status over static status", () => {
    const result = mergeRedemptionRouteStatus({
      staticEvidence: staticOpen,
      liveEvidence: {
        routeStatus: "paused",
        routeStatusSource: "onchain",
        routeStatusReason: "Vault paused onchain",
        routeStatusReviewedAt: "2026-05-12",
      },
      allowSevereMarketOpenException: false,
    });

    expect(result.routeStatus).toBe("paused");
    expect(result.routeStatusSource).toBe("onchain");
    expect(result.impaired).toBe(true);
    expect(result.capsApplied).toEqual(["route-status-impairment"]);
    expect(result.notes).toEqual(["Vault paused onchain"]);
  });

  it("falls back to static status when no live route status is present", () => {
    const result = mergeRedemptionRouteStatus({
      staticEvidence: {
        routeStatus: "unknown",
        routeStatusSource: "static-config",
      },
      allowSevereMarketOpenException: false,
    });

    expect(result.routeStatus).toBe("unknown");
    expect(result.routeStatusSource).toBe("static-config");
    expect(result.impaired).toBe(false);
    expect(result.notes).toEqual([]);
  });

  it("applies severe market impairment after static status", () => {
    const result = mergeRedemptionRouteStatus({
      staticEvidence: staticOpen,
      severeMarketImplied: severeMarketEvidence(),
      allowSevereMarketOpenException: false,
    });

    expect(result.routeStatus).toBe("degraded");
    expect(result.routeStatusSource).toBe("market-implied");
    expect(result.impaired).toBe(true);
    expect(result.capsApplied).toEqual(["market-implied-depeg-impairment"]);
  });

  it("withholds the route under uncertain current market evidence", () => {
    const result = mergeRedemptionRouteStatus({
      staticEvidence: staticOpen,
      severeMarketImplied: severeMarketEvidence({
        routeStatus: "unknown",
        routeStatusReason: "Open incident has no fresh authoritative current deviation",
        activeDepegBps: undefined,
      }),
      allowSevereMarketOpenException: false,
    });

    expect(result.routeStatus).toBe("unknown");
    expect(result.routeStatusSource).toBe("market-implied");
    expect(result.impaired).toBe(true);
    expect(result.capsApplied).toEqual(["market-implied-depeg-evidence-uncertain"]);
  });

  it("lets strong live-direct routes keep live-open evidence during severe market impairment", () => {
    const result = mergeRedemptionRouteStatus({
      staticEvidence: staticOpen,
      liveEvidence: {
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
      severeMarketImplied: severeMarketEvidence(),
      allowSevereMarketOpenException: true,
    });

    expect(result.routeStatus).toBe("open");
    expect(result.routeStatusSource).toBe("onchain");
    expect(result.impaired).toBe(false);
    expect(result.capsApplied).toEqual([]);
  });

  it("impairs live-open evidence during severe market impairment when the route is not strong live-direct", () => {
    const result = mergeRedemptionRouteStatus({
      staticEvidence: staticOpen,
      liveEvidence: {
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
      severeMarketImplied: severeMarketEvidence(),
      allowSevereMarketOpenException: false,
    });

    expect(result.routeStatus).toBe("degraded");
    expect(result.routeStatusSource).toBe("market-implied");
    expect(result.impaired).toBe(true);
    expect(result.capsApplied).toEqual(["market-implied-depeg-impairment"]);
  });

  it("honors a producer-approved strong live-direct exception", () => {
    // The entry builder sets this flag only when the final live-direct capacity
    // state also carries explicit live-open status.
    const result = mergeRedemptionRouteStatus({
      staticEvidence: staticOpen,
      severeMarketImplied: severeMarketEvidence(),
      allowSevereMarketOpenException: true,
    });

    expect(result.routeStatus).toBe("open");
    expect(result.routeStatusSource).toBe("static-config");
    expect(result.impaired).toBe(false);
    expect(result.capsApplied).toEqual([]);
  });

  it("does not exempt strong live-direct routes from output dependency impairment", () => {
    const result = mergeRedemptionRouteStatus({
      staticEvidence: staticOpen,
      liveEvidence: {
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
      severeMarketImplied: severeMarketEvidence({
        routeStatusReason: "Output asset impairment",
        outputImpairedDependencyId: "usdc-circle",
        outputImpairedShare: 1,
      }),
      allowSevereMarketOpenException: true,
    });

    expect(result.routeStatus).toBe("degraded");
    expect(result.routeStatusSource).toBe("market-implied");
    expect(result.impaired).toBe(true);
    expect(result.capsApplied).toEqual(["market-implied-depeg-impairment"]);
  });
});
