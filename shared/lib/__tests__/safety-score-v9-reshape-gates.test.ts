import { describe, expect, it } from "vitest";
import { hasV9DangerSignal, scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
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
  return { kind, severity, reason: `${kind}:${severity}`, failureDomainKeys: [], evidence: [] };
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

  it("does NOT withhold a measured-adverse control-25 asset — it lands rated D (D1+D5)", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(35, { evidenceLevel: "limited" }),
          exit: pillar(35, { evidenceLevel: "limited" }),
          control: pillar(25, { evidenceLevel: "limited" }),
        },
      }),
      POLICY,
    );
    // Withhold gate: control 25 < bounded-unknown 45 is measured-adverse, so
    // the asset stays rated. F-gate: 25 is the ladder's defined minimum, not
    // sub-floor, so the blend-arithmetic F floors to D (weakness priced in-pillar).
    expect(trace.finalGrade).toBe("D");
    expect(trace.finalScore).toBe(40);
    expect(trace.bindingCap?.kind).toBe("evidence-floor:d");
  });

  it("keeps a genuinely sub-floor pillar at F under both gates (u-united analog: backing < 35)", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(30, { evidenceLevel: "limited" }),
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

describe("Lever 2 — danger-gate F floors to D", () => {
  it("floors an evidence-gap-only would-be-F to D(40) with the evidence-floor:d marker", () => {
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
    expect(trace.finalScore).toBe(40);
    expect(trace.finalGrade).toBe("D");
    expect(trace.caps.map((cap) => cap.kind)).toContain("evidence-floor:d");
    expect(trace.bindingCap?.kind).toBe("evidence-floor:d");
  });

  it("floors at the formula boundary (limited count 0 skips Lever 1)", () => {
    const trace = scoreV9Input(rawInput(), POLICY);
    expect(trace.finalScore).toBe(40);
    expect(trace.finalGrade).toBe("D");
    expect(trace.caps.some((cap) => cap.kind === "evidence-floor:d")).toBe(true);
  });

  it("D1: a mint:high blend-arithmetic would-be-F floors to D (weakness stays priced in-pillar)", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(35, { evidenceLevel: "limited" }),
          exit: pillar(35),
          control: pillar(45, { structuralSignals: [signal("centralized-mint", "high")] }),
        },
      }),
      POLICY,
    );
    expect(trace.finalScore).toBe(40);
    expect(trace.finalGrade).toBe("D");
    expect(trace.bindingCap?.kind).toBe("evidence-floor:d");
    expect(trace.caps.find((cap) => cap.kind === "signal:centralized-mint:high")?.binding).toBe(false);
  });

  it("D1: peg multiplier in [0.8,0.9) is degraded-not-failing — rated D, never NR, never F", () => {
    const trace = scoreV9Input(
      rawInput({ pillars: { backing: 40, exit: 40, control: 50 }, pegScore: 66, evidenceLevel: "limited" }),
      POLICY,
      [],
      2,
      true,
    );
    expect(trace.finalGrade).toBe("D");
    expect(trace.finalScore).toBe(40);
    expect(trace.caps.some((cap) => cap.kind === "evidence-floor:d")).toBe(true);
  });
});

describe("Pin sentinels stay F (danger-held, never withheld or floored)", () => {
  it("u-united analog: fired-non-binding unsafe-backing:critical + control sub-floor", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(35),
          exit: pillar(35),
          control: pillar(25, { structuralSignals: [signal("unsafe-backing", "critical")] }),
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
