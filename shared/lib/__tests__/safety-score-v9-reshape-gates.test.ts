import { describe, expect, it } from "vitest";
import { hasV9DangerSignal, scoreV9Input } from "../safety-score-v9/formula";
import { loadV9MethodologyPolicy, V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { V9_SCORE_BEARING_GATES_POLICY_V923 } from "../safety-score-v9/score-bearing-gates-policy";
import {
  scoreV9EvaluatedAsset,
} from "../safety-score-v9/score";
import type {
  V9ScoringInput,
  V9Severity,
  V9StructuralSignal,
  V9StructuralSignalKind,
} from "../../types/safety-score-v9";
import { makeV9Pillar as pillar, makeV9ProductionScoreInput as assetInput } from "./safety-score-v9-score.test-support";

const POLICY = V9_CANDIDATE_POLICY_V1;

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
    // 9.32: adverse rungs earn the same credit under a dedicated ceiling (39).
    expect(policy.control.mintPostureGrading.seasonedCreditPoints).toBe(10);
    expect(policy.control.mintPostureGrading.seasonedCreditMinMonths).toBe(60);
    expect(policy.control.mintPostureGrading.adverseSeasonedCreditCeiling).toBe(39);
    expect(policy.backing.assuranceSeasonedCredit).toEqual({ points: 3, minMonths: 60 });
  });

  it("mint credit reaches but never exceeds the next merged-ladder rung", () => {
    const ladder = [
      ...Object.values(policy.control.mintPostureQuality),
      policy.control.mintPostureGrading.prudentialReconciled,
      policy.control.mintPostureGrading.attestationOnlyReconciled,
    ].sort((left, right) => left - right);
    // 9.32 ladder gains the 35 (unbounded-reconciliation-unknown) and 50
    // (collateral-gated) quality keys between the floor and concentrated-admin.
    expect(ladder).toEqual(expect.arrayContaining([25, 35, 50, 55, 70, 80, 85, 100]));
    expect(policy.control.mintPostureQuality["unbounded-reconciliation-unknown"]).toBe(35);
    expect(policy.control.mintPostureQuality["collateral-gated"]).toBe(50);
    for (const score of [25, 35, 50, 55, 70, 80, 85]) {
      const next = ladder.find((value) => value > score)!;
      const credited = Math.min(score + policy.control.mintPostureGrading.seasonedCreditPoints, next);
      expect(credited).toBeLessThanOrEqual(next);
      expect(credited).toBeGreaterThan(score);
    }
    // The top rung (none-resolved 100) has no rung above it: no credit headroom.
    const top = Math.max(...ladder);
    expect(ladder.find((value) => value > top)).toBeUndefined();
  });

  it("pins the adverse seasoning ceiling below unknown and above floor+credit", () => {
    // 9.32: unbounded-or-compromised and unbounded-reconciliation-unknown can
    // earn seasoned credit. The dedicated adverse ceiling (39) stops the floor
    // rung from silently capping at next-rung-minus-one (34) once the 35 rung
    // exists; the unknown-reconciliation rung keeps the generic ladder (44).
    const quality = policy.control.mintPostureQuality;
    const grading = policy.control.mintPostureGrading;
    expect(quality["unbounded-or-compromised"]).toBe(25);
    expect(quality["unbounded-reconciliation-unknown"]).toBe(35);
    expect(quality["collateral-gated"]).toBe(50);
    expect(grading.adverseSeasonedCreditCeiling).toBe(39);
    expect(grading.adverseSeasonedCreditCeiling).toBeLessThan(quality.unknown);
    expect(grading.adverseSeasonedCreditCeiling).toBeGreaterThanOrEqual(
      quality["unbounded-or-compromised"] + grading.seasonedCreditPoints,
    );
    expect(quality["unbounded-reconciliation-unknown"] + grading.seasonedCreditPoints - 1).toBe(44);
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
