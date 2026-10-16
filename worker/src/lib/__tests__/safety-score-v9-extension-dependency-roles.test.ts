import { describe, expect, it } from "vitest";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput, type V9ExtensionRegistryMeta } from "../safety-score-v9/extension";
import { makeV9ThreeAssetFixedInput } from "../../test-helpers/v9-fixed-input";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";

function roleFixture(anchorWeight = 0.001) {
  const fixedInput = structuredClone(normalizeSafetyScoreV9CompilerInput(makeV9ThreeAssetFixedInput(0.8)));
  const slices = [
    { name: "Beta reserve", pct: 70, risk: "low" as const, coinId: "beta", depType: "collateral" as const },
    { name: "Gamma reserve", pct: 30, risk: "low" as const, coinId: "gamma", depType: "collateral" as const },
  ];
  fixedInput.liveReserveMap.alpha = slices;
  const alpha: V9ExtensionRegistryMeta = {
    id: "alpha", mechanismArchetype: "tbill", reserves: slices,
    dependencies: [{ id: "beta", type: "collateral", weight: anchorWeight }],
    dependencyReview: {
      reviewedAt: new Date(fixedInput.clockSec * 1000).toISOString().slice(0, 10),
      reviewer: "Role fixture", confidence: "verified", rationale: "Reviewed upstream issuance stack, independent of reserve weights.",
      sources: [{ label: "Issuer evidence", url: "https://example.com/issuer" }],
      relationships: [{ id: "beta", type: "collateral", weight: 0.001, economicRole: "control-operator", reason: "Reviewed issuance stack." }],
    },
  };
  return { fixedInput, metaById: new Map<string, V9ExtensionRegistryMeta>([
    ["alpha", alpha], ["beta", { id: "beta", mechanismArchetype: "tbill" }], ["gamma", { id: "gamma", mechanismArchetype: "tbill" }],
  ]) };
}

describe("reserve basket and reviewed role coexistence", () => {
  it("keeps measured reserve shares and the independently anchored role", () => {
    const fixture = roleFixture();
    const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixture.fixedInput, { metaById: fixture.metaById });
    const dependency = extension.assets.find((asset) => asset.assetId === "alpha")!.dependencies!;
    expect(dependency.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ upstreamAssetId: "beta", economicRole: "basket-exposure", weight: 0.7 }),
      expect.objectContaining({ upstreamAssetId: "gamma", economicRole: "basket-exposure", weight: 0.3 }),
      expect.objectContaining({ upstreamAssetId: "beta", economicRole: "control-operator", weight: 0.001 }),
    ]));
    expect(dependency.diagnostics.issueCodes).not.toContain("dependency-review-mismatch");
  });

  it("does not duplicate anchored un-roled reviews over a live reserve base", () => {
    const fixture = roleFixture();
    const alpha = fixture.metaById.get("alpha")!;
    alpha.dependencies = [
      { id: "beta", type: "collateral", weight: 0.7 },
      { id: "gamma", type: "collateral", weight: 0.3 },
    ];
    alpha.dependencyReview!.relationships = [
      { id: "beta", type: "collateral", weight: 0.7, reason: "Reviewed reserve identity." },
      { id: "gamma", type: "collateral", weight: 0.3, reason: "Reviewed reserve identity." },
    ];
    const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixture.fixedInput, { metaById: fixture.metaById });
    const dependency = extension.assets.find((asset) => asset.assetId === "alpha")!.dependencies!;
    expect(dependency.edges.map((edge) => ({ id: edge.upstreamAssetId, type: edge.dependencyType, role: edge.economicRole, weight: edge.weight }))).toEqual([
      { id: "beta", type: "collateral", role: "basket-exposure", weight: 0.7 },
      { id: "gamma", type: "collateral", role: "basket-exposure", weight: 0.3 },
    ]);
    expect(dependency.diagnostics.graphState).toBe("valid");
  });

  it("does not admit a subset role review whose authored weight differs", () => {
    const fixture = roleFixture(0.002);
    const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixture.fixedInput, { metaById: fixture.metaById });
    const dependency = extension.assets.find((asset) => asset.assetId === "alpha")!.dependencies!;
    expect(dependency.diagnostics.issueCodes).toContain("dependency-review-mismatch");
    expect(dependency.edges.some((edge) => edge.economicRole === "control-operator")).toBe(false);
    expect(dependency.edges.filter((edge) => edge.economicRole === "basket-exposure").map((edge) => edge.weight)).toEqual([0.7, 0.3]);
  });
});
