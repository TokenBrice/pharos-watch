import { describe, expect, it } from "vitest";
import type { V9AssetFactsBase, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import {
  assessV9ControlDomainScope,
  deploymentControlDomainSeverity,
  isV9ControllerOwnedCommonModeMember,
  isV9ParentControlledCommonModeMember,
  resolveV9MintControlGroupSeverity,
  v9ControlAssetDomainId,
  type V9MintControlGroupIssuerFacts,
  type V9SupplyChainExposure,
} from "../safety-score-v9/evaluate-set";
import type { V9CommonModeMember, V9DependencyPathPlan } from "../safety-score-v9/dependencies";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

const DOMAIN = { kind: "upgrade-control" as const, key: "program:shared" };
const MEMBER: V9CommonModeMember = { assetId: "fixture", owner: "control", pathKey: "control:shared" };

function knownStatus(): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: "fixture.control", rationale: null, gapId: null },
    observationState: "known",
    evidenceRefIds: ["evidence:fixture"],
    gapIds: [],
  };
}

function assetWithControl(
  overrides: Partial<V9AssetFactsBase["controls"][number]> = {},
): V9AssetFactsBase {
  const control: V9AssetFactsBase["controls"][number] = {
    controlKey: MEMBER.pathKey,
    deploymentKey: "solana:fixture-mint",
    sourceGenerationId: "fixture:g1",
    controlKind: "upgrade",
    scope: "deployment",
    status: knownStatus(),
    capabilities: ["upgrade"],
    capSemantics: { kind: "not-applicable", bound: null },
    claimImpairment: "unbounded",
    economicLossScope: "deployment",
    authority: { authorityKey: "solana:fixture-program", model: "multisig", threshold: { required: 4, total: 6 } },
    delaySec: 0,
    materialSupplyShare: 0.0581,
    keyCustody: "unknown",
    modulesOrGuards: "none-detected",
    incidentState: "none",
    failureDomains: [DOMAIN],
    ...overrides,
  };
  return { controls: [control] } as unknown as V9AssetFactsBase;
}

function supplyExposure(overrides: Partial<V9SupplyChainExposure> = {}): V9SupplyChainExposure {
  return {
    shareBySlug: new Map([["solana", 0.0581]]),
    unattributedShare: 0,
    unmatchedChainLabelPoolShare: 0,
    complete: true,
    ...overrides,
  };
}

