import { describe, expect, it } from "vitest";
import type { V9DeploymentControlFactV2 } from "../../types/safety-score-v9-facts";
import { evaluateV9EconomicControl } from "../safety-score-v9/control";
import { resolveV9ScopedRisk } from "../safety-score-v9/scoped-risk";
import { provenNullShareDeploymentBound } from "../safety-score-v9/control-bridge-join";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  boundedUnknown,
  makeEconomicControlArgs as args,
  makeEconomicControlFacts as baseFacts,
  makeDeploymentControl,
  makeSupplyPartition,
  missing,
  notApplicable,
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
  it("does not invent bridge risk from retained unmatched dust after native-census admission", () => {
    const share = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.nativeInventoryUnmatchedDustShareMax;
    const supply = makeSupplyPartition({
      routes: [
        { deploymentRouteKey: "ethereum:0xnative", supplyShare: 1 - share,
          reviewState: "selected-reviewed", reviewedRouteKind: "native" },
        { deploymentRouteKey: "unmatched-chain:fixture-asset:tempo", supplyShare: share,
          reviewState: "unmatched" },
      ],
      selectedRouteSupplyShare: 1 - share,
      unreviewedRouteSupplyShare: 0,
      unknownRouteSupplyShare: share,
    });
    const before = structuredClone(supply);
    const facts = { ...baseFacts([]), supply };
    const admitted = evaluateV9EconomicControl(args({
      facts, bridge: { status: notApplicable("reviewed-native-census"), routes: [] },
    }));
    expect(admitted.components.filter((component) => component.componentKey.startsWith("bridge:"))).toEqual([
      expect.objectContaining({ componentKey: "bridge:native", score: V9_CANDIDATE_POLICY_V1.policy.semantic.control.bridgeTierQuality["single-chain-or-native"] }),
    ]);
    expect(admitted.reasons.map((reason) => reason.code)).not.toContain("missing-bridge-routes");
    const unadmitted = evaluateV9EconomicControl(args({
      facts, bridge: { status: missing("missing-native-census"), routes: [] },
    }));
    expect(unadmitted.components).toContainEqual(expect.objectContaining({ componentKey: "bridge:unverified" }));
    expect(supply).toEqual(before);
  });
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

  it("proves a null-share bridge deployment immaterial from a <10% census upper bound without publishing it as a share", () => {
    const deploymentKey = "base:0x1111111111111111111111111111111111111111";
    const control = bridgeControl("bridge:census-immaterial", {
      deploymentKey, materialSupplyShare: null, failureDomains: [{ kind: "bridge-route", key: deploymentKey }],
    });
    const makeFacts = (boundShare: number, supplyStatus = requiredKnown("supply")) => ({
      ...baseFacts([control]),
      supply: makeSupplyPartition({
        status: supplyStatus,
        routes: [
          { deploymentRouteKey: "ethereum:0xnative", supplyShare: 1 - boundShare - 0.01, reviewState: "selected-reviewed", reviewedRouteKind: "native" },
          { deploymentRouteKey: deploymentKey, supplyShare: boundShare, reviewState: "selected-reviewed", reviewedRouteKind: "controlled", evidenceKind: "upper-bound" },
          { deploymentRouteKey: "ambiguous-chain:fixture-asset:base", supplyShare: 0.01, reviewState: "unmatched" },
        ],
      }),
    });
    const evalCtrl = (facts: ReturnType<typeof makeFacts>, status = requiredKnown("bridge")) =>
      evaluateV9EconomicControl(args({ facts, bridge: { status, routes: [{ controlKey: control.controlKey, tier: "external-lock-mint" }] } }));

    const subFacts = makeFacts(0.05);
    expect(provenNullShareDeploymentBound(subFacts, control)).toBeCloseTo(0.05, 12);
    const sub = evalCtrl(subFacts, boundedUnknown("bridge"));
    expect(sub.reasons.map((r) => r.code)).not.toContain("runtime-bridge-materiality-unavailable");
    expect(sub.components.find((c) => c.controlKeys.includes(control.controlKey))?.binding).toBe(false);
    expect(sub.failureDomains.some((d) => d.key === deploymentKey)).toBe(false);
    expect(sub.structuralFailures).toContainEqual(expect.objectContaining({ kind: "peripheral-bridge", binding: false, materialSharePct: null }));
    expect(sub.controlFacts?.find((c) => c.controlKey === control.controlKey)?.materialSupplyShare).toBeNull();

    const at = evalCtrl(makeFacts(MATERIAL_SHARE_THRESHOLD));
    expect(at.reasons.map((r) => r.code)).toContain("runtime-bridge-materiality-unavailable");
    expect(at.components.find((c) => c.controlKeys.includes(control.controlKey))?.binding).toBe(true);
    expect(at.structuralFailures).toContainEqual(expect.objectContaining({ kind: "material-bridge", binding: true, materialSharePct: null }));

    const staleFacts = makeFacts(0.05, boundedUnknown("supply"));
    expect(provenNullShareDeploymentBound(staleFacts, control)).toBeNull();
    const stale = evalCtrl(staleFacts);
    expect(stale.reasons.map((r) => r.code)).toContain("runtime-bridge-materiality-unavailable");
    expect(stale.components.find((c) => c.controlKeys.includes(control.controlKey))?.binding).toBe(true);
  });

  it("caps lapsed bridge", () => {
    const c = bridgeControl("b:r", { deploymentKey: "b:1", materialSupplyShare: 0.05 }), f = (b: ReturnType<typeof args>["bridge"], facts = baseFacts()) => evaluateV9EconomicControl(args({ facts, bridge: b }));
    const u = (l?: true) => f({ status: missing("bridge"), ...(l ? { lapsedReview: l } : {}), routes: [] }).components.find((k) => k.kind === "bridge")?.score, r = f({ status: requiredKnown("bridge"), routes: [{ controlKey: "b:r", tier: "opaque-or-unknown", lapsedReview: true }] }, baseFacts([c]));
    const inc = (s: number) => { const x = f({ status: boundedUnknown("bridge"), lapsedReview: true, routes: [] }, baseFacts([bridgeControl("b:i", { deploymentKey: "k:1", materialSupplyShare: s, incidentState: "active", status: boundedUnknown("control") })])); return [x.score, x.components.find((k) => k.controlKeys[0] === "b:i")?.binding]; };
    const sl = (k: string, exposureShare: number) => ({ signalKey: k, exposureKey: k, riskEventKey: k, failureDomainKeys: [k], economicLossScope: "deployment" as const, exposureShare, exposedScore: 45, reason: k }), add = resolveV9ScopedRisk(60, [sl("b1", 0.2), sl("l:b2", 0.12)]);
    expect([u(), u(true), r.components.find((x) => x.kind === "bridge")?.score, r.reasons.some((x) => x.code === "selected-bridge-route-unresolved"), ...inc(0.2), ...inc(0.05), add.adjustments.length, +add.finalScore.toFixed(2)]).toEqual([60, 45, 45, true, 25, true, 45, false, 2, 55.2]);
  });
});
