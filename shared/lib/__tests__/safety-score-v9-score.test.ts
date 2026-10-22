import { describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { aggregateV9SmoothBoundedHeadroom } from "../safety-score-v9/aggregation";
import { unknownQuality } from "../safety-score-v9/policy";
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
import type { V9StructuralSignal } from "../../types/safety-score-v9";

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
  cause: "U",
  causeGapIds: ["root:gap:custody-continuity"],
};

describe("scoreV9EvaluatedAsset", () => {
  it.each([
    { severity: "high" as const, exposedQuality: 64 },
    { severity: "moderate" as const, exposedQuality: 79 },
  ])("restores $severity shared-chain quality as proportional loss, not a cap", ({ severity, exposedQuality }) => {
    const signal: V9StructuralSignal = {
      kind: "critical-dependency", severity, reason: "Measured independent chain concentration.",
      economicLossScope: "deployment", responsibility: "measured-adverse",
      materialSharePct: 50, exposureKey: "slice:chain", riskEventKey: "chain:failure",
      failureDomainKeys: ["chain:fixture"], evidence: [],
    };
    const trace = scoreV9EvaluatedAsset(input({ dependencyStructuralSignals: [signal] }), V9_CANDIDATE_POLICY_V1);
    expect(trace.deploymentAdjustedScore).toBe(95 - (95 - exposedQuality) * 0.5);
    expect(trace.deploymentAdjustments[0]?.exposedScore).toBe(exposedQuality);
    expect(trace.caps).toEqual([]);
    const measured = scoreV9EvaluatedAsset(input({
      dependencyStructuralSignals: [{ ...signal, exposedScore: 40 }],
    }), V9_CANDIDATE_POLICY_V1);
    expect(measured.deploymentAdjustedScore).toBe(67.5);
    const unresolved = scoreV9EvaluatedAsset(input({
      dependencyStructuralSignals: [{ ...signal, materialSharePct: undefined, responsibility: "integration-missing" }],
    }), V9_CANDIDATE_POLICY_V1);
    expect(unresolved.deploymentAdjustedScore).toBe(95);
    expect(unresolved.unresolvedDeploymentSignals[0]?.exposureShare).toBeNull();
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

  it("rejects an unavailable included pillar without A/B admission proof", () => {
    expect(() => scoreV9EvaluatedAsset(
      input({ pillars: { backing: pillar(100), exit: pillar(null), control: pillar(100) } }),
      V9_CANDIDATE_POLICY_V1,
    )).toThrow(/included exit pillar/);
  });
  it.each(["A", "B", "C", "U"] as const)("keeps implementation-age cause %s distinct from known young history", (cause) => {
    const trace = scoreV9EvaluatedAsset(input({
      trackRecordMonths: null,
      methodologyReasons: [{
        code: "missing-implementation-date", path: "implementation:launch-date", message: "Launch date is unavailable.",
        responsibility: cause === "A" ? "producer-failed" : cause === "B" ? "public-data-uncurated" : cause === "C" ? "issuer-undisclosed" : "unresearched",
        cause, causeGapIds: ["gap:launch-date"],
      }],
    }), V9_CANDIDATE_POLICY_V1);
    expect(trace.finalScore).toBe(95);
    expect(trace.ratingStatus).toBe("rated");
    expect(trace.partialEvidence === null).toBe(cause === "C" || cause === "U");
    expect(trace.limitingPillars).toEqual([]);
  });
  it.each(["A", "B"] as const)("preserves whole-pillar partial evidence exclusions (%s)", (cause) => {
    const gapId = "gap:excluded-exit";
    const trace = scoreV9EvaluatedAsset(input({ pillars: {
      backing: pillar(95), control: pillar(95), exit: pillar(null, {
        aggregationDisposition: "excluded-a-b", supportedComponentKeys: [], causeGapIds: [gapId],
        excludedCauseGapIds: [gapId], excludedCauses: [cause], excludedComponentKeys: [],
      }),
    } }), V9_CANDIDATE_POLICY_V1);
    expect(trace.ratingStatus).toBe("rated");
    expect(trace.partialEvidence).toMatchObject({
      excludedPillars: ["exit"], causeGapIds: [gapId], causes: [cause],
    });
    expect(trace.limitingPillars).toEqual([]);
  });

  it.each(["A", "B"] as const)("preserves both peg and methodology A/B constraint triggers (%s)", (cause) => {
    const responsibility = cause === "A" ? "producer-failed" as const : "public-data-uncurated" as const;
    const trace = scoreV9EvaluatedAsset(input({
      peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [{
        code: "missing-peg-input", path: "peg:input", message: "Peg input is unavailable.",
        responsibility, cause, causeGapIds: ["gap:peg"],
      }] },
      methodologyReasons: [{
        code: "missing-implementation-date", path: "implementation:launch-date", message: "Launch date is unavailable.",
        responsibility, cause, sourceGapId: "gap:methodology",
      }],
    }), V9_CANDIDATE_POLICY_V1);
    expect(trace.partialEvidence).toEqual({
      reasonCode: "partial-evidence-pipeline-gap", excludedPillars: [],
      excludedComponentKeys: ["implementation:launch-date", "peg:input"],
      causeGapIds: ["gap:methodology", "gap:peg"], causes: [cause],
    });
    expect(trace.limitingPillars).toEqual([]);
  });


  it.each(["A", "B"] as const)("preserves inherited parent partial exclusions (%s)", (cause) => {
    const trace = scoreV9EvaluatedAsset(input({ parent: {
      required: true, score: 95, ratingStatus: "rated", propagatedReasons: [],
      partialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["exit"],
        excludedComponentKeys: [], causeGapIds: ["parent:gap:exit"], causes: [cause] },
    } }), V9_CANDIDATE_POLICY_V1);
    expect(trace.partialEvidence).toMatchObject({
      excludedPillars: [], excludedComponentKeys: ["dependency:parent"],
      causeGapIds: ["parent:gap:exit"], causes: [cause],
    });
    expect(trace.limitingPillars).toEqual([]);
  });


  it("does not let a raw insufficient-evidence label manufacture NR", () => {
    const trace = scoreV9EvaluatedAsset(input({ pillars: {
      backing: pillar(80, { evidenceLevel: "insufficient" }), exit: pillar(80), control: pillar(80),
    } }), V9_CANDIDATE_POLICY_V1);
    expect(trace).toMatchObject({ ratingStatus: "rated", finalScore: 80, finalGrade: "A-", nrReasons: [] });
  });

  it.each(["C", "U"] as const)("accepts real %s component bounds above the whole-pillar C- threshold", (cause) => {
    const reason = {
      code: "material-reserve-slice-unstructured" as const, path: "backing:reserve:concentration:bounded-component",
      message: "The obligor-concentration factor is unresolved.",
      responsibility: cause === "C" ? "issuer-undisclosed" as const : "unresearched" as const,
      cause, causeGapIds: ["gap:obligor-concentration"],
    };
    const trace = scoreV9EvaluatedAsset(input({ trackRecordMonths: 0, pillars: {
      backing: pillar(54.6372, { reasons: [reason], boundedComponents: [{ reason, score: 35, effectiveScoringWeight: 0.125 }] }),
      exit: pillar(35), control: pillar(58),
    } }), V9_CANDIDATE_POLICY_V1);
    expect(trace).toMatchObject({ finalGrade: "D", ratingStatus: "rated" });
    expect(trace.adverseAttribution).toEqual([]);
    expect(trace.boundedUncertaintyAttribution).toContainEqual(expect.objectContaining({
      source: "reason", code: reason.code, cause, causeGapIds: reason.causeGapIds, path: reason.path,
    }));
  });

  it.each([25, 45])("publishes an evidenced low score %s without a letter-based NR guard", (score) => {
    const trace = scoreV9EvaluatedAsset(input({
      pillars: { backing: pillar(score), exit: pillar(score), control: pillar(score) },
    }), V9_CANDIDATE_POLICY_V1);
    expect(trace.ratingStatus).toBe("rated");
    expect(trace.finalScore).toBe(score);
    expect(trace.nrReasons).toEqual([]);
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
  });

  it("bounds C/U facts without legacy critical NR or missingness ceilings", () => {
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
    expect(critical.finalGrade).toBe("A+");

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
    expect(bounded.finalScore).toBe(90);
    expect(bounded.bindingCap).toBeNull();
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

  it("retains bounded upstream uncertainty through a serial quality cap", () => {
    const parentUncertainty: V9BoundedUncertaintyAttribution = {
      source: "reason",
      code: "missing-reserve-composition",
      path: "backing:reserve-envelope",
      message: "The parent's reserve composition is missing.",
      responsibility: "integration-missing",
      boundedness: "globally-bounded",
      cause: "U",
      causeGapIds: ["parent:gap:reserve-composition"],
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
          propagatedAdverseAttribution:
            propagateV9SerialParentAdverseAttribution("root", [ROOT_ADVERSE]),
          ratingStatus: "not-rated",
          limitedEvidenceCauses: ["D"],
          propagatedReasons: [{ code: "critical-unresolved", field: "parent", message: "Measured parent insolvency", cause: "D" }],
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
    expect(unattributed.finalGrade).toBe("D");
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

  it("does not invent attribution from a blocked matching parent", () => {
    const parents = [{
      upstreamAssetId: "blocked", score: 45, blocked: true,
      adverseAttribution: [ROOT_ADVERSE],
      boundedUncertaintyAttribution: [ROOT_BOUNDED_UNCERTAINTY],
    }];
    const trace = scoreV9EvaluatedAsset(input({
      parent: {
        required: true, score: 45, propagatedReasons: [],
        propagatedAdverseAttribution: resolveV9SerialParentAdverseAttribution(45, parents),
        propagatedBoundedUncertaintyAttribution: resolveV9SerialParentBoundedUncertaintyAttribution(45, parents),
      },
    }), V9_CANDIDATE_POLICY_V1);
    expect(trace.finalGrade).toBe("D");
    expect(trace.adverseAttribution).toEqual([]);
    expect(trace.boundedUncertaintyAttribution).toEqual([]);
  });

  it("retains every causal tied parent once under reversal and duplication", () => {
    const parents = ["alpha", "beta", "higher"].map((upstreamAssetId) => ({
      upstreamAssetId, score: upstreamAssetId === "higher" ? 60 : 45, blocked: false,
      adverseAttribution: [ROOT_ADVERSE],
      boundedUncertaintyAttribution: [ROOT_BOUNDED_UNCERTAINTY],
    }));
    for (const ordered of [parents, [...parents].reverse(), [...parents, ...parents]]) {
      const trace = scoreV9EvaluatedAsset(input({
        parent: {
          required: true, score: 45, propagatedReasons: [],
          propagatedAdverseAttribution: resolveV9SerialParentAdverseAttribution(45, ordered),
          propagatedBoundedUncertaintyAttribution: resolveV9SerialParentBoundedUncertaintyAttribution(45, ordered),
        },
      }), V9_CANDIDATE_POLICY_V1);
      expect(trace.finalGrade).toBe("D");
      expect(trace.finalScore).toBe(45);
      expect(trace.adverseAttribution).toEqual(["alpha", "beta"].map((id) => ({
        ...ROOT_ADVERSE, source: "parent-score",
        path: `parent:${id}:${ROOT_ADVERSE.path}`,
        message: `Required parent ${id}: ${ROOT_ADVERSE.message}`,
      })));
      expect(trace.boundedUncertaintyAttribution).toEqual(["alpha", "beta"].map((id) => ({
        ...ROOT_BOUNDED_UNCERTAINTY, source: "parent-score",
        path: `parent:${id}:${ROOT_BOUNDED_UNCERTAINTY.path}`,
        message: `Required parent ${id}: ${ROOT_BOUNDED_UNCERTAINTY.message}`,
      })));
    }
  });

  it("creates stable compact traces and result digests across input order", () => {
    const left = scoreV9EvaluatedAsset(input({ assetId: "left" }), V9_CANDIDATE_POLICY_V1);
    const right = scoreV9EvaluatedAsset(input({ assetId: "right" }), V9_CANDIDATE_POLICY_V1);
    expect(projectCompactV9ScoreTrace(left)).toMatchObject({ assetId: "left", score: 95, grade: "A+" });
    expect(computeV9ResultDigest([left, right])).toBe(computeV9ResultDigest([right, left]));
  });
});

describe("simplified score limits", () => {
  it.each([0, 5.99, 6, 23.99])("applies one young-implementation ceiling at %s months", (trackRecordMonths) => {
    const trace = scoreV9EvaluatedAsset(input({ trackRecordMonths }), V9_CANDIDATE_POLICY_V1);
    expect(trace.finalScore).toBe(84);
    expect(trace.caps.map((cap) => cap.source)).toEqual(["track-record"]);
  });
  it.each([36, 120, null])("has no age ceiling at %s months", (trackRecordMonths) => {
    expect(scoreV9EvaluatedAsset(input({ trackRecordMonths }), V9_CANDIDATE_POLICY_V1).caps).toEqual([]);
  });
  it.each([24, 27, 35.99])("preserves the original under-three-year ceiling at %s months", (trackRecordMonths) => {
    const trace = scoreV9EvaluatedAsset(input({ trackRecordMonths }), V9_CANDIDATE_POLICY_V1);
    expect(trace.finalScore).toBe(86);
    expect(trace.bindingCap).toMatchObject({ source: "track-record", kind: "track-record:<36m", limit: 86 });
  });
  it("keeps nearest-integer own rounding when a fractional ceiling is nonbinding", () => {
    const trace = scoreV9EvaluatedAsset(input({
      pillars: { backing: pillar(74.5), exit: pillar(74.5), control: pillar(74.5) },
      parent: { required: true, score: 75.9, propagatedReasons: [] },
    }), V9_CANDIDATE_POLICY_V1);
    expect(trace.finalScore).toBe(75);
    expect(trace.bindingCap).toBeNull();
    expect(trace.caps[0].limit).toBe(75);
  });
  it("rates a three-pillar limited-evidence result and passes its computed value to a child", () => {
    const parent = scoreV9EvaluatedAsset(input({
      assetId: "evidenced-parent",
      pillars: {
        backing: pillar(49.43, { evidenceLevel: "limited", limitedEvidenceCauses: ["U"], causeGapIds: ["gap:backing"] }),
        exit: pillar(48.82, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:exit"] }),
        control: pillar(70),
      },
    }), V9_CANDIDATE_POLICY_V1);
    expect(parent.ratingStatus).toBe("rated");
    expect(parent.finalScore).not.toBeNull();
    const child = scoreV9EvaluatedAsset(input({
      assetId: "evidenced-child", parent: { required: true, score: parent.inheritableScore, propagatedReasons: [] },
    }), V9_CANDIDATE_POLICY_V1);
    expect(child.finalScore).toBe(parent.finalScore);
  });
});

describe("source-bound realized holder loss", () => {
  const occurredAt = "2024-01-01";
  const occurredSec = Date.parse(occurredAt) / 1000;
  const event = {
    incidentId: "holder-loss", assetId: "loss-fixture", scope: { kind: "holder-exit" as const },
    occurredAt, realizedHolderLossPct: 2.95,
    primarySources: [{ label: "Executed holder haircut", url: "https://example.com/holder-loss", publishedAt: occurredAt }],
    finding: "A mandatory withdrawal haircut reduced the whole holder claim.",
  };
  function lossScore(ageDays: number, events = [event]) {
    const fixture = input({ assetId: "loss-fixture", realizedHolderLossEvents: events });
    return scoreV9EvaluatedAsset({
      ...fixture, identity: { ...fixture.identity, asOfSec: occurredSec + ageDays * 86_400 },
    }, V9_CANDIDATE_POLICY_V1);
  }
  describe.each([
    { lossPct: 1, initialLimit: 49 },
    { lossPct: 25, initialLimit: 39 },
  ])("$lossPct% realized loss", ({ lossPct, initialLimit }) => {
    it.each([0, 1, 364, 365])("holds the first-year ceiling at day %s", (day) => {
      const trace = lossScore(day, [{ ...event, realizedHolderLossPct: lossPct }]);
      expect(trace.finalScore).toBe(initialLimit);
      expect(trace.bindingCap?.source).toBe("realized-holder-loss");
      expect(trace.adverseAttribution).toContainEqual(expect.objectContaining({
        source: "realized-holder-loss", path: "incident:holder-loss",
        message: expect.stringContaining(event.primarySources[0].url),
      }));
    });
    it.each([365.1, 400, 547.5, 729, 730])("relaxes continuously before integer flooring at day %s", (day) => {
      const expected = Math.floor(Math.min(100, initialLimit + (100 - initialLimit) * Math.max(0, day - 365) / 365));
      const trace = lossScore(day, [{ ...event, realizedHolderLossPct: lossPct }]);
      expect(trace.finalScore).toBe(Math.min(95, expected));
      expect(trace.caps.find((cap) => cap.source === "realized-holder-loss")?.limit).toBe(expected);
      if (day === 730) expect(trace.bindingCap).toBeNull();
    });
  });
  describe.each([
    { lossPct: 0.99, initialLimit: null },
    { lossPct: 1, initialLimit: 49 },
    { lossPct: 24.99, initialLimit: 49 },
    { lossPct: 25, initialLimit: 39 },
    { lossPct: 49, initialLimit: 39 },
  ])("severity boundary at $lossPct% loss", ({ lossPct, initialLimit }) => {
    it.each([0, 365, 730])("uses the correct tier at day %s", (day) => {
      const trace = lossScore(day, [{ ...event, realizedHolderLossPct: lossPct }]);
      const limit = initialLimit === null ? undefined : day === 730 ? 100 : initialLimit;
      expect(trace.caps.find((cap) => cap.source === "realized-holder-loss")?.limit).toBe(limit);
      expect(trace.finalScore).toBe(Math.min(95, limit ?? 100));
    });
  });
  it("does not price a future event, sub-threshold loss, or absence of proved holder loss", () => {
    expect(lossScore(-1).finalScore).toBe(95);
    expect(lossScore(0, [{ ...event, realizedHolderLossPct: 0.99 }]).finalScore).toBe(95);
    expect(lossScore(0, []).finalScore).toBe(95);
  });
  it("uses the minimum admitted event ceiling regardless of order or duplicate witnesses", () => {
    const older = { ...event, incidentId: "older-loss", occurredAt: "2022-01-01" };
    expect(lossScore(10, [older, event]).finalScore).toBe(49);
    expect(lossScore(10, [event, older, event]).finalScore).toBe(49);
    const severe = { ...event, incidentId: "severe-loss", realizedHolderLossPct: 49 };
    expect(lossScore(10, [event, severe, older]).finalScore).toBe(39);
    expect(lossScore(10, [older, severe, event, severe]).finalScore).toBe(39);
  });
});

describe("identity-free speculative-credit residual limit", () => {
  const signal: V9StructuralSignal = {
    kind: "speculative-credit", severity: "high",
    reason: "An admitted speculative-credit high signal retains its residual limit.",
    responsibility: "measured-adverse", economicLossScope: "reserve-claim",
    pricedInPillar: "backing", failureDomainKeys: [], evidence: [],
  };
  function creditScore(overrides: Partial<V9StructuralSignal> = {}, quality = 95, assetId = "credit-fixture") {
    return scoreV9EvaluatedAsset(input({
      assetId,
      pillars: { backing: pillar(quality), exit: pillar(quality), control: pillar(quality) },
      dependencyStructuralSignals: [{ ...signal, ...overrides }],
    }), V9_CANDIDATE_POLICY_V1);
  }
  it.each([58, 59, 60])("caps only scores above 59, starting from %s", (quality) => {
    const trace = creditScore({}, quality);
    expect(trace.finalScore).toBe(Math.min(quality, 59));
    expect(trace.caps).toContainEqual(expect.objectContaining({ source: "speculative-credit", limit: 59 }));
    expect(trace.bindingCap?.source ?? null).toBe(quality > 59 ? "speculative-credit" : null);
  });
  it.each(["unrelated-one", "unrelated-two"])("does not select asset identity %s", (assetId) => {
    const trace = creditScore({}, 95, assetId);
    expect(trace.finalScore).toBe(59);
    expect(trace.adverseAttribution).toContainEqual(expect.objectContaining({
      source: "structural-signal", path: "structural:speculative-credit:high",
    }));
  });
  const cases: { label: string; overrides: Partial<V9StructuralSignal>; eligible: boolean }[] = [
    { label: "reserve claim already priced in Backing", overrides: {}, eligible: true },
    { label: "global claim", overrides: { economicLossScope: "global-claim" }, eligible: true },
    { label: "unpriced reserve claim", overrides: { pricedInPillar: undefined }, eligible: true },
    { label: "legacy unscoped measured signal", overrides: { economicLossScope: undefined }, eligible: true },
    { label: "legacy unscoped admitted signal", overrides: { economicLossScope: undefined, responsibility: undefined }, eligible: true },
    { label: "scoped signal without adverse admission", overrides: { responsibility: undefined }, eligible: false },
    { label: "unscoped integration gap", overrides: { economicLossScope: undefined, responsibility: "integration-missing" }, eligible: false },
    { label: "access-only claim", overrides: { economicLossScope: "access-only" }, eligible: false },
    { label: "deployment claim", overrides: { economicLossScope: "deployment", exposureKey: "deployment:fixture", riskEventKey: "risk:fixture" }, eligible: false },
    { label: "moderate credit signal", overrides: { severity: "moderate" }, eligible: false },
    { label: "critical credit signal", overrides: { severity: "critical" }, eligible: false },
    { label: "centralized mint", overrides: { kind: "centralized-mint", economicLossScope: "global-claim" }, eligible: false },
    { label: "unsafe backing", overrides: { kind: "unsafe-backing" }, eligible: false },
  ];
  it.each(cases)("preserves R1 eligibility for $label", ({ overrides, eligible }) => {
    const trace = creditScore(overrides);
    expect(trace.finalScore).toBe(eligible ? 59 : 95);
    expect(trace.caps.some((cap) => cap.source === "speculative-credit")).toBe(eligible);
  });
});

describe("genuinely unavailable pillars", () => {
  const pillars = ["backing", "exit", "control"] as const;
  for (let mask = 0; mask < 8; mask++) {
    it(`uses only admitted evidence without fabricating A/B causes for availability mask ${mask}`, () => {
      const included = pillars.filter((_, index) => (mask & (1 << index)) !== 0);
      const evaluation = (key: typeof pillars[number]) => included.includes(key) ? pillar(90) : pillar(null, {
        aggregationDisposition: "unavailable", supportedComponentKeys: [],
      });
      const trace = scoreV9EvaluatedAsset(input({
        pillars: { backing: evaluation("backing"), exit: evaluation("exit"), control: evaluation("control") },
      }), V9_CANDIDATE_POLICY_V1);
      expect(trace.includedPillars).toEqual(included);
      if (included.length === 3) expect(trace.partialEvidence).toBeNull();
      else expect(trace.partialEvidence).toMatchObject({ excludedPillars: pillars.filter((key) => !included.includes(key)).sort(), causes: [], causeGapIds: [] });
      expect(trace.causeGapIds).toEqual([]);
      if (included.length < 2) {
        expect(trace.ratingStatus).toBe("pipeline-gap");
        expect(trace.finalScore).toBeNull();
      } else {
        expect(trace.ratingStatus).toBe("rated");
        const priced = Object.fromEntries(pillars.map((key) => [
          key, included.includes(key) ? 90 : unknownQuality(key, "U"),
        ])) as Record<typeof pillars[number], number>;
        expect(trace.finalScore).toBe(Math.round(aggregateV9SmoothBoundedHeadroom(
          priced, V9_CANDIDATE_POLICY_V1.policy.semantic.formula.pillarWeights, 20, included,
        )!.score));
        expect(trace.diagnosticPillarScores).toEqual(Object.fromEntries(pillars.map((key) => [
          key, included.includes(key) ? 90 : null,
        ])));
        expect(trace.aggregation?.pricedUnknownPillars.map((item) => item.pillar)).toEqual(
          pillars.filter((key) => !included.includes(key)),
        );
        expect(trace.effectiveScoringWeights!.backing + trace.effectiveScoringWeights!.exit + trace.effectiveScoringWeights!.control).toBeCloseTo(1);
      }
    });
  }
});
