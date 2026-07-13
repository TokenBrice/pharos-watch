import { describe, expect, it } from "vitest";
import { buildProfileDeploymentRoutes } from "../maintenance/populate-bridge-route-deployments";

describe("buildProfileDeploymentRoutes", () => {
  it("preserves the reviewed profile tier as global deployment rows", () => {
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
        protocol: "LayerZero",
        scope: "global",
        riskTier: "external-lock-mint",
        semantics: "lock-mint",
      }),
      expect.objectContaining({
        id: "base:0xdef",
        protocol: "LayerZero",
        scope: "global",
        riskTier: "external-lock-mint",
        semantics: "lock-mint",
      }),
    ]);
  });
});
