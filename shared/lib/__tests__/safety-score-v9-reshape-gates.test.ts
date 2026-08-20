import { describe, expect, it } from "vitest";
import { hasV9DangerSignal, scoreV9Input } from "../safety-score-v9/formula";
import { loadV9MethodologyPolicy, V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { V9_SCORE_BEARING_GATES_POLICY_V923 } from "../safety-score-v9/score-bearing-gates-policy";
import {
  scoreV9EvaluatedAsset,
  type V9PillarEvaluation,
  type V9ProductionScoreInput,
} from "../safety-score-v9/score";
import type {
  V9ScoringInput,
  V9Severity,
  V9StructuralSignal,
  V9StructuralSignalKind,
} from "../../types/safety-score-v9";

const POLICY = V9_CANDIDATE_POLICY_V1;
const DIGEST = "a".repeat(64);
const BUILD_DIGEST = "b".repeat(64);
const BASE_ID = `report-cards-input:v1:${"c".repeat(64)}`;

function signal(kind: V9StructuralSignalKind, severity: V9Severity): V9StructuralSignal {
  return {
    kind,
    severity,
    reason: `${kind}:${severity}`,
    responsibility: "measured-adverse",
    failureDomainKeys: [],
    evidence: [],
  };
}

function pillar(score: number | null, overrides: Partial<V9PillarEvaluation> = {}): V9PillarEvaluation {
  return { score, evidenceLevel: "strong", reasons: [], structuralSignals: [], ...overrides };
}

function assetInput(overrides: Partial<V9ProductionScoreInput> = {}): V9ProductionScoreInput {
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

function rawInput(overrides: Partial<V9ScoringInput> = {}): V9ScoringInput {
  return {
    assetId: "asset",
    pillars: { backing: 35, exit: 35, control: 45 },
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

describe("hasV9DangerSignal", () => {
  const base = {
    pillars: { backing: 35, exit: 35, control: 45 },
    structuralSignals: [] as readonly V9StructuralSignal[],
    pegMultiplier: 1,
    activeDepegBps: null,
    parentRequired: false,
    parentScore: null,
    unresolvedCodes: [],
  };

  it("is false for a benign at-floor evidence gap", () => {
    expect(hasV9DangerSignal(base, POLICY)).toBe(false);
  });

  it("fires on a fired critical structural signal (presence, not bindingness)", () => {
    expect(hasV9DangerSignal({ ...base, structuralSignals: [signal("unsafe-backing", "critical")] }, POLICY)).toBe(true);
  });

  it("fires on active depeg, centralized-mint>=high, sub-peg, sub-floor, parent, unsupported-design", () => {
    expect(hasV9DangerSignal({ ...base, activeDepegBps: 3_000 }, POLICY)).toBe(true);
    expect(hasV9DangerSignal({ ...base, structuralSignals: [signal("centralized-mint", "high")] }, POLICY)).toBe(true);
    expect(hasV9DangerSignal({ ...base, pegMultiplier: 0.626 }, POLICY)).toBe(true);
    expect(hasV9DangerSignal({ ...base, pillars: { backing: 35, exit: 35, control: 25 } }, POLICY)).toBe(true);
    expect(hasV9DangerSignal({ ...base, parentRequired: true, parentScore: 50 }, POLICY)).toBe(true);
    expect(hasV9DangerSignal({ ...base, unresolvedCodes: ["no-viable-exit-path"] }, POLICY)).toBe(true);
  });

  it("gate split (D1): mint:high and peg [0.8,0.9) are withhold-danger but NOT f-gate-danger", () => {
    const mintHigh = { ...base, structuralSignals: [signal("centralized-mint", "high")] };
    expect(hasV9DangerSignal(mintHigh, POLICY, "withhold")).toBe(true);
    expect(hasV9DangerSignal(mintHigh, POLICY, "f-gate")).toBe(false);
    const mintCritical = { ...base, structuralSignals: [signal("centralized-mint", "critical")] };
    expect(hasV9DangerSignal(mintCritical, POLICY, "withhold")).toBe(true);
    expect(hasV9DangerSignal(mintCritical, POLICY, "f-gate")).toBe(true);
    expect(hasV9DangerSignal({ ...base, pegMultiplier: 0.85 }, POLICY, "withhold")).toBe(true);
    expect(hasV9DangerSignal({ ...base, pegMultiplier: 0.85 }, POLICY, "f-gate")).toBe(false);
    expect(hasV9DangerSignal({ ...base, pegMultiplier: 0.79 }, POLICY, "f-gate")).toBe(true);
  });

  it("reads the danger floor from a counterfactual policy", () => {
    const gates = structuredClone(V9_SCORE_BEARING_GATES_POLICY_V923);
    gates.danger.withholdPegMultiplierFloor = 0.84;
    const counterfactual = loadV9MethodologyPolicy(POLICY.policy, gates);

    expect(hasV9DangerSignal({ ...base, pegMultiplier: 0.85 }, POLICY, "withhold")).toBe(true);
    expect(hasV9DangerSignal({ ...base, pegMultiplier: 0.85 }, counterfactual, "withhold")).toBe(false);
  });
});

describe("Lever 1 — insufficient-evidence withhold", () => {
  it("withholds a >=2-limited, no-danger, would-be-F asset to NR", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(35, { evidenceLevel: "limited" }),
          exit: pillar(35, { evidenceLevel: "limited" }),
          control: pillar(45),
        },
      }),
      POLICY,
    );
    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons.map((reason) => reason.code)).toContain("insufficient-evidence");
  });

  it("withholds at the formula boundary when the limited count is threaded", () => {
    const trace = scoreV9Input(rawInput({ evidenceLevel: "limited" }), POLICY, [], 2, true);
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons.map((reason) => reason.code)).toContain("insufficient-evidence");
  });

  it("keeps a measured-adverse control-25 asset rated with explicit structural attribution", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(35, { evidenceLevel: "limited" }),
          exit: pillar(35, { evidenceLevel: "limited" }),
          control: pillar(25, {
            evidenceLevel: "limited",
            structuralSignals: [{ ...signal("centralized-mint", "critical"), pricedInPillar: "control" }],
          }),
        },
      }),
      POLICY,
    );
    expect(trace.finalGrade).toBe("F");
    expect(trace.finalScore).toBe(32);
    expect(trace.adverseAttribution).toContainEqual(
      expect.objectContaining({
        source: "structural-signal",
        path: "structural:centralized-mint:critical",
      }),
    );
    expect(trace.caps.some((cap) => cap.kind === "evidence-floor:d")).toBe(false);
  });

  it("keeps measured sub-floor backing at F under both gates (u-united analog: backing < 35)", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(30, {
            evidenceLevel: "limited",
            structuralSignals: [{ ...signal("unsafe-backing", "critical"), pricedInPillar: "backing" }],
          }),
          exit: pillar(35, { evidenceLevel: "limited" }),
          control: pillar(45),
        },
      }),
      POLICY,
    );
    expect(trace.finalGrade).toBe("F");
    expect(trace.finalScore).not.toBeNull();
    expect(trace.caps.some((cap) => cap.kind === "evidence-floor:d")).toBe(false);
  });

  it("does NOT withhold a measured-adverse asset (pegMultiplier < 0.9) even with 2 limited pillars", () => {
    const trace = scoreV9Input(
      rawInput({ pillars: { backing: 40, exit: 40, control: 50 }, pegScore: 31, evidenceLevel: "limited" }),
      POLICY,
      [],
      2,
    );
    expect(trace.finalGrade).not.toBe("NR");
    expect(trace.finalGrade).toBe("F");
  });
});

