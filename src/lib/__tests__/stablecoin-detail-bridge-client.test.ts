import { describe, expect, it } from "vitest";
import type { BridgeRouteDeployment, BridgeRouteRiskProfile, BridgeRouteRiskTier, StablecoinMeta } from "@shared/types";
import { BRIDGE_THIRD_PARTY_TIERS, BRIDGE_TIER_LABELS } from "@shared/lib/classification";
import { BRIDGE_ROUTE_RISK_TIER_VALUES } from "@shared/types/core";
import {
  BRIDGE_ROUTE_PROJECTION_LIMIT,
  bindBridgeRouteControlComponents,
  projectBridgeRouteRiskClientSummary,
} from "../stablecoin-detail-bridge-client";

function route(chain: string, overrides: Partial<BridgeRouteDeployment> = {}): BridgeRouteDeployment {
  return {
    id: `${chain}:0x${chain.padEnd(40, "0").slice(0, 40)}`,
    destinationChain: chain,
    contractAddress: "0x0",
    protocol: "Issuer native",
    issuanceModel: "native-issuance",
    routeClass: "native",
    riskTier: "single-chain-or-native",
    semantics: "native-mint",
    scope: "canonical",
    reviewDisposition: "reviewed",
    ...overrides,
  } as BridgeRouteDeployment;
}

function representation(chain: string, riskTier: BridgeRouteRiskTier, overrides: Partial<BridgeRouteDeployment> = {}) {
  return route(chain, {
    canonicalChain: "ethereum",
    protocol: "Bridge",
    issuanceModel: "bridge-representation",
    routeClass: "third-party",
    riskTier,
    semantics: "lock-mint",
    scope: "peripheral",
    ...overrides,
  });
}

function coin(tier: BridgeRouteRiskTier, routes: BridgeRouteDeployment[]): StablecoinMeta {
  const bridgeRouteRisk = {
    tier,
    summary: "Reviewed bridge routes for the fixture asset.",
    reviewedAt: "2026-08-16",
    reviewer: "fixture",
    confidence: "verified",
    sources: [{ label: "Docs", url: "https://example.com" }],
    routes,
  } as BridgeRouteRiskProfile;
  return { id: "fixture", bridgeRouteRisk } as StablecoinMeta;
}

const TIER_RANK = (tier: BridgeRouteRiskTier) => BRIDGE_ROUTE_RISK_TIER_VALUES.indexOf(tier);

// EURC shape: authored single-chain/native over 9 native chains plus 4 reviewed
// peripheral representations: 3 behind an external validator network (2 of them
// canonical by route class) and 1 external lock & mint.
const EURC_ROUTES = [
  ...["ethereum", "base", "avalanche", "worldchain", "stellar", "solana", "cronos", "arc", "plasma"].map((chain) => route(chain)),
  representation("polygon", "external-validated-network", { routeClass: "canonical" }),
  representation("sonic", "external-validated-network", { routeClass: "canonical" }),
  representation("tempo", "external-lock-mint"),
  representation("cardano", "external-validated-network"),
];

