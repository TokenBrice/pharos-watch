import { describe, expect, it } from "vitest";
import {
  buildSafetyScoreV9BaselineExtensionFromNormalizedInput,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9/extension";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { makeV9ThreeAssetFixedInput, makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";

const CLOCK_SEC = Date.UTC(2026, 9, 10, 12) / 1_000;
const AS_OF_DATE_SEC = Date.UTC(2026, 9, 10) / 1_000;

function compileLaunchDate(
  alpha: Partial<V9ExtensionRegistryMeta>,
  beta: Partial<V9ExtensionRegistryMeta> = {},
  gamma: Partial<V9ExtensionRegistryMeta> = {},
) {
  const fixedInput = normalizeSafetyScoreV9CompilerInput(makeV9TwoAssetFixedInput({ clockSec: CLOCK_SEC }));
  const metaById = new Map<string, V9ExtensionRegistryMeta>([
    ["alpha", { id: "alpha", mechanismArchetype: "tbill", launchDate: "2020-01-01", ...alpha }],
    ["beta", { id: "beta", mechanismArchetype: "tbill", launchDate: "2019-01-01", ...beta }],
    ["gamma", { id: "gamma", mechanismArchetype: "tbill", launchDate: "2018-01-01", ...gamma }],
  ]);
  const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput, { metaById });
  const asset = extension.assets.find((row) => row.assetId === "alpha");
  expect(asset).toBeDefined();
  return asset!.launchedAtSec;
}

describe("production implementation-age compilation", () => {
  it.each([
    ["2025-H1", "2025-06-30"],
    ["2025-H2", "2025-12-31"],
  ])("resolves half-year implementation date %s to its inclusive end", (date, expected) => {
    expect(compileLaunchDate({ implementationLaunchDate: date })).toBe(Date.parse(`${expected}T00:00:00Z`) / 1_000);
  });

  it.each(["2026", "2026-10", "2026-Q4", "2026-H2"])(
    "clamps future fuzzy period %s to the fixed scoring UTC date",
    (date) => {
      expect(compileLaunchDate({ implementationLaunchDate: date })).toBe(AS_OF_DATE_SEC);
    },
  );

  it("walks the full variant chain and retains the newest layer rather than the final parent", () => {
    expect(compileLaunchDate(
      { variantOf: "beta", variantKind: "pure-wrapper" },
      { implementationLaunchDate: "2025-08-19", variantOf: "gamma", variantKind: "pure-wrapper" },
      { implementationLaunchDate: "2022-04-01" },
    )).toBe(Date.UTC(2025, 7, 19) / 1_000);
    expect(compileLaunchDate(
      { variantOf: "beta", variantKind: "pure-wrapper" },
      { variantOf: "gamma", variantKind: "pure-wrapper" },
      { implementationLaunchDate: "2025-H1" },
    )).toBe(Date.UTC(2025, 5, 30) / 1_000);
  });

  it("terminates a variant cycle and uses the newest visited implementation layer", () => {
    expect(compileLaunchDate(
      { variantOf: "beta", variantKind: "pure-wrapper" },
      { implementationLaunchDate: "2025-08-19", variantOf: "alpha", variantKind: "pure-wrapper" },
    )).toBe(Date.UTC(2025, 7, 19) / 1_000);
  });

  it("keeps a newer child layer and falls back to launchDate when no implementation date is authored", () => {
    expect(compileLaunchDate(
      { launchDate: "2025-09-01", variantOf: "beta", variantKind: "pure-wrapper" },
      { implementationLaunchDate: "2022-04-01" },
    )).toBe(Date.UTC(2025, 8, 1) / 1_000);
  });

  it("keeps missing and invalid launch dates unavailable", () => {
    expect(compileLaunchDate({ launchDate: undefined })).toBeNull();
    expect(compileLaunchDate({ implementationLaunchDate: "invalid" })).toBeNull();
  });
});

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