describe("Workstream A — attributable D/F ratings", () => {
  it("withholds an evidence-gap-only would-be-F instead of synthesizing D", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(35, { evidenceLevel: "limited" }),
          exit: pillar(35),
          control: pillar(45),
        },
      }),
      POLICY,
    );
    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBe("NR");
    expect(trace.caps.map((cap) => cap.kind)).not.toContain("evidence-floor:d");
    expect(trace.adverseAttribution).toEqual([]);
    expect(trace.nrReasons).toContainEqual(
      expect.objectContaining({ field: "adverseAttribution", responsibility: "method-unsupported" }),
    );
  });

  it("applies the attribution requirement at the formula boundary", () => {
    const trace = scoreV9Input(rawInput(), POLICY);
    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBe("NR");
    expect(trace.caps.some((cap) => cap.kind === "evidence-floor:d")).toBe(false);
  });

  it("keeps a measured mint-concentration F with structural attribution", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(35, { evidenceLevel: "limited" }),
          exit: pillar(35),
          control: pillar(45, {
            structuralSignals: [{ ...signal("centralized-mint", "high"), pricedInPillar: "control" }],
          }),
        },
      }),
      POLICY,
    );
    expect(trace.finalScore).toBe(37);
    expect(trace.finalGrade).toBe("F");
    expect(trace.bindingCap).toBeNull();
    expect(trace.caps.find((cap) => cap.kind === "signal:centralized-mint:high")?.binding).toBe(false);
    expect(trace.adverseAttribution).toContainEqual(
      expect.objectContaining({ source: "structural-signal", path: "structural:centralized-mint:high" }),
    );
  });

  it("keeps measured degraded peg performance rated and attributed", () => {
    const trace = scoreV9Input(
      rawInput({ pillars: { backing: 40, exit: 40, control: 50 }, pegScore: 66, evidenceLevel: "limited" }),
      POLICY,
      [],
      2,
      true,
    );
    expect(trace.finalGrade).toBe("F");
    expect(trace.finalScore).not.toBeNull();
    expect(trace.caps.some((cap) => cap.kind === "evidence-floor:d")).toBe(false);
    expect(trace.adverseAttribution).toContainEqual(
      expect.objectContaining({ source: "peg-performance", path: "peg:historical-performance" }),
    );
  });
});

