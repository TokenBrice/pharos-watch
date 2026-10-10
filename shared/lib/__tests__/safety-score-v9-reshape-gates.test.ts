import { describe, expect, it } from "vitest";
import { hasV9DangerSignal, scoreV9Input } from "../safety-score-v9/formula";
import { loadV9MethodologyPolicy, V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
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
import { evaluateV9EconomicControl } from "@shared/lib/safety-score-v9/control";
import {
  makeEconomicControlArgs,
  makeDeploymentControl,
  makeEconomicControlFacts,
  makeReviewedMintInput,
} from "./safety-score-v9-fixtures.test-support";

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

  it("keeps centralized mint and sub-0.9 peg history as withhold danger", () => {
    expect(hasV9DangerSignal({ ...base, structuralSignals: [signal("centralized-mint", "high")] }, POLICY)).toBe(true);
    expect(hasV9DangerSignal({ ...base, structuralSignals: [signal("centralized-mint", "critical")] }, POLICY)).toBe(true);
    expect(hasV9DangerSignal({ ...base, pegMultiplier: 0.85 }, POLICY)).toBe(true);
  });

  it("reads the danger floor from a counterfactual policy", () => {
    const changedPolicy = structuredClone(POLICY.policy);
    changedPolicy.semantic.formula.danger.withholdPegMultiplierFloor = 0.84;
    const counterfactual = loadV9MethodologyPolicy(changedPolicy);

    expect(hasV9DangerSignal({ ...base, pegMultiplier: 0.85 }, POLICY)).toBe(true);
    expect(hasV9DangerSignal({ ...base, pegMultiplier: 0.85 }, counterfactual)).toBe(false);
  });
});

