import { describe, expect, it } from "vitest";
import type { BridgeRouteRiskProfile } from "@shared/types/core";
import xautMetaSource from "@shared/data/stablecoins/coins/xaut-tether.json";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9SupplyReview, safetyScoreV9RouteSupplyShare } from "../safety-score-v9-extension-supply";
import { deriveLockMintSupplyPartition } from "../safety-score-v9-supply-attribution";

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

  it("reconciles the curated-aggregate NAV wrapper capture shape instead of nulling", () => {
    // Mirrors the per-chain map the sUSDS/sDAI fallback + fiat-cg overlay now
    // emits (CHAIN_META display labels) once the curated aggregate probe is
    // wired: without a populated chainCirculatingById this asset would fall to
    // the aggregate-only path and cap V9 on runtime-bridge-materiality.
    const review = buildSafetyScoreV9SupplyReview(
      fixedInputStub({
        Ethereum: { current: 4_517_720_000 },
        Base: { current: 11_478_000 },
        Optimism: { current: 4_876_000 },
        Arbitrum: { current: 346_620_000 },
      }),
      "alpha",
      profile([
        {
          id: "ethereum:0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
          reviewDisposition: "reviewed",
          routeClass: "native",
          issuanceModel: "native-issuance",
        } as unknown as BridgeRoutes[number],
        {
          id: "base:0x5875eee11cf8398102fdad704c9e96607675467a",
          reviewDisposition: "reviewed",
        } as unknown as BridgeRoutes[number],
        {
          id: "optimism:0xb5b2dc7fd34c249f4be7fb1fcea07950784229e0",
          reviewDisposition: "reviewed",
        } as unknown as BridgeRoutes[number],
        {
          id: "arbitrum:0xddb46999f8891663a8f2828d25298f70416d7610",
          reviewDisposition: "reviewed",
        } as unknown as BridgeRoutes[number],
      ]),
    );

    expect(review).not.toBeNull();
    expect(review!.selectedBridgeRoutes.map((route) => route.deploymentRouteKey)).toEqual([
      "arbitrum:0xddb46999f8891663a8f2828d25298f70416d7610",
      "base:0x5875eee11cf8398102fdad704c9e96607675467a",
      "ethereum:0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
      "optimism:0xb5b2dc7fd34c249f4be7fb1fcea07950784229e0",
    ]);
    expect(review!.selectedRouteSupplyShare).toBe(1);
    expect(review!.unknownRouteSupplyShare).toBe(0);
    expect(
      review!.selectedBridgeRoutes.find(
        (route) => route.deploymentRouteKey === "ethereum:0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
      ),
    ).toMatchObject({ reviewState: "selected-reviewed", reviewedRouteKind: "native" });
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

  it("conserves aggregate-only XAUT across free canonical supply and the XAUt0 lock/mint pool", () => {
    const aggregateSupplyUsd = 2_480_000_000;
    const partition = deriveLockMintSupplyPartition({
      aggregateSupplyUsd,
      canonicalTotalSupplyRaw: 707_747_089_000n,
      lockboxBalancesRaw: [29_714_544_713n],
      canonicalChainLabel: "Ethereum",
      pooledRepresentationLabel: "XAUt0 lock-mint pool",
    });
    expect(partition).not.toBeNull();
    expect(partition!.canonicalSupplyUsd + partition!.pooledRepresentationSupplyUsd).toBe(aggregateSupplyUsd);

    const fixedInput = {
      chainCirculatingById: {
        "xaut-tether": {},
      },
      aggregateCirculatingById: {
        "xaut-tether": {
          circulating: { peggedGOLD: aggregateSupplyUsd },
          observedAtSec: 1_774_000_000,
        },
      },
      safetyScoreV9SupplyAttributionById: {
        "xaut-tether": {
          model: "canonical-lock-mint-partition-v1",
          observedAtSec: 1_774_000_000,
          currentSupplyUsdByChain: partition!.currentSupplyUsdByChain,
        },
      },
    } as unknown as ReportCardsFixedInput;
    const review = buildSafetyScoreV9SupplyReview(
      fixedInput,
      "xaut-tether",
      xautMetaSource.bridgeRouteRisk as BridgeRouteRiskProfile,
    );

    expect(review).not.toBeNull();
    expect(review!.selectedBridgeRoutes).toHaveLength(2);
    expect(review!.selectedBridgeRoutes).toContainEqual(
      expect.objectContaining({
        deploymentRouteKey: "ethereum:0x68749665ff8d2d112fa859aa293f07a622782f38",
        reviewState: "selected-reviewed",
        reviewedRouteKind: "native",
      }),
    );
    expect(review!.selectedBridgeRoutes).toContainEqual(
      expect.objectContaining({
        deploymentRouteKey: "unmatched-chain-label-pool:xaut-tether",
        reviewState: "unmatched",
      }),
    );
    expect(review!.selectedRouteSupplyShare).toBeCloseTo(0.95801530635, 10);
    expect(review!.unknownRouteSupplyShare).toBeCloseTo(0.04198469365, 10);
    expect(review!.unreviewedRouteSupplyShare).toBe(0);
    expect(
      review!.selectedBridgeRoutes.reduce((sum, route) => sum + route.supplyUsd, 0),
    ).toBe(aggregateSupplyUsd);
    expect(
      review!.selectedBridgeRoutes.filter((route) => route.deploymentRouteKey.includes("xaut0-omnichain")),
    ).toEqual([]);
  });
});
