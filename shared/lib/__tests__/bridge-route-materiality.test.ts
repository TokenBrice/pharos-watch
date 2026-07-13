import { describe, expect, it } from "vitest";
import { resolveBridgeRouteMateriality } from "../bridge-route-materiality";
import type { BridgeRouteRiskProfile, StablecoinMeta } from "../../types/core";

function profile(routes: BridgeRouteRiskProfile["routes"]): BridgeRouteRiskProfile {
  return {
    tier: "external-lock-mint",
    summary: "Reviewed multi-deployment bridge route fixture.",
    reviewedAt: "2026-07-13",
    reviewer: "Pharos",
    confidence: "verified",
    sources: [{ label: "Docs", url: "https://example.com/bridge" }],
    routes,
  };
}

describe("resolveBridgeRouteMateriality", () => {
  it("does not let a weak sub-threshold peripheral route replace a canonical route", () => {
    const result = resolveBridgeRouteMateriality(
      {
        contracts: [
          { chain: "ethereum", address: "0xAAA", decimals: 6 },
          { chain: "base", address: "0xBBB", decimals: 6 },
        ],
        bridgeRouteRisk: profile([
          {
            id: "ethereum-native",
            destinationChain: "ethereum",
            contractAddress: "0xAAA",
            protocol: "Issuer",
            issuanceModel: "native-issuance",
            routeClass: "native",
            riskTier: "issuer-native-burn-mint",
            semantics: "native-mint",
            scope: "canonical",
          },
          {
            id: "base-peripheral",
            destinationChain: "base",
            contractAddress: "0xBBB",
            protocol: "External bridge",
            issuanceModel: "bridge-representation",
            routeClass: "third-party",
            riskTier: "external-lock-mint",
            semantics: "lock-mint",
            scope: "peripheral",
          },
        ]),
      },
      { ethereum: { current: 95 }, base: { current: 5 } },
    );

    expect(result).toMatchObject({
      status: "complete",
      effectiveTier: "issuer-native-burn-mint",
      selectedRouteId: "ethereum-native",
      matchedSupplyRatio: 1,
      unknownSupplyRatio: 0,
    });
    expect(result.routes.find((route) => route.routeId === "base-peripheral")?.material).toBe(false);
  });

  it("selects a weak peripheral route once its dynamic share is material", () => {
    const bridgeRouteRisk = profile([
      {
        id: "ethereum-native",
        destinationChain: "ethereum",
        contractAddress: "0xAAA",
        protocol: "Issuer",
        issuanceModel: "native-issuance",
        routeClass: "native",
        riskTier: "issuer-native-burn-mint",
        semantics: "native-mint",
        scope: "canonical",
      },
      {
        id: "base-peripheral",
        destinationChain: "base",
        contractAddress: "0xBBB",
        protocol: "External bridge",
        issuanceModel: "bridge-representation",
        routeClass: "third-party",
        riskTier: "external-lock-mint",
        semantics: "lock-mint",
        scope: "peripheral",
      },
    ]);
    const result = resolveBridgeRouteMateriality(
      {
        contracts: [
          { chain: "ethereum", address: "0xAAA", decimals: 6 },
          { chain: "base", address: "0xBBB", decimals: 6 },
        ],
        bridgeRouteRisk,
      },
      { ethereum: { current: 80 }, base: { current: 20 } },
    );

    expect(result).toMatchObject({ effectiveTier: "external-lock-mint", selectedRouteId: "base-peripheral" });
  });

  it("preserves unknown when same-chain contract supply cannot be disaggregated", () => {
    const result = resolveBridgeRouteMateriality(
      {
        contracts: [
          { chain: "ethereum", address: "0xAAA", decimals: 6 },
          { chain: "ethereum", address: "0xBBB", decimals: 6 },
        ],
        bridgeRouteRisk: profile([
          {
            id: "ethereum-a",
            destinationChain: "ethereum",
            contractAddress: "0xAAA",
            protocol: "Issuer A",
            issuanceModel: "native-issuance",
            routeClass: "native",
            riskTier: "issuer-native-burn-mint",
            semantics: "native-mint",
            scope: "canonical",
          },
          {
            id: "ethereum-b",
            destinationChain: "ethereum",
            contractAddress: "0xBBB",
            protocol: "Issuer B",
            issuanceModel: "bridge-representation",
            routeClass: "third-party",
            riskTier: "external-lock-mint",
            semantics: "lock-mint",
            scope: "peripheral",
          },
        ]),
      },
      { ethereum: { current: 100 } },
    );

    expect(result).toMatchObject({
      status: "partial",
      effectiveTier: "opaque-or-unknown",
      matchedSupplyRatio: 0,
      unknownSupplyRatio: 1,
      unknownChains: ["ethereum"],
    });
  });

  it("treats a material explicitly unknown route scope as opaque", () => {
    const result = resolveBridgeRouteMateriality(
      {
        contracts: [{ chain: "base", address: "0xBBB", decimals: 6 }],
        bridgeRouteRisk: profile([
          {
            id: "base-unresolved",
            destinationChain: "base",
            contractAddress: "0xBBB",
            protocol: "Unresolved route",
            issuanceModel: "unknown",
            routeClass: "third-party",
            riskTier: "external-lock-mint",
            semantics: "unknown",
            scope: "unknown",
          },
        ]),
      },
      { base: { current: 100 } },
    );

    expect(result).toMatchObject({
      status: "complete",
      effectiveTier: "opaque-or-unknown",
      selectedRouteId: "base-unresolved",
      matchedSupplyRatio: 1,
      unknownSupplyRatio: 0,
    });
    expect(result.reason).toContain("unknown scope");
  });
});

describe("bridge-route fixture typing", () => {
  it("keeps the materiality input compatible with stablecoin metadata", () => {
    const meta = { id: "fixture", contracts: [] } as unknown as StablecoinMeta;
    expect(resolveBridgeRouteMateriality(meta, null).status).toBe("not-applicable");
  });
});
