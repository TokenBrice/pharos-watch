import { describe, expect, it } from "vitest";
import {
  V9MethodologyPolicySchema,
  type V9MethodologyPolicy,
  type V9StructuralSignal,
} from "../../types/safety-score-v9";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  projectV9DependencyScore,
  scoreV9EvaluatedAsset,
  type V9ProductionScoreInput,
} from "../safety-score-v9/score";
import { computeV9ResultDigest } from "../safety-score-v9/trace";

import { makeV9Pillar as pillar, makeV9ProductionScoreInput } from "./safety-score-v9-score.test-support";

function signal(
  kind: V9StructuralSignal["kind"],
  severity: V9StructuralSignal["severity"],
): V9StructuralSignal {
  return {
    kind,
    severity,
    reason: `${kind} ${severity} fixture`,
    failureDomainKeys: [],
    evidence: [],
  };
}


function healthyInput(): V9ProductionScoreInput {
  const input = makeV9ProductionScoreInput();
  return makeV9ProductionScoreInput({
    assetId: "usdt-tether",
    marketRank: 1,
    identity: {
      ...input.identity,
      sourceGenerations: { dex: "dex:1", reserves: "reserves:1" },
    },
    pillars: {
      backing: pillar(75),
      exit: pillar(75),
      control: pillar(75, {
        structuralSignals: [signal("centralized-mint", "low")],
      }),
    },
    trackRecordMonths: 141,
  });
}

