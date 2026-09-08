import { describe, expect, it } from "vitest";
import type { V9AssetFactsBase, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import {
  assessV9ControlDomainScope,
  deploymentControlDomainSeverity,
  type V9SupplyChainExposure,
} from "../safety-score-v9/evaluate-set";
import type { V9CommonModeMember } from "../safety-score-v9/dependencies";
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
