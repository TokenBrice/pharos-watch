import { describe, expect, it } from "vitest";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9-fact-set";
import { createAssetBuildContext } from "../safety-score-v9-fact-set-context";
import { buildWrapperLocalFacts } from "../safety-score-v9-fact-set-wrapper";
import {
  makeV9RoleExtension,
  makeV9TwoAssetFixedInput,
  type V9ExtensionDependencyEdge,
} from "../../test-helpers/v9-fixed-input";

function fixedInputWithTrackedParent() {
  return makeV9TwoAssetFixedInput();
}

function wrapperExtension(
  fixed: ReturnType<typeof fixedInputWithTrackedParent>,
  variantKind: "pure-wrapper" | "savings-passthrough" | "strategy-vault",
  includeParentEdge = true,
) {
  const extension = makeV9RoleExtension(fixed, {});
  const parentEdge: V9ExtensionDependencyEdge = {
    upstreamAssetId: "beta",
    dependencyType: "wrapper",
    weight: 1,
    economicRole: "serial-claim",
    failureDomains: [],
  };
  const asset = extension.assets.find((candidate) => candidate.assetId === "alpha")!;
  asset.variantKind = variantKind;
  asset.dependencies = {
    source: includeParentEdge ? "variant" : "none",
    baseSource: "none",
    dependencyFromLive: false,
    mappedLiveReserveWeight: null,
    fallbackReason: null,
    edges: includeParentEdge ? [parentEdge] : [],
    diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
  };
  return extension;
}

function wrapperFacts(
  variantKind: "pure-wrapper" | "savings-passthrough" | "strategy-vault",
) {
  const fixed = fixedInputWithTrackedParent();
  const extension = wrapperExtension(fixed, variantKind);
  const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
  const asset = compiled.assets[0]!;
  if (asset.wrapperLocalFacts?.applicability !== "wrapper") {
    throw new Error("Expected wrapper-local facts");
  }
  return { fixed, extension, asset, facts: asset.wrapperLocalFacts };
}

describe("Safety Score V9 wrapper fact dispositions", () => {
  it("marks an unprofiled direct serial wrapper's local custody classes not-applicable", () => {
    for (const variantKind of ["pure-wrapper", "savings-passthrough"] as const) {
      const { facts } = wrapperFacts(variantKind);

      expect(facts.facts).toMatchObject({
        custodyEscrow: { disposition: "not-applicable" },
        leverage: { disposition: "not-applicable" },
        rehypothecationCorrelation: { disposition: "not-applicable" },
      });
      expect(facts.facts.custodyEscrow.disposition).not.toBe("issuer-undisclosed");
      expect(facts.facts.leverage.disposition).not.toBe("issuer-undisclosed");
      expect(facts.facts.rehypothecationCorrelation.disposition).not.toBe("issuer-undisclosed");
    }
  });

  it("keeps an applicable strategy-vault custody review issuer-undisclosed when no profile is published", () => {
    const { facts } = wrapperFacts("strategy-vault");

    expect(facts.facts.custodyEscrow).toMatchObject({
      disposition: "issuer-undisclosed",
      assessment: null,
    });
  });

  it("turns a reviewed leverage factor of 1.0 into reviewed none", () => {
    const { fixed, extension, asset } = wrapperFacts("strategy-vault");
    const context = createAssetBuildContext(
      fixed,
      extension,
      extension.assets.find((candidate) => candidate.assetId === "alpha")!,
      "a".repeat(64),
    );
    const reserveExposures = structuredClone(asset.reserveExposures);
    reserveExposures[0]!.riskFactors = ["leverage-factor:1.0"];

    const facts = buildWrapperLocalFacts(context, {
      implementation: asset.implementation,
      dependencies: asset.dependencies,
      reserveStatus: asset.reserveStatus,
      reserveExposures,
      exitStatus: asset.exitStatus,
      exitRoutes: asset.exitRoutes,
      controlStatus: asset.controlStatus,
      controls: asset.controls,
      economicControlReview: asset.economicControlReview,
      peg: asset.peg,
      supply: asset.supply,
    });
    if (facts.applicability !== "wrapper") throw new Error("Expected wrapper-local facts");

    expect(facts.facts.leverage).toMatchObject({
      disposition: "reviewed",
      assessment: "none",
      signals: ["wrapper-leverage-factor:leverage-factor:1.0"],
    });
  });

  it("fires the direct-serial-wrapper invariant when the tracked parent edge is absent", () => {
    const fixed = fixedInputWithTrackedParent();
    const extension = wrapperExtension(fixed, "pure-wrapper", false);
    const context = createAssetBuildContext(
      fixed,
      extension,
      extension.assets.find((candidate) => candidate.assetId === "alpha")!,
      "a".repeat(64),
    );

    expect(() =>
      buildWrapperLocalFacts(context, {
        dependencies: { edges: [] },
      } as never),
    ).toThrow(/pure-wrapper requires a tracked serial parent edge/);
  });
});
