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

  it("withholds a score-bearing producer failure when no last-known-good fact remains", () => {
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

    expect(failedAdapter.finalGrade).toBe("NR");
    expect(failedAdapter.finalScore).toBeNull();
    expect(failedAdapter.nrReasons).toContainEqual(
      expect.objectContaining({
        code: "missing-runtime-route-evidence",
        responsibility: "producer-failed",
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

  it("requires every rated D/F example to cite measured-adverse attribution", () => {
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
