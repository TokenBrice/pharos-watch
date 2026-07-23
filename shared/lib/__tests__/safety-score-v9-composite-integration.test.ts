import { describe, expect, it } from "vitest";
import type { V9ScoringInput, V9StructuralSignal } from "../../types/safety-score-v9";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

function signal(overrides: Partial<V9StructuralSignal> = {}): V9StructuralSignal {
  return {
    kind: "critical-dependency",
    severity: "high",
    reason: "A reviewed deployment has bounded local exposure.",
    materialSharePct: 50,
    economicLossScope: "deployment",
    exposureKey: "deployment:bounded",
    riskEventKey: "event:bounded",
    recoveryPath: "deployment-migration",
    expectedRecoverySec: null,
    lossAbsorptionPct: 0,
    evidenceConfidence: "high",
    responsibility: "measured-adverse",
    failureDomainKeys: ["chain:bounded"],
    evidence: [],
    ...overrides,
  };
}

function input(overrides: Partial<V9ScoringInput> = {}): V9ScoringInput {
  return {
    assetId: "composite-integration",
    pillars: { backing: 80, exit: 80, control: 80 },
    pegScore: 100,
    pegApplicable: true,
    evidenceLevel: "strong",
    trackRecordMonths: 48,
    activeDepegBps: null,
    parentRequired: false,
    parentScore: null,
    structuralSignals: [],
    unresolved: [],
    ...overrides,
  };
}