describe("Safety Score v9 local control-domain scope", () => {
  it("makes a complete sub-10% deployment-local control domain diagnostic", () => {
    const assessment = assessV9ControlDomainScope(DOMAIN, [MEMBER], assetWithControl(), supplyExposure());

    expect(assessment).toEqual({
      economicLossScope: "deployment",
      deploymentKeys: ["solana:fixture-mint"],
      materialShare: 0.0581,
    });
    expect(
      deploymentControlDomainSeverity(assessment, V9_CANDIDATE_POLICY_V1.policy.semantic.materiality),
    ).toBe("low");
  });

  it("uses chain exposure only when a control share is unavailable", () => {
    const asset = assetWithControl({ materialSupplyShare: null });
    expect(assessV9ControlDomainScope(DOMAIN, [MEMBER], asset, supplyExposure())).toEqual({
      economicLossScope: "deployment",
      deploymentKeys: ["solana:fixture-mint"],
      materialShare: 0.0581,
    });
    expect(assessV9ControlDomainScope(
      DOMAIN, [MEMBER], asset, supplyExposure({ shareBySlug: new Map() }),
    )).toEqual({ economicLossScope: "global-claim", deploymentKeys: [], materialShare: null });
  });

  it("independently fails closed on incomplete supply, unattributed supply, or unknown control evidence", () => {
    const assess = (asset: V9AssetFactsBase, supply: V9SupplyChainExposure) =>
      assessV9ControlDomainScope(DOMAIN, [MEMBER], asset, supply);
    expect(assess(assetWithControl(), supplyExposure()).economicLossScope).toBe("deployment");
    const globalClaim = { economicLossScope: "global-claim", deploymentKeys: [], materialShare: null };
    expect(assess(assetWithControl(), supplyExposure({ complete: false }))).toEqual(globalClaim);
    expect(assess(assetWithControl(), supplyExposure({ unattributedShare: 0.1 }))).toEqual(globalClaim);
    expect(assess(assetWithControl({
      status: { ...knownStatus(), observationState: "bounded-unknown" },
    }), supplyExposure())).toEqual(globalClaim);
  });

  it("counts repeated deployment members once and rejects contradictory shares", () => {
    const asset = assetWithControl({ materialSupplyShare: 0.2 });
    const second = { ...MEMBER, pathKey: "control:second" };
    asset.controls = [...asset.controls, { ...asset.controls[0]!, controlKey: second.pathKey }];
    expect(assessV9ControlDomainScope(DOMAIN, [MEMBER, second], asset, supplyExposure())).toEqual({
      economicLossScope: "deployment", deploymentKeys: ["solana:fixture-mint"], materialShare: 0.2,
    });
    asset.controls[1]!.materialSupplyShare = 0.3;
    expect(assessV9ControlDomainScope(DOMAIN, [MEMBER, second], asset, supplyExposure())).toEqual({
      economicLossScope: "global-claim", deploymentKeys: [], materialShare: null,
    });
  });

  it("sums distinct deployments and rejects a nonconserved aggregate", () => {
    const asset = assetWithControl({ materialSupplyShare: 0.2 });
    const second = { ...MEMBER, pathKey: "control:second" };
    asset.controls = [...asset.controls, {
      ...asset.controls[0]!, controlKey: second.pathKey, deploymentKey: "ethereum:second", materialSupplyShare: 0.3,
    }];
    const assessment = assessV9ControlDomainScope(DOMAIN, [MEMBER, second], asset, supplyExposure());
    expect(assessment).toEqual({
      economicLossScope: "deployment",
      deploymentKeys: ["ethereum:second", "solana:fixture-mint"],
      materialShare: 0.5,
    });
    asset.controls[1]!.materialSupplyShare = 0.9;
    expect(assessV9ControlDomainScope(DOMAIN, [MEMBER, second], asset, supplyExposure())).toEqual({
      economicLossScope: "global-claim", deploymentKeys: [], materialShare: null,
    });
  });

  it("grades deployment boundaries and unresolved whole-claim exposure", () => {
    const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;
    for (const [share, severity] of [[0.1, "moderate"], [0.25, "high"]] as const) {
      const assessment = assessV9ControlDomainScope(
        DOMAIN, [MEMBER], assetWithControl({ materialSupplyShare: share }), supplyExposure(),
      );
      expect(deploymentControlDomainSeverity(assessment, materiality)).toBe(severity);
    }
    expect(deploymentControlDomainSeverity({
      economicLossScope: "global-claim", deploymentKeys: [], materialShare: null,
    }, materiality)).toBe("high");
    expect(deploymentControlDomainSeverity({
      economicLossScope: "deployment", deploymentKeys: ["solana:fixture-mint"], materialShare: null,
    }, materiality)).toBe("high");
  });

  it("keeps an authority that reaches the root claim at global-claim scope", () => {
    const assessment = assessV9ControlDomainScope(
      DOMAIN,
      [MEMBER],
      assetWithControl({ scope: "global", economicLossScope: "global-claim" }),
      supplyExposure(),
    );

    expect(assessment.economicLossScope).toBe("global-claim");
    expect(assessment.materialShare).toBeNull();
  });
});

