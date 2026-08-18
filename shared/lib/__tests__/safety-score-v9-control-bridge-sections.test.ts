import { describe, expect, it } from "vitest";
import type { V9DeploymentControlFactV2, V9FactStatusV2, V9FailureDomainRef } from "../../types/safety-score-v9-facts";
import {
  evaluateV9EconomicControl,
  type EvaluateV9EconomicControlArgs,
  type V9BridgeControlReview,
  type V9EconomicControlAssetFacts,
  type V9MintMechanismReview,
  type V9OracleControlReview,
} from "../safety-score-v9/control";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

const MATERIAL_SHARE_THRESHOLD = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;

function requiredKnown(rule = "fixture.required"): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
    observationState: "known",
    evidenceRefIds: [`evidence:${rule}`],
    gapIds: [],
  };
}

function notApplicable(rule = "fixture.not-applicable"): V9FactStatusV2 {
  return {
    applicability: {
      state: "not-applicable",
      policyRuleId: rule,
      rationale: "Reviewed as not applicable.",
      gapId: null,
    },
    observationState: "known",
    evidenceRefIds: [],
    gapIds: [],
  };
}

function boundedUnknown(rule = "fixture.bounded-unknown"): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
    observationState: "bounded-unknown",
    evidenceRefIds: [`evidence:${rule}`],
    gapIds: [`gap:${rule}`],
  };
}

function missingObservation(rule = "fixture.missing"): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: rule, rationale: null, gapId: null },
    observationState: "missing",
    evidenceRefIds: [],
    gapIds: [`gap:${rule}`],
  };
}

function failureDomain(kind: V9FailureDomainRef["kind"], key: string): V9FailureDomainRef {
  return { kind, key };
}

function bridgeControl(
  controlKey: string,
  overrides: Partial<V9DeploymentControlFactV2> = {},
): V9DeploymentControlFactV2 {
  return {
    controlKey,
    deploymentKey: `deployment:${controlKey}`,
    sourceGenerationId: "research:fixture",
    controlKind: "bridge",
    scope: "deployment",
    status: requiredKnown(`control.${controlKey}`),
    capabilities: ["bridge-mint"],
    capSemantics: { kind: "bounded", bound: { amount: 0.1, unit: "supply-fraction" } },
    claimImpairment: "bounded",
    economicLossScope: "deployment",
    authority: {
      authorityKey: `authority:${controlKey}`,
      model: "multisig",
      threshold: { required: 2, total: 3 },
    },
    delaySec: 86_400,
    materialSupplyShare: null,
    keyCustody: "unknown",
    modulesOrGuards: "unknown",
    incidentState: "none",
    failureDomains: [failureDomain("bridge-route", controlKey)],
    ...overrides,
  };
}

function noMint(): V9MintMechanismReview {
  return {
    status: notApplicable("mint"),
    controlKey: null,
    reconciliation: "not-applicable",
    supervision: "unknown",
    upgrade: { state: "not-applicable", controlKey: null },
  };
}

function noOracle(): V9OracleControlReview {
  return { status: notApplicable("oracle"), tier: null, branches: [] };
}

function noBridge(): V9BridgeControlReview {
  return { status: notApplicable("bridge"), routes: [] };
}

function baseFacts(controls: readonly V9DeploymentControlFactV2[] = []): V9EconomicControlAssetFacts {
  return {
    assetId: "fixture-asset",
    archetype: "fiat-cash",
    controlStatus: controls.length > 0 ? requiredKnown("controls") : notApplicable("controls"),
    controls,
    supply: {
      status: requiredKnown("supply"),
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: 1,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 0,
    },
  };
}

function args(overrides: Partial<EvaluateV9EconomicControlArgs> = {}): EvaluateV9EconomicControlArgs {
  return {
    policy: V9_CANDIDATE_POLICY_V1,
    facts: baseFacts(),
    mint: noMint(),
    oracle: noOracle(),
    bridge: noBridge(),
    ...overrides,
  };
}

/**
 * One reviewed, known bridge route under a bounded ("bounded-unknown") bridge
 * review, with the supply the compiler could not attribute expressed as
 * `unknownRouteSupplyShare` / `unreviewedRouteSupplyShare`.
 */
