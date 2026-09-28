import { describe, expect, it } from "vitest";
import type { V9DeploymentControlFactV2 } from "../../types/safety-score-v9-facts";
import { evaluateV9EconomicControl } from "../safety-score-v9/control";
import { provenNullShareDeploymentBound } from "../safety-score-v9/control-bridge-join";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  boundedUnknown,
  makeEconomicControlArgs as args,
  makeEconomicControlFacts as baseFacts,
  makeDeploymentControl,
  makeSupplyPartition,
  missing,
  requiredKnown,
} from "./safety-score-v9-fixtures.test-support";

const MATERIAL_SHARE_THRESHOLD = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;

function bridgeControl(
  controlKey: string,
  overrides: Partial<V9DeploymentControlFactV2> = {},
): V9DeploymentControlFactV2 {
  return makeDeploymentControl(controlKey, "bridge", {
    scope: "deployment",
    economicLossScope: "deployment",
    ...overrides,
  });
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
        supply: makeSupplyPartition({
          status: supplyKnown ? requiredKnown("supply") : boundedUnknown("supply"),
          routes: selectSupplyRow
            ? [
                {
                  deploymentRouteKey: reviewed.deploymentKey,
                  supplyShare: reviewedShare,
                  reviewState: "selected-reviewed",
                  reviewedRouteKind: "controlled",
                },
              ]
            : [],
          selectedRouteSupplyShare: reviewedShare,
          unknownRouteSupplyShare: unattributedShare,
          unreviewedRouteSupplyShare: unattributedShare === null ? null : 0,
        }),
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
        bridge: { status: missing("bridge"), routes: [] },
      }),
    );

    expect(result.components).toContainEqual(expect.objectContaining({ componentKey: "bridge:unverified" }));
    expect(result.reasons.map((reason) => reason.code)).toContain("missing-bridge-routes");
  });

  it("bounds a null-share deployment on an ambiguous chain by the unsplit chain row", () => {
    const control = bridgeControl("bridge:xlayer", {
      deploymentKey: "xlayer:0x74b7f16337b8972027f6196a17a631ac6de26d22",
    });
    const factsWithAmbiguousRow = (ambiguousShare: number) => ({
      ...baseFacts([control]),
      supply: makeSupplyPartition({
        routes: [
          {
            deploymentRouteKey: "ethereum:0xnative",
            supplyShare: 1 - ambiguousShare,
            reviewState: "selected-reviewed",
            reviewedRouteKind: "native",
          },
          {
            deploymentRouteKey: "ambiguous-chain:fixture-asset:xlayer",
            supplyShare: ambiguousShare,
            reviewState: "unmatched",
          },
        ],
      }),
    });
    const materialityPath = `control:${control.controlKey}:materiality`;

    const immaterialFacts = factsWithAmbiguousRow(0.0002);
    expect(provenNullShareDeploymentBound(immaterialFacts, control)).toBeCloseTo(0.0002, 12);
    expect(
      evaluateV9EconomicControl(args({ facts: immaterialFacts })).reasons.map((reason) => reason.path),
    ).not.toContain(materialityPath);

    // The unsplit chain row is an upper bound, not a zero: a material row keeps
    // the null-share deployment fail-closed.
    const materialFacts = factsWithAmbiguousRow(0.2);
    expect(provenNullShareDeploymentBound(materialFacts, control)).toBeCloseTo(0.2, 12);
    expect(evaluateV9EconomicControl(args({ facts: materialFacts })).reasons).toContainEqual(
      expect.objectContaining({ code: "runtime-bridge-materiality-unavailable", path: materialityPath }),
    );
  });
});
