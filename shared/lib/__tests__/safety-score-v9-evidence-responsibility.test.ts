import { describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  scoreV9EvaluatedAsset,
  type V9PillarEvaluation,
  type V9PillarReason,
  type V9ProductionScoreInput,
} from "../safety-score-v9/score";
import {
  V9ScoringInputSchema,
  type V9StructuralSignal,
} from "../../types/safety-score-v9";
import type { V9PillarAdverseAttribution } from "../safety-score-v9/formula";

const DIGEST = "a".repeat(64);
const BUILD_DIGEST = "b".repeat(64);
const BASE_ID = `report-cards-input:v1:${"c".repeat(64)}`;

function reason(
  overrides: Partial<V9PillarReason> = {},
): V9PillarReason {
  return {
    code: "missing-runtime-route-evidence",
    path: "exit:dex",
    message: "The latest route adapter failed.",
    responsibility: "producer-failed",
    ...overrides,
  };
}

function pillar(score: number | null, overrides: Partial<V9PillarEvaluation> = {}): V9PillarEvaluation {
  return { score, evidenceLevel: "strong", reasons: [], structuralSignals: [], ...overrides };
}

function input(overrides: Partial<V9ProductionScoreInput> = {}): V9ProductionScoreInput {
  return {
    assetId: "asset",
    identity: {
      factSetDigest: DIGEST,
      baseInputGenerationId: BASE_ID,
      evaluationBuildDigest: BUILD_DIGEST,
      asOfSec: 1_000,
      sourceGenerations: {},
    },
    pillars: { backing: pillar(95), exit: pillar(95), control: pillar(95) },
    peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [] },
    trackRecordMonths: 48,
    parent: { required: false, score: null, propagatedReasons: [] },
    dependencyReasons: [],
    dependencyStructuralSignals: [],
    ...overrides,
  };
}

