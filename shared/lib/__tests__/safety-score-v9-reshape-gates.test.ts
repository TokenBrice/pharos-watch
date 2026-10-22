import { describe, expect, it } from "vitest";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { scoreV9EvaluatedAsset } from "../safety-score-v9/score";
import type { V9ScoringInput, V9StructuralSignal } from "../../types/safety-score-v9";
import { makeV9Pillar as pillar, makeV9ProductionScoreInput as assetInput } from "./safety-score-v9-score.test-support";
import { evaluateV9EconomicControl } from "../safety-score-v9/control";
import { makeEconomicControlArgs, makeDeploymentControl, makeEconomicControlFacts, makeReviewedMintInput } from "./safety-score-v9-fixtures.test-support";

const POLICY = V9_CANDIDATE_POLICY_V1;

function rawInput(overrides: Partial<V9ScoringInput> = {}): V9ScoringInput {
  return {
    assetId: "asset", pillars: { backing: 35, exit: 35, control: 45 },
    pegScore: 100, pegApplicable: true, evidenceLevel: "strong", trackRecordMonths: 48,
    activeDepegBps: null, parentRequired: false, parentScore: null,
    structuralSignals: [], unresolved: [], ...overrides,
  };
}

function adverseSignal(kind: V9StructuralSignal["kind"]): V9StructuralSignal {
  return { kind, severity: "critical", reason: `Measured ${kind}.`, responsibility: "measured-adverse",
    failureDomainKeys: [], evidence: [] };
}

describe("evidence availability without grade or limited-pillar gates", () => {
  it.each([["C", "C"], ["U", "U"], ["C", "U"], ["D", "D"]] as const)(
    "rates admitted %s/%s limited pillars without converting their score to NR",
    (backingCause, exitCause) => {
      const input = assetInput({ pillars: {
        backing: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: [backingCause], causeGapIds: ["gap:backing"] }),
        exit: pillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: [exitCause], causeGapIds: ["gap:exit"] }),
        control: pillar(60),
      } });
      const trace = scoreV9EvaluatedAsset(input, POLICY);
      const measured = scoreV9EvaluatedAsset(assetInput({ pillars: {
        backing: pillar(50), exit: pillar(50), control: pillar(60),
      } }), POLICY);
      expect(trace.ratingStatus).toBe("rated");
      expect(trace.finalScore).toBe(measured.finalScore);
      expect(trace.finalGrade).toBe(measured.finalGrade);
      expect(trace.nrReasons).toEqual([]);
    },
  );

  it("preserves a low measured F even when no adverse witness was authored", () => {
    const trace = scoreV9Input(rawInput(), POLICY);
    expect(trace.ratingStatus).toBe("rated");
    expect(trace.finalGrade).toBe("F");
    expect(trace.finalScore).toBeLessThan(40);
    expect(trace.adverseAttribution).toEqual([]);
    expect(trace.nrReasons).toEqual([]);
  });

  it("retains genuinely unavailable required parents rather than inventing a ceiling", () => {
    const trace = scoreV9Input(rawInput({ parentRequired: true, parentScore: null }), POLICY, [{
      code: "missing-parent-score", message: "The required parent is unavailable.", cause: "U",
      causeGapIds: ["parent:missing"],
    }], [], [], [], [], undefined, {
      includedPillars: ["backing", "exit", "control"], partialEvidence: null, limitingPillars: [],
      parentStatus: "not-rated",
    });
    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBe("NR");
  });

  it("keeps fewer than two usable pillars a technical pipeline gap", () => {
    const trace = scoreV9Input(rawInput({ pillars: { backing: null, exit: null, control: 60 } }), POLICY);
    expect(trace.ratingStatus).toBe("pipeline-gap");
    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBeNull();
  });

  it("prices a missing pillar without inventing usable evidence or renormalizing weights", () => {
    const trace = scoreV9Input(rawInput({ pillars: { backing: null, exit: 80, control: 80 } }), POLICY);
    expect(trace).toMatchObject({
      ratingStatus: "rated",
      includedPillars: ["exit", "control"], excludedPillars: ["backing"],
    });
    expect(trace.finalScore).toBe(scoreV9Input(rawInput({
      pillars: { backing: 50, exit: 80, control: 80 },
    }), POLICY).finalScore);
    expect(trace.diagnosticPillarScores.backing).toBeNull();
    expect(trace.aggregation?.pricedUnknownPillars).toEqual([
      { pillar: "backing", score: 50, cause: "U", causeGapIds: [] },
    ]);
    expect(trace.effectiveScoringWeights).toEqual({ backing: 0.4, exit: 0.35, control: 0.25 });
    expect(trace.pillarContributions.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(1);
  });

  it("propagates a required parent with missing availability metadata as a causal pipeline gap", () => {
    const trace = scoreV9Input(rawInput({ parentRequired: true, parentScore: null }), POLICY);
    expect(trace).toMatchObject({
      ratingStatus: "pipeline-gap", finalScore: null, finalGrade: null,
      nrReasons: [expect.objectContaining({ code: "missing-parent-score", cause: "U" })],
    });
  });

  it("preserves the original cause of a required parent's technical gap", () => {
    const reason = { code: "missing-parent-score" as const, cause: "U" as const,
      message: "The parent has no admitted subjects.", causeGapIds: ["parent:subjects"] };
    const trace = scoreV9Input(rawInput({ parentRequired: true, parentScore: null }), POLICY,
      [reason], [], [], [], [], undefined, {
        includedPillars: ["backing", "exit", "control"], partialEvidence: null,
        limitingPillars: [], parentStatus: "pipeline-gap",
      });
    expect(trace.ratingStatus).toBe("pipeline-gap");
    expect(trace.finalScore).toBeNull();
    expect(trace.nrReasons).toEqual([reason]);
  });

  it("retains diagnostic uncertainty without claiming a scored contribution when a parent prevents aggregation", () => {
    const fact: V9ScoringInput["unresolved"][number] = {
      code: "missing-same-notional-route", critical: false,
      path: "exit:missing-same-notional-route", reason: "Comparable exit terms remain unknown.",
      cause: "U", responsibility: "unresearched", causeGapIds: ["asset:exit:terms"],
    };
    const trace = scoreV9Input(rawInput({
      parentRequired: true, parentScore: null, unresolved: [fact],
    }), POLICY, [], [], [], [], [{ pillar: "exit", fact }]);
    expect(trace.ratingStatus).toBe("pipeline-gap");
    expect(trace.aggregation).toBeNull();
    expect(trace.boundedUncertaintyAttribution).toEqual([]);
    expect(trace.unresolvedFacts).toContainEqual(fact);
  });
});

