import { describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type {
  V9AdverseAttribution,
  V9BoundedUncertaintyAttribution,
} from "../safety-score-v9/formula";
import {
  propagateV9SerialParentBoundedUncertaintyAttribution,
  propagateV9SerialParentAdverseAttribution,
  resolveV9SerialParentBoundedUncertaintyAttribution,
  resolveV9SerialParentAdverseAttribution,
  scoreV9EvaluatedAsset,
  type V9ProductionScoreInput,
} from "../safety-score-v9/score";
import { computeV9ResultDigest, projectCompactV9ScoreTrace } from "../safety-score-v9/trace";
import { makeV9Pillar as pillar, makeV9ProductionScoreInput } from "./safety-score-v9-score.test-support";

const DIGEST = "a".repeat(64);
const BUILD_DIGEST = "b".repeat(64);
const BASE_ID = `report-cards-input:v1:${"c".repeat(64)}`;

function input(overrides: Partial<V9ProductionScoreInput> = {}): V9ProductionScoreInput {
  const identity = makeV9ProductionScoreInput().identity;
  return makeV9ProductionScoreInput({
    ...overrides,
    identity: {
      ...identity,
      sourceGenerations: { peg: "peg:1", dex: "dex:1" },
      ...overrides.identity,
    },
  });
}

const ROOT_ADVERSE: V9AdverseAttribution = {
  source: "structural-signal",
  path: "structural:active-control-incident:critical",
  message: "A measured control incident drives the root score.",
  responsibility: "measured-adverse",
};

const ROOT_BOUNDED_UNCERTAINTY: V9BoundedUncertaintyAttribution = {
  source: "reason",
  code: "bounded-mechanism-review",
  path: "backing:mechanism:custody-continuity",
  message: "A bounded backing component remains unresolved.",
  responsibility: "integration-missing",
  boundedness: "exposure-bounded",
};

describe("scoreV9EvaluatedAsset", () => {
  it("threads an optional counterfactual aggregation strategy", () => {
    const trace = scoreV9EvaluatedAsset(
      input({ pillars: { backing: pillar(50), exit: pillar(80), control: pillar(100) } }),
      V9_CANDIDATE_POLICY_V1,
      (pillars, weights) => {
        const score = pillars.backing * weights.backing
          + pillars.exit * weights.exit
          + pillars.control * weights.control;
        return {
          method: "smooth-bounded-headroom",
          score,
          weightedQuality: score,
          weakestPillar: "backing",
          weakestScore: pillars.backing,
        };
      },
    );

    expect(trace.finalScore).toBe(73);
  });

  it("binds the score to fact, policy, build, clock, and source identities", () => {
    const trace = scoreV9EvaluatedAsset(input(), V9_CANDIDATE_POLICY_V1);
    expect(trace).toMatchObject({
      finalScore: 95,
      finalGrade: "A+",
      factSetDigest: DIGEST,
      baseInputGenerationId: BASE_ID,
      evaluationBuildDigest: BUILD_DIGEST,
      asOfSec: 1_000,
      sourceGenerations: { dex: "dex:1", peg: "peg:1" },
    });
  });

  it("does not redistribute a missing pillar", () => {
    const trace = scoreV9EvaluatedAsset(
      input({ pillars: { backing: pillar(100), exit: pillar(null), control: pillar(100) } }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons.map((reason) => reason.code)).toContain("missing-pillar");
  });

  it("rejects conflicting owners for one public fact identity", () => {
    const reasons = [
      {
        code: "bounded-mechanism-review" as const,
        path: "backing:mechanism:custody",
        message: "Custody evidence is unresolved.",
        responsibility: "issuer-undisclosed" as const,
      },
      {
        code: "bounded-mechanism-review" as const,
        path: "backing:mechanism:custody",
        message: "Custody evidence is unresolved.",
        responsibility: "producer-failed" as const,
      },
    ];
    expect(() =>
      scoreV9EvaluatedAsset(
        input({
          pillars: {
            backing: pillar(70, { reasons }),
            exit: pillar(95),
            control: pillar(95),
          },
        }),
        V9_CANDIDATE_POLICY_V1,
      ),
    ).toThrow(/multiple causal owners/);
  });

  it("applies continuous weakest-path aggregation without a hard cap", () => {
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(30, {
            structuralSignals: [{
              kind: "unsafe-backing",
              severity: "moderate",
              reason: "A known backing failure drives the weak path.",
              responsibility: "measured-adverse",
              pricedInPillar: "backing",
              failureDomainKeys: ["reserve-issuer:fixture"],
              evidence: [],
            }],
          }),
          exit: pillar(100),
          control: pillar(100),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(trace.finalScore).toBe(49);
    expect(trace.aggregation).toMatchObject({
      method: "smooth-bounded-headroom",
      weakestPillar: "backing",
      headroom: 20,
    });
    expect(trace.bindingCap).toBeNull();
    expect(trace.caps.map((cap) => cap.kind)).not.toContain("bounded-compensability");
  });

  it("resolves reason-coded critical facts and evidence ceilings through policy", () => {
    const critical = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(90, {
            reasons: [{
              code: "missing-pillar-evidence",
              path: "reserve",
              message: "Missing review",
              responsibility: "integration-missing",
            }],
          }),
          exit: pillar(90),
          control: pillar(90),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(critical.finalGrade).toBe("NR");

    const bounded = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(90, {
            reasons: [{
              code: "material-unknown-reserve-exposure",
              path: "reserve:slice",
              message: "Bounded unknown",
              responsibility: "issuer-undisclosed",
            }],
          }),
          exit: pillar(90),
          control: pillar(90),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(bounded.finalScore).toBe(69);
    expect(bounded.bindingCap?.kind).toBe("reason:material-unknown-reserve-exposure");
  });

  it("keeps a child rateable when a measured D parent cap binds", () => {
    const propagatedAdverseAttribution = resolveV9SerialParentAdverseAttribution(
      45,
      [{
        upstreamAssetId: "root",
        score: 45,
        blocked: false,
        adverseAttribution: [ROOT_ADVERSE],
      }],
    );
    const trace = scoreV9EvaluatedAsset(
      input({
        assetId: "child",
        parent: {
          required: true,
          score: 45,
          propagatedReasons: [],
          propagatedAdverseAttribution,
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(45);
    expect(trace.finalGrade).toBe("D");
    expect(trace.bindingCap?.source).toBe("parent");
    expect(trace.adverseAttribution).toEqual([
      {
        source: "parent-score",
        path: `parent:root:${ROOT_ADVERSE.path}`,
        message: `Required parent root: ${ROOT_ADVERSE.message}`,
        responsibility: "measured-adverse",
      },
    ]);
  });

  it("keeps a child rateable when a bounded-uncertainty D parent cap binds", () => {
    const propagatedBoundedUncertaintyAttribution =
      resolveV9SerialParentBoundedUncertaintyAttribution(
        45,
        [{
          upstreamAssetId: "root",
          score: 45,
          blocked: false,
          boundedUncertaintyAttribution: [ROOT_BOUNDED_UNCERTAINTY],
        }],
      );
    const trace = scoreV9EvaluatedAsset(
      input({
        assetId: "child",
        parent: {
          required: true,
          score: 45,
          propagatedReasons: [],
          propagatedBoundedUncertaintyAttribution,
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(45);
    expect(trace.finalGrade).toBe("D");
    expect(trace.bindingCap?.source).toBe("parent");
    expect(trace.adverseAttribution).toEqual([]);
    expect(trace.boundedUncertaintyAttribution).toEqual([
      {
        ...ROOT_BOUNDED_UNCERTAINTY,
        source: "parent-score",
        path: `parent:root:${ROOT_BOUNDED_UNCERTAINTY.path}`,
        message: `Required parent root: ${ROOT_BOUNDED_UNCERTAINTY.message}`,
      },
    ]);
    expect(
      propagateV9SerialParentBoundedUncertaintyAttribution(
        "root",
        propagatedBoundedUncertaintyAttribution,
      ),
    ).toEqual(propagatedBoundedUncertaintyAttribution);
  });

  it("retains a rateable upstream evidence ceiling through a serial parent cap", () => {
    const parentUncertainty: V9BoundedUncertaintyAttribution = {
      source: "reason",
      code: "missing-reserve-composition",
      path: "backing:reserve-envelope",
      message: "The parent's reserve composition is missing.",
      responsibility: "integration-missing",
      boundedness: "globally-bounded",
    };
    const propagatedBoundedUncertaintyAttribution =
      resolveV9SerialParentBoundedUncertaintyAttribution(
        60,
        [{
          upstreamAssetId: "buidl-like-parent",
          score: 60,
          blocked: false,
          boundedUncertaintyAttribution: [parentUncertainty],
        }],
      );
    const trace = scoreV9EvaluatedAsset(
      input({
        assetId: "serial-child",
        parent: {
          required: true,
          score: 60,
          propagatedReasons: [],
          propagatedBoundedUncertaintyAttribution,
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(60);
    expect(trace.bindingCap).toMatchObject({ source: "parent", limit: 60 });
    expect(trace.boundedUncertaintyAttribution).toContainEqual({
      ...parentUncertainty,
      source: "parent-score",
      path: `parent:buidl-like-parent:${parentUncertainty.path}`,
      message: `Required parent buidl-like-parent: ${parentUncertainty.message}`,
    });
  });

  it("propagates nested wrapper attribution once per serial edge", () => {
    const rootAttribution = propagateV9SerialParentAdverseAttribution(
      "root",
      [ROOT_ADVERSE],
    );
    const middle = scoreV9EvaluatedAsset(
      input({
        assetId: "middle",
        parent: {
          required: true,
          score: 45,
          propagatedReasons: [],
          propagatedAdverseAttribution: rootAttribution,
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    const childAttribution = resolveV9SerialParentAdverseAttribution(
      45,
      [{
        upstreamAssetId: "middle",
        score: 45,
        blocked: false,
        adverseAttribution: middle.adverseAttribution,
      }],
    );
    const child = scoreV9EvaluatedAsset(
      input({
        assetId: "child",
        parent: {
          required: true,
          score: 45,
          propagatedReasons: [],
          propagatedAdverseAttribution: childAttribution,
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(child.finalGrade).toBe("D");
    expect(child.adverseAttribution).toHaveLength(1);
    expect(child.adverseAttribution[0]?.path).toBe(
      `parent:middle:parent:root:${ROOT_ADVERSE.path}`,
    );
    expect(
      propagateV9SerialParentAdverseAttribution("middle", childAttribution),
    ).toEqual(childAttribution);
  });

  it("does not invent parent attribution for unavailable or noncausal parents", () => {
    const unavailable = scoreV9EvaluatedAsset(
      input({
        parent: {
          required: true,
          score: null,
          propagatedReasons: [],
          propagatedAdverseAttribution:
            propagateV9SerialParentAdverseAttribution("root", [ROOT_ADVERSE]),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    const unattributed = scoreV9EvaluatedAsset(
      input({
        parent: {
          required: true,
          score: 45,
          propagatedReasons: [],
          propagatedAdverseAttribution: [],
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    const nonbinding = resolveV9SerialParentAdverseAttribution(
      45,
      [{
        upstreamAssetId: "higher-parent",
        score: 50,
        blocked: false,
        adverseAttribution: [ROOT_ADVERSE],
      }],
    );
    const childLowerThanParent = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(45, {
            structuralSignals: [{
              kind: "unsafe-backing",
              severity: "moderate",
              reason: "A measured local backing weakness drives the child score.",
              responsibility: "measured-adverse",
              pricedInPillar: "backing",
              failureDomainKeys: ["reserve-issuer:child"],
              evidence: [],
            }],
          }),
          exit: pillar(45),
          control: pillar(45),
        },
        parent: {
          required: true,
          score: 50,
          propagatedReasons: [],
          propagatedAdverseAttribution:
            propagateV9SerialParentAdverseAttribution("root", [ROOT_ADVERSE]),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(unavailable.finalGrade).toBe("NR");
    expect(unavailable.adverseAttribution).toEqual([]);
    expect(unattributed.bindingCap?.source).toBe("parent");
    expect(unattributed.finalGrade).toBe("NR");
    expect(unattributed.adverseAttribution).toEqual([]);
    expect(unattributed.boundedUncertaintyAttribution).toEqual([]);
    expect(nonbinding).toEqual([]);
    expect(childLowerThanParent.finalGrade).toBe("D");
    expect(childLowerThanParent.bindingCap).toBeNull();
    expect(
      childLowerThanParent.adverseAttribution.some(
        (item) => item.source === "parent-score",
      ),
    ).toBe(false);
  });

  it("creates stable compact traces and result digests across input order", () => {
    const left = scoreV9EvaluatedAsset(input({ assetId: "left" }), V9_CANDIDATE_POLICY_V1);
    const right = scoreV9EvaluatedAsset(input({ assetId: "right" }), V9_CANDIDATE_POLICY_V1);
    expect(projectCompactV9ScoreTrace(left)).toMatchObject({ assetId: "left", score: 95, grade: "A+" });
    expect(computeV9ResultDigest([left, right])).toBe(computeV9ResultDigest([right, left]));
  });
});
