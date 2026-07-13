import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "../../shared/types/core";
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
      applicableMultiDeploymentCoins: 218,
      reviewedProfiles: 218,
      missingProfiles: 0,
      incompleteRouteProfiles: 0,
      invalidEvidenceProfiles: 0,
      coverageTheaterProfiles: 0,
    });
    expect(audit.summary.completeRouteProfiles).toBeGreaterThan(0);
    expect(audit.summary.unresolvedRouteProfiles).toBeGreaterThan(0);
    expect(audit.summary.reviewedRoutes + audit.summary.unresolvedRoutes).toBe(audit.summary.routes);
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
