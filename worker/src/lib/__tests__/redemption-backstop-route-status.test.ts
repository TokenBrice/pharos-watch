import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { mergeRedemptionRouteStatus } from "../redemption-backstop/route-status";
import { buildRedemptionBackstopEntry } from "../redemption-backstop/sources";
import { route, snapshot, severeMarketEvidence } from "./redemption-backstop-sources.test-support";

afterEach(() => vi.unstubAllGlobals());

const staticOpen = {
  routeStatus: "open" as const,
  routeStatusSource: "static-config" as const,
};

describe("mergeRedemptionRouteStatus", () => {
  it("constructs the merged entry from supplied metadata without external I/O", async () => {
    const fetchMock = vi.fn(() => { throw new Error("Unexpected fetch"); });
    vi.stubGlobal("fetch", fetchMock);
    const db = mockD1Strict([]);
    const now = 1_700_000_000;
    const entry = await buildRedemptionBackstopEntry(db, "zchf-frankencoin", route({
      capacityModel: { kind: "reserve-sync-metadata" },
    }), 50_000_000, null, now, {
      reserveSnapshotMetadata: snapshot("zchf-frankencoin", {
        redemption: {
          capacityUsd: 5_000_000,
          capacityKind: "live-direct",
          freshnessKind: "same-run-onchain",
          sourceTimestamp: now - 120,
          routeStatus: "paused",
          routeStatusSource: "onchain",
        },
      }, { fetchedAt: now - 120 }),
    });
    expect(entry).toMatchObject({
      routeStatus: "paused", routeStatusSource: "onchain", resolutionState: "impaired", score: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.getHistory()).toEqual([]);
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