describe("Safety Score v9 continuous composite and scoped risk integration", () => {
  it("does not fall when the identity of the weakest pillar crosses", () => {
    const before = scoreV9Input(
      input({ pillars: { backing: 100, exit: 50, control: 49.9 } }),
      V9_CANDIDATE_POLICY_V1,
    );
    const after = scoreV9Input(
      input({ pillars: { backing: 100, exit: 50, control: 50.1 } }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(before.finalScore).not.toBeNull();
    expect(after.finalScore).not.toBeNull();
    expect(after.finalScore!).toBeGreaterThanOrEqual(before.finalScore!);
    expect(before.aggregation?.headroom).toBe(20);
    expect(after.aggregation?.headroom).toBe(20);
  });

  it("replaces the weakest-plus-headroom cap with a continuous aggregate", () => {
    const trace = scoreV9Input(
      input({
        pillars: { backing: 30, exit: 100, control: 100 },
        unresolved: [{
          code: "no-viable-exit-path",
          reason: "A measured adverse fixture explains the sub-floor quality.",
          critical: false,
          responsibility: "measured-adverse",
        }],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(49);
    expect(trace.aggregation).toMatchObject({
      method: "smooth-bounded-headroom",
      weakestPillar: "backing",
      weakestScore: 30,
      headroom: 20,
    });
    expect(trace.aggregation!.score).toBeGreaterThan(30);
    expect(trace.aggregation!.score).toBeLessThan(trace.weightedQuality!);
    expect(trace.caps.map((cap) => cap.kind)).not.toContain("bounded-compensability");
  });

  it("prices known deployment exposure proportionally instead of hard-capping the whole asset", () => {
    const trace = scoreV9Input(
      input({ structuralSignals: [signal()] }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.baseAssetScore).toBe(80);
    expect(trace.deploymentAdjustedScore).toBe(72);
    expect(trace.finalScore).toBe(72);
    expect(trace.bindingCap).toBeNull();
    expect(trace.deploymentAdjustments).toEqual([
      expect.objectContaining({
        failureDomainKey: "chain:bounded",
        exposureShare: 0.5,
        exposedScore: 64,
        adjustmentPoints: 8,
      }),
    ]);
  });

  it("does not charge a deployment fact already priced in a pillar", () => {
    const trace = scoreV9Input(
      input({ structuralSignals: [signal({ pricedInPillar: "control" })] }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(80);
    expect(trace.deploymentAdjustments).toEqual([]);
    expect(trace.caps).toEqual([]);
  });

  it("keeps unknown deployment exposure as an evidence limitation without a whole-asset cap", () => {
    const unresolved = signal({
      materialSharePct: undefined,
      responsibility: "integration-missing",
    });
    const trace = scoreV9Input(
      input({ structuralSignals: [unresolved] }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(80);
    expect(trace.bindingCap).toBeNull();
    expect(trace.caps).toEqual([]);
    expect(trace.adverseAttribution).toEqual([]);
    expect(trace.unresolvedDeploymentSignals).toEqual([
      expect.objectContaining({ failureDomainKeys: ["chain:bounded"], exposureShare: null }),
    ]);
  });

  it.each([
    "producer-failed",
    "integration-missing",
    "method-unsupported",
    "issuer-undisclosed",
  ] as const)("does not price known-share %s evidence as measured deployment loss", (responsibility) => {
    const trace = scoreV9Input(
      input({
        structuralSignals: [
          signal({
            materialSharePct: 50,
            responsibility,
          }),
        ],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(80);
    expect(trace.deploymentAdjustments).toEqual([]);
    expect(trace.unresolvedDeploymentSignals).toEqual([]);
    expect(trace.caps).toEqual([]);
    expect(trace.adverseAttribution).toEqual([]);
  });

  it("leaves access-only risk with exit and retains global-claim caps", () => {
    const access = scoreV9Input(
      input({
        structuralSignals: [
          signal({ economicLossScope: "access-only", failureDomainKeys: ["dex-protocol:venue"] }),
        ],
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    const global = scoreV9Input(
      input({
        structuralSignals: [
          signal({
            economicLossScope: "global-claim",
            materialSharePct: 100,
            failureDomainKeys: ["mint-control:issuer"],
          }),
        ],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(access.finalScore).toBe(80);
    expect(access.caps).toEqual([]);
    expect(global.finalScore).toBe(64);
    expect(global.bindingCap?.kind).toBe("signal:critical-dependency:high");
  });

  it.each([
    "producer-failed",
    "integration-missing",
    "method-unsupported",
    "issuer-undisclosed",
  ] as const)("does not turn %s global evidence into a measured structural cap", (responsibility) => {
    const trace = scoreV9Input(
      input({
        structuralSignals: [
          signal({
            economicLossScope: "global-claim",
            materialSharePct: 100,
            responsibility,
            failureDomainKeys: [`global:${responsibility}`],
          }),
        ],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(80);
    expect(trace.caps).toEqual([]);
    expect(trace.adverseAttribution).toEqual([]);
  });

  it("retains an issuer-undisclosed evidence ceiling without a structural-risk claim", () => {
    const trace = scoreV9Input(
      input({
        structuralSignals: [
          signal({
            economicLossScope: "global-claim",
            materialSharePct: 100,
            responsibility: "issuer-undisclosed",
            failureDomainKeys: ["global:undisclosed-upgrade"],
          }),
        ],
        unresolved: [{
          code: "missing-upgrade-control",
          path: "control:upgrade",
          reason: "The issuer has not disclosed the upgrade authority.",
          critical: false,
          responsibility: "issuer-undisclosed",
        }],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(55);
    expect(trace.bindingCap).toMatchObject({
      source: "evidence",
      kind: "reason:missing-upgrade-control",
    });
    expect(trace.caps.some((cap) => cap.source === "structural")).toBe(false);
    expect(trace.adverseAttribution).toEqual([]);
  });

  it("does not hard-cap a reserve slice already owned by backing", () => {
    const trace = scoreV9Input(
      input({
        structuralSignals: [
          signal({
            kind: "unsafe-backing",
            economicLossScope: "reserve-claim",
            pricedInPillar: "backing",
            failureDomainKeys: ["reserve-custodian:bank"],
          }),
        ],
      }),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace.finalScore).toBe(80);
    expect(trace.caps).toEqual([]);
    expect(trace.deploymentAdjustments).toEqual([]);
  });
});