function boundedReviewResult(
  unattributedShare: number | null,
  options: { selectSupplyRow?: boolean; supplyKnown?: boolean } = {},
) {
  const selectSupplyRow = options.selectSupplyRow ?? true;
  const supplyKnown = options.supplyKnown ?? true;
  const reviewedShare = unattributedShare === null ? 1 : 1 - unattributedShare;
  const reviewed = bridgeControl("bridge:reviewed", {
    deploymentKey: "ethereum:0xreviewed",
    materialSupplyShare: reviewedShare,
  });
  return evaluateV9EconomicControl(
    args({
      facts: {
        ...baseFacts([reviewed]),
        supply: {
          status: supplyKnown ? requiredKnown("supply") : boundedUnknown("supply"),
          selectedBridgeRoutes: selectSupplyRow
            ? [
                {
                  deploymentRouteKey: reviewed.deploymentKey,
                  supplyUsd: reviewedShare * 100,
                  supplyShare: reviewedShare,
                  reviewState: "selected-reviewed",
                  reviewedRouteKind: "controlled",
                },
              ]
            : [],
          selectedRouteSupplyShare: reviewedShare,
          unknownRouteSupplyShare: unattributedShare,
          unreviewedRouteSupplyShare: unattributedShare === null ? null : 0,
        },
      },
      bridge: {
        status: boundedUnknown("bridge"),
        routes: [{ controlKey: reviewed.controlKey, tier: "issuer-native-burn-mint" }],
      },
    }),
  );
}

const REVIEWED_COMPONENT_KEY = "bridge:ethereum:0xreviewed:bridge:reviewed";

describe("Safety Score v9 control bridge sections", () => {
  it("keeps a bounded bridge review's reviewed rows when the unattributed supply is immaterial", () => {
    const result = boundedReviewResult(0.02);

    expect(result.components.map((component) => component.componentKey)).toContain(REVIEWED_COMPONENT_KEY);
    expect(result.components.some((component) => component.componentKey === "bridge:unverified")).toBe(false);
    // The bounded review still carries its reason-coded ceiling.
    expect(result.reasons.map((reason) => reason.code)).toContain("runtime-bridge-materiality-unavailable");
  });

  it("fails closed when the unattributed supply of a bounded bridge review is material", () => {
    expect(MATERIAL_SHARE_THRESHOLD).toBeLessThanOrEqual(0.2);
    const result = boundedReviewResult(0.2);

    expect(result.components).toContainEqual(expect.objectContaining({ componentKey: "bridge:unverified" }));
    expect(result.components.map((component) => component.componentKey)).not.toContain(REVIEWED_COMPONENT_KEY);
    expect(result.reasons.map((reason) => reason.code)).toContain("runtime-bridge-materiality-unavailable");
  });

  it("fails closed when the unattributed supply share of a bounded bridge review is unavailable", () => {
    const result = boundedReviewResult(null);

    expect(result.components).toContainEqual(expect.objectContaining({ componentKey: "bridge:unverified" }));
    expect(result.components.map((component) => component.componentKey)).not.toContain(REVIEWED_COMPONENT_KEY);
    expect(result.reasons.map((reason) => reason.code)).toContain("runtime-bridge-materiality-unavailable");
  });

  it("fails closed when no supply partition produced bridge shares at all", () => {
    // A null share means no supply partition exists for the asset, never that the
    // partition ran and found no bridge route. It must not be read as a zero.
    const result = boundedReviewResult(null, { selectSupplyRow: false });

    expect(result.components).toContainEqual(expect.objectContaining({ componentKey: "bridge:unverified" }));
    expect(result.components.map((component) => component.componentKey)).not.toContain(REVIEWED_COMPONENT_KEY);
  });

  it("keeps a missing bridge observation on the unverified fallback", () => {
    const result = evaluateV9EconomicControl(
      args({
        bridge: { status: missingObservation("bridge"), routes: [] },
      }),
    );

    expect(result.components).toContainEqual(expect.objectContaining({ componentKey: "bridge:unverified" }));
    expect(result.reasons.map((reason) => reason.code)).toContain("missing-bridge-routes");
  });
});