describe("measured adversity remains priced without structural whole-score caps", () => {
  it("keeps compromised Control25 and its causal evidence", () => {
    const trace = scoreV9EvaluatedAsset(assetInput({ pillars: {
      backing: pillar(35), exit: pillar(35),
      control: pillar(25, { structuralSignals: [{ ...adverseSignal("centralized-mint"), pricedInPillar: "control" }] }),
    } }), POLICY);
    expect(trace.finalGrade).toBe("F");
    expect(trace.finalScore).toBe(32);
    expect(trace.adverseAttribution).toContainEqual(expect.objectContaining({
      source: "structural-signal", path: "structural:centralized-mint:critical",
    }));
    expect(trace.bindingCap).toBeNull();
  });

  it("keeps measured degraded peg performance rated and attributed", () => {
    const trace = scoreV9Input(rawInput({ pillars: { backing: 40, exit: 40, control: 50 }, pegScore: 66, evidenceLevel: "limited" }), POLICY);
    expect(trace.finalGrade).toBe("F");
    expect(trace.finalScore).not.toBeNull();
    expect(trace.adverseAttribution).toContainEqual(expect.objectContaining({
      source: "peg-performance", path: "peg:historical-performance",
    }));
  });

  it("does not impose a second cap for a structural signal already priced in a pillar", () => {
    const baseline = scoreV9Input(rawInput({ pillars: { backing: 90, exit: 90, control: 60 } }), POLICY);
    const trace = scoreV9Input(rawInput({ pillars: { backing: 90, exit: 90, control: 60 },
      structuralSignals: [adverseSignal("centralized-mint")],
    }), POLICY);
    expect(trace.finalScore).toBe(baseline.finalScore);
    expect(trace.caps).toEqual(baseline.caps);
  });

  it.each([[2_500, 25], [3_000, 25], [4_999, 25], [5_000, 10], [6_000, 10]])(
    "retains a current active depeg backstop and never floors a measured zero (%i bps → %i)",
    (activeDepegBps, limit) => {
      const input = rawInput({ pillars: { backing: 65, exit: 65, control: 65 }, activeDepegBps });
      const backstop = scoreV9Input(input, POLICY);
      expect(backstop.finalScore).toBe(limit);
      expect(backstop.finalGrade).toBe("F");
      expect(backstop.caps).toContainEqual(expect.objectContaining({ source: "active-depeg", limit, binding: true }));

      const trace = scoreV9Input({ ...input, pegScore: 0 }, POLICY);
      expect(trace.finalScore).toBe(0);
      expect(trace.finalGrade).toBe("F");
      expect(trace.caps).toContainEqual(expect.objectContaining({ source: "active-depeg", limit, binding: false }));
    },
  );
});

describe("authority proof does not acquire a seasoning cliff", () => {
  const unbounded = makeDeploymentControl("mint:seasoned", "mint", {
    authority: { authorityKey: "authority:issuer", model: "issuer-backend", threshold: null },
    capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
  });
  it.each(["continuous", "none", "unknown", "internal-ledger"] as const)(
    "preserves identical %s authority facts across the former 60-month boundary", (reconciliation) => {
      const evaluate = (trackRecordMonths: number) => evaluateV9EconomicControl(makeEconomicControlArgs({
        facts: makeEconomicControlFacts([unbounded]),
        mint: makeReviewedMintInput(unbounded.controlKey, { reconciliation, supervision: "none" }), trackRecordMonths,
      }));
      expect(evaluate(59).score).toBe(evaluate(60).score);
    },
  );
});

describe("reserve concentration scope", () => {
  it("exempts exactly the reviewed sovereign classes", () => {
    expect(POLICY.policy.semantic.backing.reserve.sovereignConcentrationExemptClasses).toEqual(["treasury-bill", "government-security"]);
  });
  it("exempts only allocated commodities through the non-counterparty issuer rule", () => {
    expect(POLICY.policy.semantic.backing.reserve.nonCounterpartyReserveIssuerConcentrationExemptClasses).toEqual(["commodity-allocated"]);
  });
});
