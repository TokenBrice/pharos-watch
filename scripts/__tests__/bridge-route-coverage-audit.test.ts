import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/core";
import { buildBridgeRouteCoverageAudit } from "../lib/bridge-route-coverage-audit";

function fixture(routes: NonNullable<NonNullable<StablecoinMeta["bridgeRouteRisk"]>["routes"]>): StablecoinMeta {
  return {
    id: "fixture",
    symbol: "FIX",
    name: "Fixture",
    status: "active",
    contracts: [
      { chain: "ethereum", address: "0xaaa", decimals: 18 },
      { chain: "base", address: "0xbbb", decimals: 18 },
    ],
    bridgeRouteRisk: {
      tier: "external-lock-mint",
      summary: "Reviewed multi-deployment route fixture.",
      reviewedAt: "2026-07-13",
      reviewer: "Pharos",
      confidence: "verified",
      sources: [{ label: "Docs", url: "https://example.com" }],
      routes,
    },
  } as unknown as StablecoinMeta;
}

describe("bridge-route coverage audit", () => {
  it("reports honest complete and unresolved registry coverage", () => {
    const audit = buildBridgeRouteCoverageAudit(ACTIVE_STABLECOINS, "2026-07-13T00:00:00.000Z");
    expect(audit.summary).toMatchObject({
      missingProfiles: 0,
      incompleteRouteProfiles: 0,
      invalidEvidenceProfiles: 0,
      coverageTheaterProfiles: 0,
    });
    expect(audit.summary.reviewedProfiles).toBe(audit.summary.applicableMultiDeploymentCoins);
    expect(audit.summary.reviewedRoutes + audit.summary.unresolvedRoutes).toBe(audit.summary.routes);
  });

  it.each([
    ["alusd-alchemix", "ethereum", "0xe9d672f89493c7286a9bafc6b763364ec0bfe4fe"],
    ["alusd-alchemix", "base", "0x303241e2b3b4aed0bb0f8623e7442368fed8faf3"],
    ["bold-liquity", "berachain", "0xf05a207442f14e446b0e32b12d2043bfc68cb1c9"],
    ["mxnb-juno", "arc", "0xf197ffc28c23e0309b5559e7a166f2c6164c80aa"],
  ])("retains an honest unresolved disposition for %s on %s (%s)", (coinId, chain, address) => {
    const coin = ACTIVE_STABLECOINS.find((candidate) => candidate.id === coinId);
    expect(coin?.contracts).toEqual(expect.arrayContaining([expect.objectContaining({ chain, address })]));
    const routes = coin?.bridgeRouteRisk?.routes?.filter(
      (route) => route.destinationChain === chain && route.contractAddress === address,
    );
    expect(routes).toHaveLength(1);
    const route = routes?.[0];
    expect(route).toMatchObject({
      id: `${chain}:${address}`,
      reviewDisposition: "unresolved",
      issuanceModel: "unknown",
      routeClass: "unknown",
      riskTier: "opaque-or-unknown",
      semantics: "unknown",
      scope: "unknown",
    });
    expect(route?.reviewNote?.trim().length).toBeGreaterThanOrEqual(12);
    expect(route?.sources).toBeUndefined();
    expect(route?.observedAt).toBeUndefined();
    expect(route?.observedBlock).toBeUndefined();
    expect(route?.controllerChain).toBeUndefined();
    expect(route?.controllerAddress).toBeUndefined();
  });

  it("rejects mechanically copied all-global profile rows", () => {
    const coin = fixture([
      {
        id: "ethereum",
        destinationChain: "ethereum",
        contractAddress: "0xaaa",
        protocol: "profile-reviewed route",
        issuanceModel: "bridge-representation",
        routeClass: "third-party",
        riskTier: "external-lock-mint",
        semantics: "lock-mint",
        scope: "global",
        reviewDisposition: "reviewed",
        observedAt: "2026-07-13",
      },
      {
        id: "base",
        destinationChain: "base",
        contractAddress: "0xbbb",
        protocol: "profile-reviewed route",
        issuanceModel: "bridge-representation",
        routeClass: "third-party",
        riskTier: "external-lock-mint",
        semantics: "lock-mint",
        scope: "global",
        reviewDisposition: "reviewed",
        observedAt: "2026-07-13",
      },
    ]);
    const audit = buildBridgeRouteCoverageAudit([coin], "2026-07-13T00:00:00.000Z");

    expect(audit.summary.completeRouteProfiles).toBe(0);
    expect(audit.summary.invalidEvidenceProfiles).toBe(1);
    expect(audit.summary.coverageTheaterProfiles).toBe(1);
  });

  it("rejects native deployments mislabeled as bridge representations", () => {
    const coin = fixture([
      {
        id: "ethereum",
        destinationChain: "ethereum",
        contractAddress: "0xaaa",
        protocol: "Issuer",
        issuanceModel: "bridge-representation",
        routeClass: "native",
        riskTier: "issuer-native-burn-mint",
        semantics: "native-mint",
        scope: "canonical",
        reviewDisposition: "reviewed",
        observedAt: "2026-07-13",
        sources: [{ label: "Docs", url: "https://example.com" }],
      },
      {
        id: "base",
        destinationChain: "base",
        contractAddress: "0xbbb",
        protocol: "unresolved route",
        issuanceModel: "unknown",
        routeClass: "unknown",
        riskTier: "opaque-or-unknown",
        semantics: "unknown",
        scope: "unknown",
        reviewDisposition: "unresolved",
        reviewNote: "The route semantics and scope remain unresolved.",
      },
    ]);
    const audit = buildBridgeRouteCoverageAudit([coin], "2026-07-13T00:00:00.000Z");

    expect(audit.invalidEvidenceProfiles[0]?.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("native deployment is mislabeled"),
        expect.stringContaining("native-mint semantics conflict"),
      ]),
    );
    expect(audit.summary.unresolvedRouteProfiles).toBe(1);
  });
});