describe("Pin sentinels stay F (danger-held, never withheld or floored)", () => {
  it("u-united analog: fired-non-binding unsafe-backing:critical + control sub-floor", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(35, {
            structuralSignals: [
              {
                ...signal("unsafe-backing", "critical"),
                pricedInPillar: "backing",
              },
            ],
          }),
          exit: pillar(35),
          control: pillar(25),
        },
      }),
      POLICY,
    );
    expect(trace.finalGrade).toBe("F");
    expect(trace.bindingCap).toBeNull();
    expect(trace.caps.find((cap) => cap.kind === "signal:unsafe-backing:critical")?.binding).toBe(false);
    expect(trace.caps.some((cap) => cap.kind === "evidence-floor:d")).toBe(false);
  });

  it("eurs analog: centralized-mint:high + pegMultiplier < 0.9", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(60),
          exit: pillar(60),
          control: pillar(60, { structuralSignals: [signal("centralized-mint", "high")] }),
        },
        peg: { applicable: true, score: 31, activeDepegBps: null, reasons: [] },
      }),
      POLICY,
    );
    expect(trace.finalGrade).toBe("F");
    expect(trace.caps.some((cap) => cap.kind === "evidence-floor:d")).toBe(false);
  });

  it("mim analog: active-depeg + pegMultiplier 0", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: { backing: pillar(65), exit: pillar(65), control: pillar(65) },
        peg: { applicable: true, score: 0, activeDepegBps: 3_000, reasons: [] },
      }),
      POLICY,
    );
    expect(trace.finalGrade).toBe("F");
    expect(trace.finalScore).toBe(0);
    expect(trace.caps.some((cap) => cap.kind === "evidence-floor:d")).toBe(false);
  });
});

describe("Reshape-v3 T5 — seasoned-issuer credit (R2)", () => {
  const policy = POLICY.policy.semantic;

  it("policy carries the ruled credit knobs", () => {
    // D5 (2026-07-22): T5 mint seasoned credit 5 -> 10, still next-rung-capped.
    expect(policy.control.mintPostureGrading.seasonedCreditPoints).toBe(10);
    expect(policy.control.mintPostureGrading.seasonedCreditMinMonths).toBe(60);
    expect(policy.backing.assuranceSeasonedCredit).toEqual({ points: 3, minMonths: 60 });
  });

  it("mint credit reaches but never exceeds the next merged-ladder rung", () => {
    const ladder = [
      ...Object.values(policy.control.mintPostureQuality),
      policy.control.mintPostureGrading.prudentialReconciled,
      policy.control.mintPostureGrading.attestationOnlyReconciled,
    ].sort((left, right) => left - right);
    for (const score of [55, 70, 80, 85]) {
      const next = ladder.find((value) => value > score)!;
      const credited = Math.min(score + policy.control.mintPostureGrading.seasonedCreditPoints, next);
      expect(credited).toBeLessThanOrEqual(next);
      expect(credited).toBeGreaterThan(score);
    }
    // The top rung (none-resolved 100) has no rung above it: no credit headroom.
    const top = Math.max(...ladder);
    expect(ladder.find((value) => value > top)).toBeUndefined();
  });

  it("adverse/unknown postures are ineligible for the mint credit", () => {
    // The eligibility gate excludes exactly the fail-closed postures; the three
    // hard pins (u-united unbounded, eurs compromised-tier, mim) resolve there.
    for (const posture of ["unknown", "unbounded-or-compromised"] as const) {
      expect(["unknown", "unbounded-or-compromised"]).toContain(posture);
    }
    expect(policy.control.mintPostureQuality["unbounded-or-compromised"]).toBe(25);
  });
});

describe("Reshape-v3 T4b — sovereign concentration exemption (R1)", () => {
  it("exempts exactly the two ruled sovereign classes", () => {
    expect(POLICY.policy.semantic.backing.reserve.sovereignConcentrationExemptClasses).toEqual([
      "treasury-bill",
      "government-security",
    ]);
  });

  it("exempts only allocated commodities through the non-counterparty issuer rule", () => {
    expect(POLICY.policy.semantic.backing.reserve.nonCounterpartyReserveIssuerConcentrationExemptClasses).toEqual([
      "commodity-allocated",
    ]);
  });
});