describe("projectBridgeRouteRiskClientSummary", () => {
  it("reports the weakest reviewed route apart from the authored tier", () => {
    const summary = projectBridgeRouteRiskClientSummary(coin("single-chain-or-native", EURC_ROUTES))!;
    expect(summary.routeCount).toBe(13);
    expect(summary.chainCount).toBe(13);
    expect(summary.authoredTier).toBe("single-chain-or-native");
    for (const row of summary.routes.filter((candidate) => candidate.reviewed)) {
      expect(TIER_RANK(row.tierKey)).toBeLessThanOrEqual(TIER_RANK(summary.weakestRouteTier!));
    }
    expect(summary.weakestRouteTier).toBe("external-lock-mint");
    expect(summary.homeChainId).toBe("ethereum");
    expect(summary.routes[0]!.chainId).toBe("ethereum");
  });

  it("counts third-party routes from the same tiers the legend draws, whatever the route class", () => {
    const summary = projectBridgeRouteRiskClientSummary(coin("single-chain-or-native", EURC_ROUTES))!;
    const thirdPartyByTier = Object.entries(summary.tierCounts)
      .filter(([tier]) => BRIDGE_THIRD_PARTY_TIERS[tier as BridgeRouteRiskTier])
      .reduce((sum, [, count]) => sum + (count ?? 0), 0);
    expect(summary.thirdPartyRouteCount).toBe(thirdPartyByTier);
    expect(summary.thirdPartyRouteCount).toBe(4);
  });

  it("names the native tier 'Native' on a multi-chain asset and keeps 'Single-chain' for one chain", () => {
    const multi = projectBridgeRouteRiskClientSummary(coin("single-chain-or-native", EURC_ROUTES))!;
    expect(multi.authoredTierLabel).toBe("Native");
    expect(multi.routes.find((row) => row.tierKey === "single-chain-or-native")?.tierLabel).toBe("Native");

    const single = projectBridgeRouteRiskClientSummary(coin("single-chain-or-native", [route("ethereum")]))!;
    expect(single.chainCount).toBe(1);
    expect(single.routes[0]!.tierLabel).toBe(BRIDGE_TIER_LABELS["single-chain-or-native"]);
    expect(single.homeChainId).toBe("ethereum");
  });

  it("keeps the authored tier when the reviewer judged worse than the route inventory", () => {
    const summary = projectBridgeRouteRiskClientSummary(coin("opaque-or-unknown", [route("solana")]))!;
    expect(summary.authoredTier).toBe("opaque-or-unknown");
    expect(summary.weakestRouteTier).toBe("single-chain-or-native");
  });

  it("does not let an unresolved route stand in for a reviewed tier or a tier count", () => {
    const unresolved = representation("linea", "opaque-or-unknown", {
      routeClass: "unknown", issuanceModel: "unknown", semantics: "unknown", scope: "unknown", reviewDisposition: "unresolved",
    });
    const summary = projectBridgeRouteRiskClientSummary(coin("issuer-native-burn-mint", [
      route("ethereum", { riskTier: "issuer-native-burn-mint" }),
      unresolved,
    ]))!;
    expect(summary.weakestRouteTier).toBe("issuer-native-burn-mint");
    expect(summary.unresolvedRouteCount).toBe(1);
    expect(summary.tierCounts["opaque-or-unknown"]).toBeUndefined();
    expect(summary.routes.find((row) => row.chainId === "linea")?.reviewed).toBe(false);
  });

  it("caps the route list, reports the remainder, and keeps every tier and the unresolved routes represented", () => {
    const chains = Array.from({ length: 60 }, (_, index) => `chain${index}`);
    const routes = [
      route("ethereum"),
      ...chains.slice(0, 55).map((chain) => representation(chain, "external-lock-mint")),
      ...chains.slice(55, 58).map((chain) => representation(chain, "opaque-or-unknown", { routeClass: "canonical" })),
      ...chains.slice(58).map((chain) => representation(chain, "opaque-or-unknown", { reviewDisposition: "unresolved" })),
    ];
    const summary = projectBridgeRouteRiskClientSummary(coin("external-lock-mint", routes))!;
    expect(summary.routes).toHaveLength(BRIDGE_ROUTE_PROJECTION_LIMIT);
    expect(summary.routesTruncated).toBe(routes.length - BRIDGE_ROUTE_PROJECTION_LIMIT);
    expect(new Set(summary.routes.map((row) => row.tierKey))).toEqual(
      new Set(["single-chain-or-native", "external-lock-mint", "opaque-or-unknown"]),
    );
    expect(summary.routes.some((row) => !row.reviewed)).toBe(true);
    expect(summary.routes.some((row) => row.reviewed && row.tierKey === "opaque-or-unknown")).toBe(true);
    expect(summary.tierCounts["external-lock-mint"]).toBe(55);
    expect(summary.routes[0]!.chainId).toBe("ethereum");
  });

  it("returns null without a bridge review", () => {
    expect(projectBridgeRouteRiskClientSummary({ id: "none" } as StablecoinMeta)).toBeNull();
  });
});

describe("bindBridgeRouteControlComponents", () => {
  // Component keys copied from the live USDe card: `bridge:<deployment>:<control>`.
  const arbitrum = representation("arbitrum", "external-lock-mint", {
    id: "arbitrum:0x5D3A1Ff2b6BAb83b63cd9AD0787074081a52ef34",
    failureDomainKeys: ["protocol:layerzero-v2"],
  });
  const components = [
    { key: "oracle", kind: "oracle" },
    { key: "bridge:arbitrum:0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34:bridge-meta:usde-ethena:9f1a66795ef323ffda68", kind: "bridge" },
    { key: "bridge:native", kind: "bridge" },
  ];

  it("joins a route to its bridge component through the normalized deployment key", () => {
    const summary = projectBridgeRouteRiskClientSummary(coin("external-lock-mint", [route("ethereum"), arbitrum]))!;
    expect(summary.routes.every((row) => row.controlComponentKey === null)).toBe(true);
    const bound = bindBridgeRouteControlComponents(summary, components);
    expect(bound.routes.find((row) => row.chainId === "arbitrum")).toMatchObject({
      controlComponentKey: components[1]!.key,
      protocolKey: "layerzero-v2",
    });
    expect(bound.routes.find((row) => row.chainId === "ethereum")?.controlComponentKey).toBeNull();
  });

  it("leaves the summary untouched before the card arrives", () => {
    const summary = projectBridgeRouteRiskClientSummary(coin("external-lock-mint", [arbitrum]))!;
    expect(bindBridgeRouteControlComponents(summary, null)).toBe(summary);
  });
});