describe("Lever 1 — insufficient-evidence withhold", () => {
  it("withholds a C-limited backing and C-limited second pillar below 55 without danger", () => {
    const trace = scoreV9EvaluatedAsset(
      assetInput({
        pillars: {
          backing: pillar(35, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:backing"] }),
          exit: pillar(35, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:exit"] }),
          control: pillar(45),
        },
      }),
      POLICY,
    );
    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons.map((reason) => reason.code)).toContain("insufficient-evidence");
    expect(trace.nrReasons).toContainEqual(expect.objectContaining({
      code: "insufficient-evidence", cause: "C", contributingPillars: ["backing", "exit"],
      causeGapIds: ["gap:backing", "gap:exit"],
    }));
  });

  it("treats U-limited backing and a U-limited second pillar as collective witnesses below 55", () => {
    const trace = scoreV9EvaluatedAsset(assetInput({ pillars: {
      backing: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["U"], causeGapIds: ["gap:backing"] }),
      exit: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["U"], causeGapIds: ["gap:exit"] }),
      control: pillar(60),
    } }), POLICY);
    expect(trace.finalGrade).toBe("NR");
    expect(trace.finalScore).toBeNull();
    expect(trace.nrReasons).toEqual([expect.objectContaining({
      code: "insufficient-evidence", field: "evidenceLevel", cause: "U",
      contributingPillars: ["backing", "exit"], causeGapIds: ["gap:backing", "gap:exit"],
    })]);
  });

  it("does not count a witness-less limited pillar or borrow its unrelated diagnostic gaps", () => {
    const baseline = scoreV9EvaluatedAsset(assetInput({ pillars: {
      backing: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:backing"] }),
      exit: pillar(50),
      control: pillar(60),
    } }), POLICY);
    const trace = scoreV9EvaluatedAsset(assetInput({ pillars: {
      backing: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:backing"] }),
      exit: pillar(50, {
        evidenceLevel: "limited", limitedEvidenceCauses: ["U"],
        causeGapIds: ["gap:unrelated-diagnostic"], limitingCauseGapIds: [],
      }),
      control: pillar(60),
    } }), POLICY);
    expect(trace.preCapScore).toBeLessThan(55);
    expect(trace.finalScore).toBe(baseline.finalScore);
    expect(trace.finalGrade).toBe(baseline.finalGrade);
    expect(trace.nrReasons).toEqual([]);
    expect(trace.limitingPillars.map((item) => item.pillar)).toEqual(["backing"]);
  });

  it.each(["C", "U"] as const)("does not let an unrelated %s diagnostic count a strong second pillar", (cause) => {
    const trace = scoreV9EvaluatedAsset(assetInput({ pillars: {
      backing: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:backing"] }),
      exit: pillar(50, { evidenceLevel: "strong", limitedEvidenceCauses: [cause], causeGapIds: ["gap:diagnostic"] }),
      control: pillar(60),
    } }), POLICY);
    expect(trace.finalGrade).not.toBe("NR");
    expect(trace.nrReasons).toEqual([]);
    expect(trace.limitingPillars.map((item) => item.pillar)).toEqual(["backing"]);
  });

  it("counts a U-limited second pillar alongside C-limited backing", () => {
    const trace = scoreV9EvaluatedAsset(assetInput({ pillars: {
      backing: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:backing"] }),
      exit: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["U"], causeGapIds: ["gap:exit"] }),
      control: pillar(60),
    } }), POLICY);
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons).toEqual([expect.objectContaining({
      code: "insufficient-evidence", cause: "C", contributingPillars: ["backing", "exit"],
    })]);
  });

  it.each(["A", "B"] as const)("never counts %s-only evidence gaps toward Lever1", (cause) => {
    const trace = scoreV9EvaluatedAsset(assetInput({ pillars: {
      backing: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: [cause], causeGapIds: ["gap:backing"] }),
      exit: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: [cause], causeGapIds: ["gap:exit"] }),
      control: pillar(60),
    } }), POLICY);
    expect(trace.finalScore).toBeLessThan(55);
    expect(trace.finalGrade).not.toBe("NR");
    expect(trace.limitingPillars).toEqual([]);
    expect(trace.nrReasons).toEqual([]);
  });

  it("does not withhold at the exclusive score threshold of 55", () => {
    const trace = scoreV9EvaluatedAsset(assetInput({ pillars: {
      backing: pillar(55, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:backing"] }),
      exit: pillar(55, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:exit"] }),
      control: pillar(55),
    } }), POLICY);
    expect(trace.finalScore).toBe(55);
    expect(trace.nrReasons).toEqual([]);
  });

  it("requires backing among the two C/D-limited pillars", () => {
    const trace = scoreV9EvaluatedAsset(assetInput({ pillars: {
      backing: pillar(50),
      exit: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:exit"] }),
      control: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["C"], causeGapIds: ["gap:control"] }),
    } }), POLICY);
    expect(trace.finalScore).toBe(50);
    expect(trace.nrReasons).toEqual([]);
  });

  it("records D rather than U when measured evidence supplies the collective witnesses", () => {
    const trace = scoreV9EvaluatedAsset(assetInput({ pillars: {
      backing: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["D"], causeGapIds: ["gap:backing"] }),
      exit: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["D"], causeGapIds: ["gap:exit"] }),
      control: pillar(50),
    } }), POLICY);
    expect(trace.nrReasons).toEqual([expect.objectContaining({
      code: "insufficient-evidence", cause: "D", contributingPillars: ["backing", "exit"],
    })]);
    expect(trace.finalScore).toBeNull();
  });

  it("withholds at the formula boundary when the limited count is threaded", () => {
    const trace = scoreV9Input(rawInput({ evidenceLevel: "limited" }), POLICY, [], 2, true, [], [], [], [], [], [], undefined, {
      includedPillars: ["backing", "exit", "control"], partialEvidence: null,
      limitingPillars: [{ pillar: "backing", causes: ["C"], causeGapIds: ["gap:backing"] }, { pillar: "exit", causes: ["C"], causeGapIds: ["gap:exit"] }],
    });
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons.map((reason) => reason.code)).toContain("insufficient-evidence");
  });

  it("counts U collective witnesses at the formula boundary", () => {
    const trace = scoreV9Input(rawInput({ pillars: { backing: 50, exit: 50, control: 60 }, evidenceLevel: "limited" }), POLICY, [], 2, true, [], [], [], [], [], [], undefined, {
      includedPillars: ["backing", "exit", "control"], partialEvidence: null,
      limitingPillars: [{ pillar: "backing", causes: ["U"], causeGapIds: ["gap:backing"] }, { pillar: "exit", causes: ["U"], causeGapIds: ["gap:exit"] }],
    });
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons).toEqual([expect.objectContaining({
      code: "insufficient-evidence", cause: "U", contributingPillars: ["backing", "exit"],
    })]);
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

  it("keeps measured sub-floor backing at F with causal attribution (u-united analog: backing < 35)", () => {
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

  it("flips pegMultiplier 0.85 from rated F to NR when the withhold danger floor drops below it", () => {
    const changedPolicy = structuredClone(POLICY.policy);
    changedPolicy.semantic.formula.danger.withholdPegMultiplierFloor = 0.84;
    const counterfactual = loadV9MethodologyPolicy(changedPolicy);

    const input = rawInput({
      pillars: { backing: 40, exit: 40, control: 50 },
      pegScore: 67, // pegMultiplier ≈ 0.85
      evidenceLevel: "limited",
    });

    const coverage = {
      includedPillars: ["backing", "exit", "control"] as const, partialEvidence: null,
      limitingPillars: [{ pillar: "backing" as const, causes: ["C" as const], causeGapIds: ["gap:backing"] }, { pillar: "exit" as const, causes: ["C" as const], causeGapIds: ["gap:exit"] }],
    };
    const baseline = scoreV9Input(input, POLICY, [], 2, true, [], [], [], [], [], [], undefined, coverage);
    const changed = scoreV9Input(input, counterfactual, [], 2, true, [], [], [], [], [], [], undefined, coverage);

    // Floor 0.9: 0.85 is danger, so the measured-adverse peg stays rated.
    expect(baseline.finalGrade).toBe("F");
    expect(baseline.finalScore).not.toBeNull();
    expect(baseline.nrReasons.map((reason) => reason.code)).not.toContain("insufficient-evidence");

    // Floor 0.84: 0.85 is no longer danger, so the two-limited-pillar input is withheld.
    expect(changed.finalGrade).toBe("NR");
    expect(changed.finalScore).toBeNull();
    expect(changed.nrReasons.map((reason) => reason.code)).toContain("insufficient-evidence");
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
      expect.objectContaining({ code: "f-without-measured-adverse", field: "adverseAttribution", cause: "U" }),
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
  const unbounded = makeDeploymentControl("mint:seasoned", "mint", {
    authority: { authorityKey: "authority:issuer", model: "issuer-backend", threshold: null },
    capSemantics: { kind: "unbounded", bound: null },
    claimImpairment: "unbounded",
  });

  it.each([[59, 55], [60, 59], [120, 59]] as const)(
    "caps a %i-month 55-base reconciled mint at %i below governed issuance", (trackRecordMonths, score) => {
      const result = evaluateV9EconomicControl(makeEconomicControlArgs({
        facts: makeEconomicControlFacts([unbounded]),
        mint: makeReviewedMintInput(unbounded.controlKey, { reconciliation: "continuous", supervision: "none" }),
        trackRecordMonths,
      }));
      expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
        posture: "unbounded-reconciled", score,
      });
    },
  );

  it.each(["not-applicable", "none", "unknown", "internal-ledger"] as const)(
    "keeps %s adverse seasoning under its configurable dedicated ceiling", (reconciliation) => {
      const changedPolicy = structuredClone(POLICY.policy);
      changedPolicy.semantic.control.mintPostureQuality["unbounded-adverse"] = 30;
      const result = evaluateV9EconomicControl(makeEconomicControlArgs({
        policy: loadV9MethodologyPolicy(changedPolicy),
        facts: makeEconomicControlFacts([unbounded]),
        mint: makeReviewedMintInput(unbounded.controlKey, { reconciliation, supervision: "none" }),
        trackRecordMonths: 60,
      }));
      expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
        posture: "unbounded-adverse", score: 39,
      });
    },
  );


  it("does not award seasoning above the resolved no-mint top rung", () => {
    for (const trackRecordMonths of [59, 60]) {
      const result = evaluateV9EconomicControl(makeEconomicControlArgs({ trackRecordMonths }));
      expect(result.components.find((component) => component.kind === "mint")).toMatchObject({
        posture: "none-resolved",
        score: 100,
      });
    }
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
