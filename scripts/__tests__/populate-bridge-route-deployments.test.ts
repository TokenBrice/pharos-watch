import { describe, expect, it } from "vitest";
import { buildProfileDeploymentRoutes } from "../maintenance/populate-bridge-route-deployments";

describe("buildProfileDeploymentRoutes", () => {
  it("leaves profile-only route facts explicitly unresolved", () => {
    const rows = buildProfileDeploymentRoutes(
      {
        tier: "external-lock-mint",
        summary: "Reviewed bridge route profile with sufficient evidence.",
        reviewedAt: "2026-07-13",
        reviewer: "Pharos",
        confidence: "verified",
        protocols: [{ source: "docs", name: "LayerZero" }],
        sources: [{ label: "Docs", url: "https://example.com" }],
      },
      [
        { chain: "ethereum", address: "0xabc", decimals: 18 },
        { chain: "base", address: "0xdef", decimals: 18 },
      ],
    );

    expect(rows).toEqual([
      expect.objectContaining({
        id: "ethereum:0xabc",
        protocol: "unresolved route",
        scope: "unknown",
        riskTier: "opaque-or-unknown",
        semantics: "unknown",
        reviewDisposition: "unresolved",
      }),
      expect.objectContaining({
        id: "base:0xdef",
        protocol: "unresolved route",
        scope: "unknown",
        riskTier: "opaque-or-unknown",
        semantics: "unknown",
        reviewDisposition: "unresolved",
      }),
    ]);
  });

  it("maps issuer-native burn/mint facts with versioned route evidence", () => {
    const rows = buildProfileDeploymentRoutes(
      {
        tier: "issuer-native-burn-mint",
        summary: "Issuer-native burn and mint routes are documented for every deployment.",
        reviewedAt: "2026-07-13",
        reviewer: "Pharos",
        confidence: "verified",
        protocols: [{ source: "issuer", name: "Issuer transfer protocol" }],
        sources: [{ label: "Issuer docs", url: "https://example.com" }],
      },
      [{ chain: "ethereum", address: "0xdef", decimals: 18 }],
      "usdc-circle",
    );

    expect(rows[0]).toMatchObject({
      routeClass: "native",
      issuanceModel: "native-issuance",
      semantics: "native-mint",
      scope: "canonical",
      reviewDisposition: "reviewed",
      mappingVersion: "bridge-route-facts-v1",
      sources: [{ label: "Issuer docs", url: "https://example.com" }],
    });
  });
});
