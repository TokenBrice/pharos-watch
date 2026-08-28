import { describe, expect, it } from "vitest";
import type { V9DeploymentControlFactV2 } from "../../types/safety-score-v9-facts";
import { evaluateV9EconomicControl } from "../safety-score-v9/control";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  boundedUnknown,
  makeEconomicControlArgs as args,
  makeEconomicControlFacts as baseFacts,
  makeDeploymentControl,
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
        bridge: { status: missing("bridge"), routes: [] },
      }),
    );

    expect(result.components).toContainEqual(expect.objectContaining({ componentKey: "bridge:unverified" }));
    expect(result.reasons.map((reason) => reason.code)).toContain("missing-bridge-routes");
  });
});
