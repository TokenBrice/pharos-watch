import { describe, expect, it } from "vitest";
import type { BridgeRouteRiskProfile } from "@shared/types/core";
import xautMetaSource from "@shared/data/stablecoins/coins/xaut-tether.json";
import wmMetaSource from "@shared/data/stablecoins/coins/wm-m0.json";
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
  it("joins a reviewed deployment packet by exact wM route ID and retains zero supply", () => {
    const profile = wmMetaSource.bridgeRouteRisk as BridgeRouteRiskProfile;
    const supplyUsdByChain: Record<string, number> = {
      ethereum: 86_613_000,
      arbitrum: 88_000,
      base: 70_000,
      plume: 0,
      solana: 249_000,
    };
    const fixedInput = {
      chainCirculatingById: { "wm-m0": {} },
      safetyScoreV9SupplyAttributionById: {
        "wm-m0": {
          model: "reviewed-deployment-unit-partition-v1",
          deployments: profile.routes!.map((route) => ({
            routeId: route.id,
            chainId: route.destinationChain,
            contractAddress: route.contractAddress,
            currentSupplyUsd: supplyUsdByChain[route.destinationChain]!,
          })),
        },
      },
    } as unknown as ReportCardsFixedInput;

    const review = buildSafetyScoreV9SupplyReview(fixedInput, "wm-m0", profile);
    expect(review).not.toBeNull();
    expect(review!.selectedBridgeRoutes).toHaveLength(5);
    expect(review!.selectedRouteSupplyShare).toBe(1);
    expect(review!.unknownRouteSupplyShare).toBe(0);
    expect(review!.unreviewedRouteSupplyShare).toBe(0);
    expect(
      review!.selectedBridgeRoutes.find((route) => route.deploymentRouteKey.startsWith("plume:")),
    ).toMatchObject({ supplyUsd: 0, supplyShare: 0, reviewState: "selected-reviewed" });
  });

  it("keeps same-chain contracts separate when direct route identity is available", () => {
    const routes = [
      {
        id: "ethereum:0x0000000000000000000000000000000000000001",
        destinationChain: "ethereum",
        contractAddress: "0x0000000000000000000000000000000000000001",
        reviewDisposition: "reviewed",
      },
      {
        id: "ethereum:0x0000000000000000000000000000000000000002",
        destinationChain: "ethereum",
        contractAddress: "0x0000000000000000000000000000000000000002",
        reviewDisposition: "reviewed",
      },
    ] as unknown as BridgeRoutes;
    const fixedInput = {
      chainCirculatingById: { alpha: {} },
      safetyScoreV9SupplyAttributionById: {
        alpha: {
          model: "reviewed-deployment-unit-partition-v1",
          deployments: routes.map((route, index) => ({
            routeId: route.id,
            chainId: "ethereum",
            contractAddress: route.contractAddress,
            currentSupplyUsd: index === 0 ? 60 : 40,
          })),
        },
      },
    } as unknown as ReportCardsFixedInput;
    const review = buildSafetyScoreV9SupplyReview(fixedInput, "alpha", profile(routes));

    expect(review!.selectedBridgeRoutes.map((route) => route.deploymentRouteKey)).toEqual(
      routes.map((route) => route.id),
    );
    expect(review!.selectedBridgeRoutes.map((route) => route.supplyShare)).toEqual([0.6, 0.4]);
  });

  it("fails closed when a direct packet is partial or mismatched", () => {
    const routes = [
      ETH_ROUTE,
      {
        id: "base:0x0000000000000000000000000000000000000002",
        destinationChain: "base",
        contractAddress: "0x0000000000000000000000000000000000000002",
        reviewDisposition: "reviewed",
      } as unknown as BridgeRoutes[number],
    ];
    const fixedInput = {
      chainCirculatingById: { alpha: { ethereum: { current: 100 } } },
      safetyScoreV9SupplyAttributionById: {
        alpha: {
          model: "reviewed-deployment-unit-partition-v1",
          deployments: [{
            routeId: ETH_ROUTE.id,
            chainId: "ethereum",
            contractAddress: "native",
            currentSupplyUsd: 100,
          }],
        },
      },
    } as unknown as ReportCardsFixedInput;

    expect(buildSafetyScoreV9SupplyReview(fixedInput, "alpha", profile(routes))).toBeNull();
  });

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
      canonicalCirculatingLiabilityRaw:
        707_747_089_000n - 94_923_429_468n,
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
          model: "canonical-lock-mint-group-partition-v2",
          assetId: "xaut-tether",
          observedAtSec: 1_774_000_000,
          registryFingerprint: "a".repeat(64),
          routeInventoryDigest: "b".repeat(64),
          canonical: {
            routeId:
              "ethereum:0x68749665ff8d2d112fa859aa293f07a622782f38",
            chainId: "ethereum",
            currentSupplyUsd: partition!.canonicalSupplyUsd,
          },
          representationGroup: {
            deploymentRouteKey:
              "representation-group:xaut-tether:xaut0-omnichain",
            representationId: "xaut0-omnichain",
            routeIds: (
              xautMetaSource.bridgeRouteRisk as BridgeRouteRiskProfile
            ).routes!
              .filter(
                (route) =>
                  route.representationId === "xaut0-omnichain",
              )
              .map((route) => route.id)
              .sort(),
            riskTier: "external-lock-mint",
            failureDomainKeys: [
              "contract:ethereum:0xb9c2321bb7d0db468f570d10a424d1cc8efd696c",
              "protocol:xaut0-omnichain",
            ],
            currentSupplyUsd:
              partition!.pooledRepresentationSupplyUsd,
          },
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
        deploymentRouteKey:
          "representation-group:xaut-tether:xaut0-omnichain",
        reviewState: "selected-reviewed",
        reviewedRouteKind: "controlled",
      }),
    );
    expect(review!.selectedRouteSupplyShare).toBe(1);
    expect(review!.unknownRouteSupplyShare).toBe(0);
    expect(review!.unreviewedRouteSupplyShare).toBe(0);
    expect(
      review!.selectedBridgeRoutes.reduce((sum, route) => sum + route.supplyUsd, 0),
    ).toBe(aggregateSupplyUsd);
    expect(
      review!.selectedBridgeRoutes.filter((route) => route.deploymentRouteKey.includes("xaut0-omnichain")),
    ).toHaveLength(1);
    expect(review!.failureDomains).toEqual([
      {
        kind: "bridge-route",
        key: "contract:ethereum:0xb9c2321bb7d0db468f570d10a424d1cc8efd696c",
      },
      { kind: "bridge-route", key: "protocol:xaut0-omnichain" },
    ]);
  });

  it("fails a representation group closed once its unknown destination split is material", () => {
    const profile =
      xautMetaSource.bridgeRouteRisk as BridgeRouteRiskProfile;
    const fixedInput = {
      chainCirculatingById: { "xaut-tether": {} },
      safetyScoreV9SupplyAttributionById: {
        "xaut-tether": {
          model: "canonical-lock-mint-group-partition-v2",
          assetId: "xaut-tether",
          canonical: {
            routeId:
              "ethereum:0x68749665ff8d2d112fa859aa293f07a622782f38",
            chainId: "ethereum",
            currentSupplyUsd: 88,
          },
          representationGroup: {
            deploymentRouteKey:
              "representation-group:xaut-tether:xaut0-omnichain",
            representationId: "xaut0-omnichain",
            routeIds: profile.routes!
              .filter(
                (route) =>
                  route.representationId === "xaut0-omnichain",
              )
              .map((route) => route.id)
              .sort(),
            riskTier: "external-lock-mint",
            failureDomainKeys: [
              "contract:ethereum:0xb9c2321bb7d0db468f570d10a424d1cc8efd696c",
              "protocol:xaut0-omnichain",
            ],
            currentSupplyUsd: 12,
          },
        },
      },
    } as unknown as ReportCardsFixedInput;

    const review = buildSafetyScoreV9SupplyReview(
      fixedInput,
      "xaut-tether",
      profile,
    );

    expect(review).not.toBeNull();
    expect(
      review!.selectedBridgeRoutes.find((route) =>
        route.deploymentRouteKey.startsWith(
          "representation-group:",
        ),
      ),
    ).toMatchObject({
      reviewState: "selected-unresolved",
      supplyShare: 0.12,
    });
    expect(review!.selectedRouteSupplyShare).toBe(0.88);
    expect(review!.unknownRouteSupplyShare).toBe(0);
    expect(review!.unreviewedRouteSupplyShare).toBe(0.12);
  });
});