describe("Safety Score V9 USDT market-anchor premium", () => {
  it("publishes a healthy native USDT at the A+ floor without exporting the premium", () => {
    const trace = scoreV9EvaluatedAsset(
      healthyInput(),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace).toMatchObject({
      finalScore: 87,
      inheritableScore: 75,
      finalGrade: "A+",
      preCapScore: 87,
      bindingCap: null,
      scoreAdjustments: [{
        source: "asset-premium",
        kind: "market-anchor-longevity",
        label: "#1 & Longevity Premium",
        configuredPoints: 12,
        appliedPoints: 12,
        scoreBefore: 75,
        scoreAfter: 87,
        publishedScoreBefore: 75,
        publishedScoreAfter: 87,
      }],
    });
    expect(projectV9DependencyScore(trace)).toBe(75);
  });

  it("adds the restored twelve-point premium without guaranteeing a grade band", () => {
    const input = healthyInput();
    input.pillars = {
      backing: pillar(56, { evidenceLevel: "limited" }),
      exit: pillar(75),
      control: pillar(75),
    };
    const trace = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);
    expect(trace).toMatchObject({
      finalScore: 78, finalGrade: "B+", inheritableScore: 66,
      scoreAdjustments: [{ configuredPoints: 12, appliedPoints: 12, publishedScoreBefore: 66 }],
    });
    expect(projectV9DependencyScore(trace)).toBe(66);
    const ordinary = scoreV9EvaluatedAsset({ ...input, assetId: "non-premium-fixture" }, V9_CANDIDATE_POLICY_V1);
    expect(ordinary).toMatchObject({ finalScore: 66, scoreAdjustments: [] });
  });

  it("preserves own-score rounding while applying the premium without cap relief", () => {
    const input = healthyInput();
    input.pillars = {
      backing: pillar(74.7481),
      exit: pillar(94.51),
      control: pillar(81.55, {
        structuralSignals: [signal("centralized-mint", "low")],
      }),
    };
    input.peg.score = 99;

    const trace = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);

    expect(trace.scoreAdjustments[0]).toMatchObject({
      scoreBefore: 82.5364,
      scoreAfter: 94.5364,
      publishedScoreBefore: 83,
      publishedScoreAfter: 87,
    });
    expect(trace.inheritableScore).toBe(83);
    expect(trace.finalScore).toBe(87);
    expect(trace.bindingCap).toBeNull();
    expect(trace.caps).toEqual([]);
  });

  it("binds both the adjustment and non-inheritable score to the result identity", () => {
    const trace = scoreV9EvaluatedAsset(
      healthyInput(),
      V9_CANDIDATE_POLICY_V1,
    );
    const digest = computeV9ResultDigest([trace]);

    expect(
      computeV9ResultDigest([{ ...trace, scoreAdjustments: [] }]),
    ).not.toBe(digest);
    expect(
      computeV9ResultDigest([{ ...trace, inheritableScore: trace.finalScore }]),
    ).not.toBe(digest);
  });

  it.each([
    ["not market rank one", (input: V9ProductionScoreInput) => { input.marketRank = 2; }],
    ["less than ten years old", (input: V9ProductionScoreInput) => { input.trackRecordMonths = 119; }],
    ["a degraded 45-point exit", (input: V9ProductionScoreInput) => { input.pillars.exit = pillar(45); }],
    ["insufficient pillar evidence", (input: V9ProductionScoreInput) => {
      input.pillars.backing = pillar(95, { evidenceLevel: "insufficient" });
    }],
    ["an unresolved peg reason", (input: V9ProductionScoreInput) => {
      input.peg.reasons = [{
        code: "missing-peg-input",
        path: "peg:history",
        message: "The peg history is unresolved.",
        responsibility: "integration-missing",
      }];
    }],
    ["historically dangerous peg performance", (input: V9ProductionScoreInput) => {
      input.peg.score = 70;
    }],
    ["an active depeg", (input: V9ProductionScoreInput) => { input.peg.activeDepegBps = 100; }],
    ["a serial parent", (input: V9ProductionScoreInput) => {
      input.parent = { required: true, score: 83, propagatedReasons: [] };
    }],
    ["a different asset", (input: V9ProductionScoreInput) => { input.assetId = "non-premium-fixture"; }],
  ])("withholds the premium for %s", (_name, mutate) => {
    const input = healthyInput();
    mutate(input);
    const trace = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);
    expect(trace.scoreAdjustments).toEqual([]);
    expect(trace.finalScore).not.toBe(87);
    expect(trace.inheritableScore).toBe(trace.finalScore);
  });

  it("cannot bypass a realized holder-loss ceiling", () => {
    const input = healthyInput();
    input.identity.asOfSec = Date.parse("2026-02-01") / 1000;
    input.realizedHolderLossEvents = [{
      incidentId: "premium-holder-loss", assetId: input.assetId, scope: { kind: "holder-exit" },
      occurredAt: "2026-01-01", realizedHolderLossPct: 2,
      primarySources: [{ label: "Holder haircut", url: "https://example.com/haircut", publishedAt: "2026-01-01" }],
      finding: "A mandatory holder haircut was executed.",
    }];
    const trace = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);
    expect(trace.scoreAdjustments).toEqual([]);
    expect(trace.bindingCap?.source).toBe("realized-holder-loss");
    expect(trace.finalScore).toBe(49);
  });

  it("lifts the current production-shaped healthy B+ base to the A+ floor", () => {
    const input = healthyInput();
    input.pillars = {
      backing: pillar(74.748258875),
      exit: pillar(73.88),
      control: pillar(81.55, {
        structuralSignals: [signal("centralized-mint", "low")],
      }),
    };
    input.peg.score = 99;

    const trace = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);

    expect(trace).toMatchObject({
      finalScore: 87,
      inheritableScore: 76,
      finalGrade: "A+",
      scoreAdjustments: [{
        configuredPoints: 12,
        appliedPoints: 12,
        publishedScoreBefore: 76,
        publishedScoreAfter: 87,
      }],
    });
  });

  it("applies below the B+ floor with limited Control evidence and issuer opacity", () => {
    const input = healthyInput();
    input.pillars = {
      backing: pillar(60.22),
      exit: pillar(97.32),
      control: pillar(79, {
        evidenceLevel: "limited",
        structuralSignals: [signal("centralized-mint", "low")],
      }),
    };

    const trace = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);
    const [adjustment] = trace.scoreAdjustments;

    expect(adjustment).toMatchObject({ kind: "market-anchor-longevity", configuredPoints: 12, appliedPoints: 12 });
    expect(adjustment!.publishedScoreBefore).toBeLessThan(75);
    expect(trace.finalScore).toBe(Math.min(adjustment!.publishedScoreBefore + 12, 87));
    expect(trace.inheritableScore).toBe(adjustment!.publishedScoreBefore);
  });

  it("keeps premium publication aligned to the A+ floor", () => {
    const invalid = structuredClone(
      V9_CANDIDATE_POLICY_V1.policy,
    ) as V9MethodologyPolicy;
    invalid.semantic.formula.assetPremiums[0]!.maximumPublishedScore = 86;

    expect(V9MethodologyPolicySchema.safeParse(invalid).success).toBe(false);
  });

  it("requires enough configured points to cross the B+-to-A+ threshold gap", () => {
    const invalid = structuredClone(
      V9_CANDIDATE_POLICY_V1.policy,
    ) as V9MethodologyPolicy;
    invalid.semantic.formula.assetPremiums[0]!.points = 11;

    expect(V9MethodologyPolicySchema.safeParse(invalid).success).toBe(false);
  });

});
