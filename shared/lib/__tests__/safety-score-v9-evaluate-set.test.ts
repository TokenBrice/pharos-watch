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

  it("keeps an unresolved liability partition at global-claim scope", () => {
    const assessment = assessV9ControlDomainScope(
      DOMAIN,
      [MEMBER],
      assetWithControl({ materialSupplyShare: null }),
      supplyExposure({ complete: false }),
    );

    expect(assessment).toEqual({
      economicLossScope: "global-claim",
      deploymentKeys: [],
      materialShare: null,
    });
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
