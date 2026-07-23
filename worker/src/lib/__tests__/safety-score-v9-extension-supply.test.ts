import { describe, expect, it } from "vitest";
import type { BridgeRouteRiskProfile } from "@shared/types/core";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9SupplyReview, safetyScoreV9RouteSupplyShare } from "../safety-score-v9-extension-supply";

function fixedInputStub(chainCirculating: Record<string, { current: number }>): ReportCardsFixedInput {
  return { chainCirculatingById: { alpha: chainCirculating } } as unknown as ReportCardsFixedInput;
}

type BridgeRoutes = NonNullable<BridgeRouteRiskProfile["routes"]>;

function profile(routes: BridgeRoutes): BridgeRouteRiskProfile {
  return { routes } as BridgeRouteRiskProfile;
}

const ETH_ROUTE = {
  id: "ethereum:native",
  reviewDisposition: "reviewed",
  routeClass: "native",
  issuanceModel: "native-issuance",
  failureDomainKeys: ["chain:Ethereum"],
} as unknown as BridgeRoutes[number];

describe("buildSafetyScoreV9SupplyReview", () => {
  it("returns null without supply rows and without routes on a multi-chain asset", () => {
    expect(buildSafetyScoreV9SupplyReview(fixedInputStub({}), "alpha", undefined)).toBeNull();
    expect(
      buildSafetyScoreV9SupplyReview(
        fixedInputStub({ ethereum: { current: 60 }, tron: { current: 40 } }),
        "alpha",
        undefined,
      ),
    ).toBeNull();
  });

  it("reconciles per-chain supply onto single reviewed routes and buckets the rest", () => {
    const review = buildSafetyScoreV9SupplyReview(
      fixedInputStub({ ethereum: { current: 60 }, tron: { current: 25 }, base: { current: 15 } }),
      "alpha",
      profile([
        ETH_ROUTE,
        { id: "tron:bridge", reviewDisposition: "unreviewed" } as unknown as BridgeRoutes[number],
        // base has no route row -> unknown bucket
      ]),
    );
    expect(review).not.toBeNull();
    expect(review!.selectedBridgeRoutes.map((route) => route.deploymentRouteKey)).toEqual([
      "ethereum:native",
      "tron:bridge",
      "unmatched-chain:alpha:base",
    ]);
    expect(review!.selectedBridgeRoutes.find((route) => route.reviewState === "unmatched")).toMatchObject({
      deploymentRouteKey: "unmatched-chain:alpha:base",
      supplyShare: 0.15,
    });
    expect(review!.selectedBridgeRoutes.find((route) => route.deploymentRouteKey === "ethereum:native")).toMatchObject(
      { reviewState: "selected-reviewed", reviewedRouteKind: "native" },
    );
    expect(review!.selectedBridgeRoutes.find((route) => route.deploymentRouteKey === "tron:bridge")).not.toHaveProperty(
      "reviewedRouteKind",
    );
    expect(review!.selectedRouteSupplyShare).toBeCloseTo(0.6, 6);
    expect(review!.unknownRouteSupplyShare).toBeCloseTo(0.15, 6);
    expect(review!.unreviewedRouteSupplyShare).toBeCloseTo(0.25, 6);
    expect(review!.failureDomains).toContainEqual({ kind: "bridge-route", key: "chain:Ethereum" });
    expect(safetyScoreV9RouteSupplyShare(review, "ethereum:native")).toBeCloseTo(0.6, 6);
    expect(safetyScoreV9RouteSupplyShare(review, "unknown:route")).toBe(0);
    expect(safetyScoreV9RouteSupplyShare(null, "ethereum:native")).toBeNull();
  });

  it("normalizes captured display names to route chain ids", () => {
    const review = buildSafetyScoreV9SupplyReview(
      fixedInputStub({ Ethereum: { current: 60 }, "OP Mainnet": { current: 25 }, BSC: { current: 15 } }),
      "alpha",
      profile([
        ETH_ROUTE,
        { id: "optimism:bridge", reviewDisposition: "reviewed" } as unknown as BridgeRoutes[number],
        { id: "bsc:bridge", reviewDisposition: "reviewed" } as unknown as BridgeRoutes[number],
      ]),
    );

    expect(review!.selectedBridgeRoutes.map((route) => route.deploymentRouteKey)).toEqual([
      "bsc:bridge",
      "ethereum:native",
      "optimism:bridge",
    ]);
    expect(review!.selectedRouteSupplyShare).toBe(1);
    expect(review!.unknownRouteSupplyShare).toBe(0);
  });

  it("keeps chains with multiple route rows unknown rather than splitting supply", () => {
    const review = buildSafetyScoreV9SupplyReview(
      fixedInputStub({ ethereum: { current: 100 } }),
      "alpha",
      profile([ETH_ROUTE, { ...ETH_ROUTE, id: "ethereum:wormhole" }]),
    );
    expect(review!.selectedBridgeRoutes).toEqual([
      {
        deploymentRouteKey: "ambiguous-chain:alpha:ethereum",
        reviewState: "unmatched",
        supplyShare: 1,
        supplyUsd: 100,
      },
    ]);
    expect(review!.unknownRouteSupplyShare).toBe(1);
  });

  it("pools uncanonicalized labels and scopes unmatched failure domains to the asset", () => {
    const fixed = fixedInputStub({
      ethereum: { current: 80 },
      "Future Chain": { current: 12 },
      "future_chain": { current: 8 },
    });
    const alpha = buildSafetyScoreV9SupplyReview(fixed, "alpha", profile([ETH_ROUTE]))!;
    const beta = buildSafetyScoreV9SupplyReview(
      { ...fixed, chainCirculatingById: { beta: fixed.chainCirculatingById.alpha } },
      "beta",
      profile([ETH_ROUTE]),
    )!;

    expect(alpha.selectedBridgeRoutes.find((route) => route.reviewState === "unmatched")).toEqual({
      deploymentRouteKey: "unmatched-chain-label-pool:alpha",
      reviewState: "unmatched",
      supplyShare: 0.2,
      supplyUsd: 20,
    });
    expect(beta.selectedBridgeRoutes.find((route) => route.reviewState === "unmatched")?.deploymentRouteKey).toBe(
      "unmatched-chain-label-pool:beta",
    );
    const betaUnmatchedDomain = beta.failureDomains.find((domain) => domain.key.includes("unmatched-chain-label-pool"));
    expect(alpha.failureDomains).not.toContainEqual(betaUnmatchedDomain);
  });
});