describe("Safety Score v9 evidence responsibility", () => {
  it("rejects score-bearing gaps that omit explicit responsibility", () => {
    const parsed = V9ScoringInputSchema.safeParse({
      assetId: "legacy-ambiguous",
      pillars: { backing: 80, exit: 80, control: 80 },
      pegScore: 100,
      pegApplicable: true,
      evidenceLevel: "strong",
      trackRecordMonths: 48,
      activeDepegBps: null,
      parentRequired: false,
      parentScore: null,
      structuralSignals: [],
      unresolved: [{
        code: "no-viable-exit-path",
        reason: "The legacy row does not identify who owns the evidence state.",
        critical: false,
      }],
    });

    expect(parsed.success).toBe(false);
  });

  it("keeps a fresh last-known-good score when the latest optional adapter fails", () => {
    const baseline = scoreV9EvaluatedAsset(input(), V9_CANDIDATE_POLICY_V1);
    const failedAdapter = scoreV9EvaluatedAsset(
      input({ unresolvedEvidence: [reason()] }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(failedAdapter.finalScore).toBe(baseline.finalScore);
    expect(failedAdapter.finalGrade).toBe(baseline.finalGrade);
    expect(failedAdapter.bindingCap).toEqual(baseline.bindingCap);
    expect(failedAdapter.unresolvedFacts).toContainEqual(
      expect.objectContaining({
        path: "exit:dex",
        responsibility: "producer-failed",
      }),
    );
  });

  it("counts one gap emitted through pillar and unresolved-evidence paths once without moving the score", () => {
    const pillarGap = reason({
      path: "exit:route:cause:asset:gap:route",
      sourceGapId: "asset:gap:route",
    });
    const baseline = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(95),
          exit: pillar(35, { evidenceLevel: "limited", reasons: [pillarGap] }),
          control: pillar(95),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    const duplicated = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(95),
          exit: pillar(35, { evidenceLevel: "limited", reasons: [pillarGap] }),
          control: pillar(95),
        },
        unresolvedEvidence: [reason({
          path: "gap:exit:optional-exit:asset:gap:route",
          sourceGapId: "asset:gap:route",
        })],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(duplicated.unresolvedFacts.filter((fact) => fact.sourceGapId === "asset:gap:route")).toHaveLength(1);
    expect(duplicated.finalScore).toBe(baseline.finalScore);
    expect(duplicated.finalGrade).toBe(baseline.finalGrade);
  });

  it("retains distinct gaps that share a reason code", () => {
    const trace = scoreV9EvaluatedAsset(
      input({
        unresolvedEvidence: [
          reason({ path: "exit:route-a", sourceGapId: "asset:gap:route-a" }),
          reason({ path: "exit:route-b", sourceGapId: "asset:gap:route-b" }),
        ],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.unresolvedFacts.filter((fact) => fact.code === "missing-runtime-route-evidence"))
      .toHaveLength(2);
  });

  it("withholds a policy-critical gap even when it enters through supplemental unresolved evidence", () => {
    const criticalGap = reason({
      code: "missing-pillar-evidence",
      path: "gap:evidence:local-component:asset:gap:supply",
      message: "Global chain supply is unavailable.",
    });
    const trace = scoreV9EvaluatedAsset(
      input({ unresolvedEvidence: [criticalGap] }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons).toContainEqual(
      expect.objectContaining({
        code: "missing-pillar-evidence",
        responsibility: "producer-failed",
      }),
    );
    expect(trace.unresolvedFacts).toContainEqual(
      expect.objectContaining({
        code: "missing-pillar-evidence",
        critical: true,
        responsibility: "producer-failed",
      }),
    );
  });

  it("keeps a bounded producer failure rateable under its evidence ceiling", () => {
    const failedAdapter = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(95),
          exit: pillar(35, { evidenceLevel: "limited", reasons: [reason()] }),
          control: pillar(95),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(failedAdapter.finalGrade).toBe("C-");
    expect(failedAdapter.finalScore).toBe(54);
    expect(failedAdapter.nrReasons).toEqual([]);
    expect(failedAdapter.caps).toContainEqual(
      expect.objectContaining({
        source: "evidence",
        kind: "reason:missing-runtime-route-evidence",
        limit: 65,
      }),
    );
    expect(failedAdapter.unresolvedFacts).toContainEqual(
      expect.objectContaining({
        path: "exit:dex",
        responsibility: "producer-failed",
      }),
    );
  });

  it("keeps a bounded unsupported method provisional under its policy ceiling", () => {
    const unsupportedDependencyReview = reason({
      code: "unreviewed-dependency-relationships",
      path: "dependency:graph",
      message: "The dependency graph cannot yet evaluate this relationship.",
      responsibility: "method-unsupported",
    });
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(80),
          exit: pillar(80),
          control: pillar(70, {
            evidenceLevel: "limited",
            reasons: [unsupportedDependencyReview],
          }),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("B-");
    expect(trace.finalScore).toBe(69);
    expect(trace.nrReasons).toEqual([]);
    expect(trace.caps).toContainEqual(
      expect.objectContaining({
        source: "evidence",
        kind: "evidence:limited",
        limit: 69,
      }),
    );
    expect(trace.unresolvedFacts).toContainEqual(
      expect.objectContaining({
        path: "dependency:graph",
        responsibility: "method-unsupported",
      }),
    );
  });

  it("attributes a shared evidence ceiling only to its binding reason instance", () => {
    const bindingDependencyGap = reason({
      code: "unreviewed-dependency-relationships",
      path: "dependency:collateral:parent-a",
      message: "Collateral dependency parent-a is not exactly mapped.",
      responsibility: "integration-missing",
    });
    const siblingDependencyGap = reason({
      code: "unreviewed-dependency-relationships",
      path: "dependency:collateral:parent-b",
      message: "Collateral dependency parent-b is not exactly mapped.",
      responsibility: "integration-missing",
    });
    const trace = scoreV9EvaluatedAsset(
      input({
        dependencyReasons: [bindingDependencyGap, siblingDependencyGap],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.bindingCap).toMatchObject({
      source: "evidence",
      kind: "reason:unreviewed-dependency-relationships",
      reason: bindingDependencyGap.message,
    });
    expect(trace.boundedUncertaintyAttribution).toEqual([
      expect.objectContaining({
        source: "reason",
        code: bindingDependencyGap.code,
        path: bindingDependencyGap.path,
        message: bindingDependencyGap.message,
      }),
    ]);
  });

  it("withholds an unbounded unsupported method even when the proved fact would be pillar-scored", () => {
    const unsupportedExitMethod = reason({
      code: "no-viable-exit-path",
      path: "exit:viable-path",
      message: "The current method cannot establish whether a viable exit path exists.",
      responsibility: "method-unsupported",
    });
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(95),
          exit: pillar(95, { reasons: [unsupportedExitMethod] }),
          control: pillar(95),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("NR");
    expect(trace.finalScore).toBeNull();
    expect(trace.nrReasons).toContainEqual(
      expect.objectContaining({
        code: "no-viable-exit-path",
        responsibility: "method-unsupported",
      }),
    );
  });

  it("withholds unbounded uncertainty regardless of which non-measured owner caused it", () => {
    for (const responsibility of [
      "integration-missing",
      "issuer-undisclosed",
      "producer-failed",
    ] as const) {
      const unboundedExit = reason({
        code: "no-viable-exit-path",
        path: "exit:viable-path",
        message: "The evidence owner cannot establish whether a viable exit path exists.",
        responsibility,
      });
      const trace = scoreV9EvaluatedAsset(
        input({
          assetId: `unbounded-${responsibility}`,
          pillars: {
            backing: pillar(95),
            exit: pillar(95, { reasons: [unboundedExit] }),
            control: pillar(95),
          },
        }),
        V9_CANDIDATE_POLICY_V1,
      );

      expect(trace.finalGrade, responsibility).toBe("NR");
      expect(trace.nrReasons, responsibility).toContainEqual(
        expect.objectContaining({
          code: "no-viable-exit-path",
          responsibility,
        }),
      );
    }
  });

  it("keeps an unbounded required method failure as NR", () => {
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(95, {
            reasons: [reason({
              code: "missing-pillar-evidence",
              path: "backing:required-claim",
              message: "The required backing method cannot establish this claim.",
              responsibility: "method-unsupported",
            })],
          }),
          exit: pillar(95),
          control: pillar(95),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("NR");
    expect(trace.finalScore).toBeNull();
    expect(trace.nrReasons).toContainEqual(
      expect.objectContaining({
        code: "missing-pillar-evidence",
        responsibility: "method-unsupported",
      }),
    );
  });

  it("keeps a bounded integration gap visible without converting it into risk or NR", () => {
    const integrationGap = reason({
      code: "bounded-mechanism-review",
      path: "backing:mechanism:review",
      message: "Pharos has not integrated the reviewed mechanism component.",
      responsibility: "integration-missing",
    });
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(65, { evidenceLevel: "limited", reasons: [integrationGap] }),
          exit: pillar(95),
          control: pillar(95),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).not.toBeNull();
    expect(trace.finalGrade).not.toBe("NR");
    expect(trace.caps).toContainEqual(
      expect.objectContaining({ source: "evidence", kind: "evidence:limited", limit: 69 }),
    );
    expect(trace.caps.some((cap) => cap.kind === "reason:bounded-mechanism-review")).toBe(false);
    expect(trace.unresolvedFacts).toContainEqual(
      expect.objectContaining({
        path: "backing:mechanism:review",
        responsibility: "integration-missing",
      }),
    );
  });

  it("applies the registry ceiling to a bounded integration-owned gap", () => {
    const integrationGap = reason({
      code: "missing-reserve-composition",
      path: "backing:reserve:composition",
      message: "Pharos has not integrated the current reserve composition.",
      responsibility: "integration-missing",
    });
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(95, { reasons: [integrationGap] }),
          exit: pillar(95),
          control: pillar(95),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(60);
    expect(trace.bindingCap).toEqual(
      expect.objectContaining({
        source: "evidence",
        kind: "reason:missing-reserve-composition",
        limit: 60,
      }),
    );
  });

  it("keeps missing categorical access review diagnostic rather than score-bearing", () => {
    const accessGap = reason({
      code: "missing-access-review",
      path: "gap:control:local-component:asset:gap:access:freeze",
      message: "The categorical freeze-reach review is not current.",
      responsibility: "integration-missing",
    });
    const trace = scoreV9EvaluatedAsset(
      input({ unresolvedEvidence: [accessGap] }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("A+");
    expect(trace.nrReasons).toEqual([]);
    expect(trace.unresolvedFacts).toContainEqual(
      expect.objectContaining({
        code: "missing-access-review",
        critical: false,
      }),
    );
  });

  it("retains a material issuer-disclosure penalty and ceiling without manufacturing D/F", () => {
    const issuerGap = reason({
      code: "material-unknown-reserve-exposure",
      path: "backing:reserve:unknown",
      message: "The issuer does not disclose a material reserve slice.",
      responsibility: "issuer-undisclosed",
    });
    const baseline = scoreV9EvaluatedAsset(input(), V9_CANDIDATE_POLICY_V1);
    const undisclosed = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(35, { evidenceLevel: "limited", reasons: [issuerGap] }),
          exit: pillar(95),
          control: pillar(95),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(baseline.finalScore).toBe(95);
    expect(undisclosed.finalScore).toBe(54);
    expect(undisclosed.finalGrade).toBe("C-");
    expect(undisclosed.caps).toContainEqual(
      expect.objectContaining({
        source: "evidence",
        kind: "reason:material-unknown-reserve-exposure",
        limit: 69,
      }),
    );
    expect(undisclosed.adverseAttribution).toEqual([]);
  });

  it("returns NR when issuer nondisclosure alone would otherwise land in D/F", () => {
    const issuerGap = reason({
      code: "material-unknown-reserve-exposure",
      path: "backing:reserve:unknown",
      message: "The issuer does not disclose a material reserve slice.",
      responsibility: "issuer-undisclosed",
    });
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(35, { evidenceLevel: "limited", reasons: [issuerGap] }),
          exit: pillar(35, { evidenceLevel: "limited", reasons: [issuerGap] }),
          control: pillar(45),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBe("NR");
    expect(trace.caps.some((cap) => cap.kind === "evidence-floor:d")).toBe(false);
    expect(trace.adverseAttribution).toEqual([]);
  });

  it("does not let a low diagnostic signal turn issuer-only uncertainty into D/F attribution", () => {
    const issuerGap = reason({
      code: "material-unknown-reserve-exposure",
      path: "backing:reserve:unknown",
      message: "The issuer does not disclose a material reserve slice.",
      responsibility: "issuer-undisclosed",
    });
    const lowSignal: V9StructuralSignal = {
      kind: "unsafe-backing",
      severity: "low",
      responsibility: "measured-adverse",
      reason: "A low-severity concentration signal is present.",
      failureDomainKeys: ["reserve-issuer:fixture"],
      evidence: [],
    };
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(35, {
            evidenceLevel: "limited",
            reasons: [issuerGap],
            structuralSignals: [lowSignal],
          }),
          exit: pillar(35),
          control: pillar(45),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("NR");
    expect(trace.finalScore).toBeNull();
    expect(trace.adverseAttribution).toEqual([]);
  });

  it("does not let a measured diagnostic reason justify a D/F rating", () => {
    const diagnostic = reason({
      code: "unresolved-exit-output",
      path: "exit:diagnostic",
      message: "A measured route diagnostic does not alter the exit score.",
      responsibility: "measured-adverse",
    });
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(35),
          exit: pillar(35, { reasons: [diagnostic] }),
          control: pillar(45),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.unresolvedFacts).toContainEqual(
      expect.objectContaining({
        code: "unresolved-exit-output",
        responsibility: "measured-adverse",
      }),
    );
    expect(trace.adverseAttribution).toEqual([]);
    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBe("NR");
  });

  it("does not let a zero-loss deployment signal explain an issuer-only D/F result", () => {
    const issuerGap = reason({
      code: "material-unknown-reserve-exposure",
      path: "backing:reserve:unknown",
      message: "The issuer does not disclose a material reserve slice.",
      responsibility: "issuer-undisclosed",
    });
    const zeroLossSignal: V9StructuralSignal = {
      kind: "material-bridge",
      severity: "moderate",
      responsibility: "measured-adverse",
      reason: "A measured deployment has no score loss at the current base quality.",
      materialSharePct: 10,
      economicLossScope: "deployment",
      exposureKey: "deployment:zero-loss",
      riskEventKey: "event:zero-loss",
      recoveryPath: "deployment-migration",
      expectedRecoverySec: null,
      lossAbsorptionPct: 0,
      evidenceConfidence: "high",
      failureDomainKeys: ["bridge-route:fixture"],
      evidence: [],
    };
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(35, { evidenceLevel: "limited", reasons: [issuerGap] }),
          exit: pillar(35, { evidenceLevel: "limited", reasons: [issuerGap] }),
          control: pillar(45),
        },
        dependencyStructuralSignals: [zeroLossSignal],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.deploymentAdjustments).toEqual([
      expect.objectContaining({ adjustmentPoints: 0 }),
    ]);
    expect(trace.finalGrade).toBe("NR");
    expect(trace.finalScore).toBeNull();
    expect(trace.adverseAttribution).toEqual([]);
  });

  it("does not let a nonbinding structural ceiling explain an issuer-only D/F result", () => {
    const issuerGap = reason({
      code: "material-unknown-reserve-exposure",
      path: "backing:reserve:unknown",
      message: "The issuer does not disclose a material reserve slice.",
      responsibility: "issuer-undisclosed",
    });
    const nonbindingSignal: V9StructuralSignal = {
      kind: "unsafe-backing",
      severity: "moderate",
      responsibility: "measured-adverse",
      reason: "A measured global signal is present but does not bind this low latent score.",
      economicLossScope: "global-claim",
      recoveryPath: "issuer-remediation",
      expectedRecoverySec: null,
      lossAbsorptionPct: 0,
      evidenceConfidence: "high",
      failureDomainKeys: ["reserve-issuer:fixture"],
      evidence: [],
    };
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(35, { evidenceLevel: "limited", reasons: [issuerGap] }),
          exit: pillar(35, { evidenceLevel: "limited", reasons: [issuerGap] }),
          control: pillar(45),
        },
        dependencyStructuralSignals: [nonbindingSignal],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.caps).toContainEqual(
      expect.objectContaining({
        kind: "signal:unsafe-backing:moderate",
        binding: false,
      }),
    );
    expect(trace.finalGrade).toBe("NR");
    expect(trace.finalScore).toBeNull();
    expect(trace.adverseAttribution).toEqual([]);
  });

  it("attributes D/F when a measured deployment loss actually moves the score", () => {
    const measuredDeployment: V9StructuralSignal = {
      kind: "material-bridge",
      severity: "critical",
      responsibility: "measured-adverse",
      reason: "A measured deployment-local failure affects the whole claim.",
      materialSharePct: 100,
      economicLossScope: "deployment",
      exposureKey: "deployment:measured",
      riskEventKey: "event:measured",
      recoveryPath: "deployment-migration",
      expectedRecoverySec: null,
      lossAbsorptionPct: 0,
      evidenceConfidence: "high",
      failureDomainKeys: ["bridge-route:fixture"],
      evidence: [],
    };
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(55),
          exit: pillar(55),
          control: pillar(55),
        },
        dependencyStructuralSignals: [measuredDeployment],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.deploymentAdjustments).toContainEqual(
      expect.objectContaining({ adjustmentPoints: 16 }),
    );
    expect(trace.finalGrade).toBe("F");
    expect(trace.adverseAttribution).toContainEqual(
      expect.objectContaining({
        source: "structural-signal",
        path: "structural:material-bridge:critical",
      }),
    );
  });

  it("carries measured attribution through rated D/F examples when facts support it", () => {
    const measuredReason = reason({
      code: "no-viable-exit-path",
      path: "exit:redemption",
      message: "Measured routes prove no viable holder exit.",
      responsibility: "measured-adverse",
    });
    const structuralSignal: V9StructuralSignal = {
      kind: "unsafe-backing",
      severity: "critical",
      responsibility: "measured-adverse",
      reason: "Measured reserves leave a critical unabsorbed loss.",
      pricedInPillar: "backing",
      failureDomainKeys: ["reserve-issuer:fixture"],
      evidence: [],
    };
    const traces = [
      scoreV9EvaluatedAsset(
        input({
          assetId: "d-example",
          pillars: {
            backing: pillar(50),
            exit: pillar(40, { reasons: [measuredReason] }),
            control: pillar(50),
          },
        }),
        V9_CANDIDATE_POLICY_V1,
      ),
      scoreV9EvaluatedAsset(
        input({
          assetId: "f-example",
          pillars: {
            backing: pillar(35, { structuralSignals: [structuralSignal] }),
            exit: pillar(35),
            control: pillar(25),
          },
        }),
        V9_CANDIDATE_POLICY_V1,
      ),
    ];

    expect(traces.map((trace) => trace.finalGrade)).toEqual(["D", "F"]);
    for (const trace of traces) {
      expect(trace.adverseAttribution.length).toBeGreaterThan(0);
      expect(trace.adverseAttribution.every((fact) => fact.responsibility === "measured-adverse")).toBe(true);
    }
  });

  it("keeps a naturally computed bounded D rateable without inventing adverse attribution", () => {
    const boundedBacking = reason({
      code: "bounded-mechanism-review",
      path: "backing:mechanism:custody-continuity",
      message: "A bounded backing component remains unresolved.",
      responsibility: "integration-missing",
    });
    const boundedExit = reason({
      code: "missing-runtime-route-evidence",
      path: "exit:dex",
      message: "The latest route adapter failed within a bounded exit method.",
      responsibility: "producer-failed",
    });
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(45, { reasons: [boundedBacking] }),
          exit: pillar(45, { reasons: [boundedExit] }),
          control: pillar(50),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("D");
    expect(trace.finalScore).not.toBeNull();
    expect(trace.nrReasons).toEqual([]);
    expect(trace.adverseAttribution).toEqual([]);
    expect(trace.boundedUncertaintyAttribution).toEqual([
      expect.objectContaining({
        source: "reason",
        code: "bounded-mechanism-review",
        responsibility: "integration-missing",
        boundedness: "exposure-bounded",
      }),
      expect.objectContaining({
        source: "reason",
        code: "missing-runtime-route-evidence",
        responsibility: "producer-failed",
        boundedness: "globally-bounded",
      }),
    ]);
  });

  it("withholds an arbitrary D with no measured or bounded causal trace", () => {
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(45),
          exit: pillar(45),
          control: pillar(50),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("NR");
    expect(trace.finalScore).toBeNull();
    expect(trace.nrReasons).toContainEqual(
      expect.objectContaining({ field: "boundedUncertaintyAttribution" }),
    );
    expect(trace.adverseAttribution).toEqual([]);
    expect(trace.boundedUncertaintyAttribution).toEqual([]);
  });

  it("does not relabel a policy-bounded missing-data reason as measured adverse", () => {
    const mislabeledBoundedGap = reason({
      code: "bounded-mechanism-review",
      path: "backing:review",
      message: "A bounded backing review remains unresolved.",
      responsibility: "measured-adverse",
    });
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(45, { reasons: [mislabeledBoundedGap] }),
          exit: pillar(45),
          control: pillar(50),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("NR");
    expect(trace.finalScore).toBeNull();
    expect(trace.adverseAttribution).toEqual([]);
    expect(trace.boundedUncertaintyAttribution).toEqual([]);
  });

  it("does not let an unrelated bounded reason authorize a D", () => {
    const unrelatedControlGap = reason({
      code: "bounded-mechanism-review",
      path: "control:unrelated",
      message: "An unrelated control review remains bounded.",
      responsibility: "integration-missing",
    });
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(35),
          exit: pillar(35),
          control: pillar(95, { reasons: [unrelatedControlGap] }),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("NR");
    expect(trace.boundedUncertaintyAttribution).toEqual([]);
  });

  it("does not infer pillar provenance from a non-pillar reason path", () => {
    const prefixedMethodologyGap = reason({
      code: "bounded-mechanism-review",
      path: "backing:misleading-methodology-path",
      message: "A methodology-owned review uses a pillar-like path.",
      responsibility: "integration-missing",
    });
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(45),
          exit: pillar(45),
          control: pillar(50),
        },
        methodologyReasons: [prefixedMethodologyGap],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons).toContainEqual(
      expect.objectContaining({ field: "boundedUncertaintyAttribution" }),
    );
    expect(trace.boundedUncertaintyAttribution).toEqual([]);
  });

  it("does not let a nonbinding one-basis-point depeg authorize a D", () => {
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(45),
          exit: pillar(45),
          control: pillar(45),
        },
        peg: { applicable: true, score: 100, activeDepegBps: 1, reasons: [] },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("NR");
    expect(trace.adverseAttribution).toEqual([]);
  });

  it("attributes a fallback wrapper discount to its bounded local gaps", () => {
    const trace = scoreV9EvaluatedAsset(
      input({
        parent: {
          required: true,
          score: 45,
          propagatedReasons: [],
          wrapperParentLimit: {
            schemaVersion: 1,
            parentScore: 50,
            form: "native-staked",
            treatment: "fallback-discount",
            localRiskDiscount: 0,
            fallbackDiscount: 5,
            appliedDiscount: 5,
            riskTransfer: {
              disposition: "reviewed",
              mechanism: "none",
              requestedCredit: 0,
              appliedCredit: 0,
            },
            limit: 45,
            factsComplete: false,
            missingFacts: [{
              factClass: "measuredUnwind",
              disposition: "integration-missing",
            }],
            adjustments: [],
          },
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("D");
    expect(trace.adverseAttribution).toEqual([]);
    expect(trace.boundedUncertaintyAttribution).toEqual([
      expect.objectContaining({
        source: "wrapper-local",
        code: "bounded-mechanism-review",
        path: "wrapper-local:measuredUnwind",
      }),
    ]);
  });

  it("attributes an incomplete wrapper to reviewed risk when it exceeds the fallback", () => {
    const trace = scoreV9EvaluatedAsset(
      input({
        parent: {
          required: true,
          score: 44,
          propagatedReasons: [],
          wrapperParentLimit: {
            schemaVersion: 1,
            parentScore: 50,
            form: "strategy-vault",
            treatment: "fallback-discount",
            localRiskDiscount: 6,
            fallbackDiscount: 5,
            appliedDiscount: 6,
            riskTransfer: {
              disposition: "reviewed",
              mechanism: "none",
              requestedCredit: 0,
              appliedCredit: 0,
            },
            limit: 44,
            factsComplete: false,
            missingFacts: [{
              factClass: "custodyEscrow",
              disposition: "issuer-undisclosed",
            }],
            adjustments: [
              {
                factKey: "measuredUnwind",
                disposition: "reviewed",
                assessment: "critical",
                maximumDiscountPoints: 5,
                discountPoints: 5,
              },
              {
                factKey: "contractMutability",
                disposition: "reviewed",
                assessment: "moderate",
                maximumDiscountPoints: 2,
                discountPoints: 1,
              },
            ],
          },
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("D");
    expect(trace.adverseAttribution).toEqual([
      expect.objectContaining({
        source: "wrapper-local",
        path: "wrapper-local:contractMutability",
      }),
      expect.objectContaining({
        source: "wrapper-local",
        path: "wrapper-local:measuredUnwind",
      }),
    ]);
    expect(trace.boundedUncertaintyAttribution).toEqual([]);
  });

  it("attributes a reviewed wrapper discount to measured local risk", () => {
    const trace = scoreV9EvaluatedAsset(
      input({
        parent: {
          required: true,
          score: 45,
          propagatedReasons: [],
          wrapperParentLimit: {
            schemaVersion: 1,
            parentScore: 50,
            form: "strategy-vault",
            treatment: "local-facts",
            localRiskDiscount: 5,
            fallbackDiscount: 0,
            appliedDiscount: 5,
            riskTransfer: {
              disposition: "reviewed",
              mechanism: "none",
              requestedCredit: 0,
              appliedCredit: 0,
            },
            limit: 45,
            factsComplete: true,
            missingFacts: [],
            adjustments: [{
              factKey: "measuredUnwind",
              disposition: "reviewed",
              assessment: "critical",
              maximumDiscountPoints: 5,
              discountPoints: 5,
            }],
          },
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("D");
    expect(trace.adverseAttribution).toEqual([
      expect.objectContaining({
        source: "wrapper-local",
        path: "wrapper-local:measuredUnwind",
      }),
    ]);
    expect(trace.boundedUncertaintyAttribution).toEqual([]);
  });

  it("keeps a low measured pillar score rated when its causal attribution is explicit", () => {
    const measuredExitCapacity = {
      source: "pillar-score",
      path: "pillar:exit:route:dex:fixture:capacity",
      message: "The measured primary exit route had immaterial executable capacity.",
      responsibility: "measured-adverse",
    } satisfies V9PillarAdverseAttribution;
    const trace = scoreV9EvaluatedAsset(
      input({
        pillars: {
          backing: pillar(55),
          exit: pillar(0, { adverseAttribution: [measuredExitCapacity] }),
          control: pillar(75),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("F");
    expect(trace.finalScore).not.toBeNull();
    expect(trace.nrReasons).not.toContainEqual(
      expect.objectContaining({ field: "adverseAttribution" }),
    );
    expect(trace.adverseAttribution).toEqual([measuredExitCapacity]);
  });

  it.each([
    {
      label: "backing",
      signal: {
        kind: "unsafe-backing",
        severity: "critical",
        reason: "A known reserve fact drives backing quality.",
        responsibility: "measured-adverse",
        pricedInPillar: "backing",
        failureDomainKeys: ["reserve-issuer:fixture"],
        evidence: [],
      } satisfies V9StructuralSignal,
    },
    {
      label: "control",
      signal: {
        kind: "centralized-mint",
        severity: "high",
        reason: "A known mint-control fact drives control quality.",
        responsibility: "measured-adverse",
        pricedInPillar: "control",
        failureDomainKeys: ["mint-control:fixture"],
        evidence: [],
      } satisfies V9StructuralSignal,
    },
  ])("distinguishes known from unavailable $label structural provenance", ({ signal }) => {
    const pillars = {
      backing: pillar(35),
      exit: pillar(35),
      control: pillar(45),
    };
    const known = scoreV9EvaluatedAsset(
      input({
        pillars: {
          ...pillars,
          [signal.pricedInPillar!]: pillar(pillars[signal.pricedInPillar!].score, {
            structuralSignals: [signal],
          }),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    const unavailableSignal = {
      ...signal,
      responsibility: "integration-missing" as const,
    };
    const unavailable = scoreV9EvaluatedAsset(
      input({
        pillars: {
          ...pillars,
          [signal.pricedInPillar!]: pillar(pillars[signal.pricedInPillar!].score, {
            structuralSignals: [unavailableSignal],
          }),
        },
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(known.finalGrade).toBe("F");
    expect(known.adverseAttribution).toContainEqual(
      expect.objectContaining({ source: "structural-signal" }),
    );
    expect(unavailable.finalGrade).toBe("NR");
    expect(unavailable.adverseAttribution).toEqual([]);
  });

  it("does not turn an unreviewed upgrade disposition into an economic cap", () => {
    const signal: V9StructuralSignal = {
      kind: "unreviewed-upgrade",
      severity: "critical",
      responsibility: "issuer-undisclosed",
      reason: "Upgrade authority has not been reviewed.",
      failureDomainKeys: [],
      evidence: [],
    };
    const trace = scoreV9EvaluatedAsset(
      input({ dependencyStructuralSignals: [signal] }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalGrade).toBe("A+");
    expect(trace.caps.some((cap) => cap.kind.startsWith("signal:unreviewed-upgrade"))).toBe(false);
    expect(trace.adverseAttribution).toEqual([]);
  });
});