// Own-issuer controller reuse is diagnostic; crossed or unresolved issuer joins fail closed.
describe("D2 ruled issuer-scoped mint-control grouping", () => {
  const sameIssuerGroup = (size: 2 | 4): V9MintControlGroupIssuerFacts => ({
    controllerIssuerKey: "issuer:circle",
    members: Array.from({ length: size }, (_, index) => ({
      assetId: `circle-product-${index}`,
      pathKey: `mint:path-${index}`,
      assetIssuerKey: "issuer:circle",
    })),
  });

  it("grades a same-issuer controller group diagnostic (low)", () => {
    expect(resolveV9MintControlGroupSeverity(sameIssuerGroup(4))).toBe("low");
  });

  it("keeps a cross-issuer shared controller capping (high)", () => {
    expect(resolveV9MintControlGroupSeverity({
      controllerIssuerKey: "issuer:circle",
      members: [
        { assetId: "usdc-circle", pathKey: "mint:a", assetIssuerKey: "issuer:circle" },
        { assetId: "foreign-wrapper", pathKey: "mint:b", assetIssuerKey: "issuer:other" },
      ],
    })).toBe("high");
  });

  it("fails closed (high) when the controller issuer is unresolved", () => {
    expect(resolveV9MintControlGroupSeverity({ ...sameIssuerGroup(2), controllerIssuerKey: null })).toBe("high");
  });

  it("fails closed (high) when any member asset issuer is unresolved", () => {
    expect(resolveV9MintControlGroupSeverity({
      controllerIssuerKey: "issuer:circle",
      members: [
        { assetId: "usdc-circle", pathKey: "mint:a", assetIssuerKey: "issuer:circle" },
        { assetId: "unknown-product", pathKey: "mint:b", assetIssuerKey: null },
      ],
    })).toBe("high");
  });

  it("fails closed (high) when a resolved controller has no members", () => {
    expect(resolveV9MintControlGroupSeverity({ controllerIssuerKey: "issuer:circle", members: [] })).toBe("high");
  });

  it("preserves diagnostic severity under a disjoint split of the same members", () => {
    const merged = sameIssuerGroup(4);
    const split = [merged.members.slice(0, 2), merged.members.slice(2)].map((members) => ({
      controllerIssuerKey: merged.controllerIssuerKey,
      members,
    }));
    expect(resolveV9MintControlGroupSeverity(merged)).toBe("low");
    expect(split.map((group) => resolveV9MintControlGroupSeverity(group))).toEqual(["low", "low"]);
  });
});

describe("Reshape-v2 D2 — parent-controlled common-mode dedup", () => {
  const serialPaths = [
    {
      assetId: "steakusdt-steakhouse",
      upstreamAssetId: "usdt-tether",
      edgeKey: "wrap",
      exposureKey: "wrap:exposure",
      riskEventKey: "wrap:risk",
      evidenceRefIds: [],
      dependencyType: "wrapper" as const,
      role: "serial-claim" as const,
      weight: 1,
      failureDomains: [],
    },
    {
      assetId: "basket-holder",
      upstreamAssetId: "usdt-tether",
      edgeKey: "basket",
      exposureKey: "basket:exposure",
      riskEventKey: "basket:risk",
      evidenceRefIds: [],
      dependencyType: "collateral" as const,
      role: "basket-exposure" as const,
      weight: 0.4,
      failureDomains: [],
    },
  ] satisfies V9DependencyPathPlan[];

  it("extracts the controller asset id only from asset-keyed control domains", () => {
    expect(v9ControlAssetDomainId({ kind: "mint-control", key: "asset:usdt-tether" })).toBe("usdt-tether");
    expect(v9ControlAssetDomainId({ kind: "upgrade-control", key: "asset:usdc-circle" })).toBe("usdc-circle");
    expect(v9ControlAssetDomainId({ kind: "mint-control", key: "safe:ethereum:0x0a0e" })).toBeNull();
    expect(v9ControlAssetDomainId({ kind: "bridge-route", key: "asset:usdt-tether" })).toBeNull();
  });

  it("defers to the parent cap only for serial-claim children of the domain asset", () => {
    expect(isV9ParentControlledCommonModeMember("steakusdt-steakhouse", "usdt-tether", serialPaths)).toBe(true);
    // Basket exposure is not a required-parent relationship: the shared-controller risk stays priced.
    expect(isV9ParentControlledCommonModeMember("basket-holder", "usdt-tether", serialPaths)).toBe(false);
    // A different upstream never matches, and a null domain id never dedups.
    expect(isV9ParentControlledCommonModeMember("steakusdt-steakhouse", "usdc-circle", serialPaths)).toBe(false);
    expect(isV9ParentControlledCommonModeMember("steakusdt-steakhouse", null, serialPaths)).toBe(false);
  });

  it("does not create a reverse dependency from downstream controller reuse", () => {
    expect(isV9ControllerOwnedCommonModeMember("usdt-tether", "usdt-tether", serialPaths)).toBe(true);
    expect(isV9ControllerOwnedCommonModeMember("steakusdt-steakhouse", "usdt-tether", serialPaths)).toBe(true);
    expect(isV9ControllerOwnedCommonModeMember("basket-holder", "usdt-tether", serialPaths)).toBe(false);
    expect(isV9ControllerOwnedCommonModeMember("foreign-product", "usdt-tether", serialPaths)).toBe(false);
  });
});
