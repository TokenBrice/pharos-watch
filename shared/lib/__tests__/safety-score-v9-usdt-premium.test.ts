import { describe, expect, it } from "vitest";
import {
  V9MethodologyPolicySchema,
  type V9MethodologyPolicy,
  type V9StructuralSignal,
} from "../../types/safety-score-v9";
import type { V9OperationalResilienceResult } from "../safety-score-v9/operational-resilience";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  projectV9DependencyScore,
  scoreV9EvaluatedAsset,
  type V9PillarEvaluation,
  type V9ProductionScoreInput,
} from "../safety-score-v9/score";
import { computeV9ResultDigest } from "../safety-score-v9/trace";

const DIGEST = "a".repeat(64);
const BUILD_DIGEST = "b".repeat(64);
const BASE_ID = `report-cards-input:v1:${"c".repeat(64)}`;

function pillar(
  score: number,
  overrides: Partial<V9PillarEvaluation> = {},
): V9PillarEvaluation {
  return {
    score,
    evidenceLevel: "strong",
    reasons: [],
    structuralSignals: [],
    ...overrides,
  };
}

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

function operationalResilience(): V9OperationalResilienceResult {
  return {
    eligible: true,
    eligibility: {
      requiredLiveHistoryMonths: 84,
      documentedLiveHistoryMonths: 141,
      confidence: "audited",
      evidenceRefIds: ["history:usdt"],
      satisfied: true,
    },
    rawPillarCredits: { backing: 1, exit: 1, control: 0 },
    pillarCredits: { backing: 1, exit: 1, control: 0 },
    contributions: [
      {
        component: "stress-redemption",
        pillar: "exit",
        basePoints: 1,
        confidence: "audited",
        confidenceMultiplier: 1,
        points: 1,
        evidenceRefIds: ["redemption:usdt"],
      },
      {
        component: "reserve-reconciliation",
        pillar: "backing",
        basePoints: 1,
        confidence: "audited",
        confidenceMultiplier: 1,
        points: 1,
        evidenceRefIds: ["reserves:usdt"],
      },
    ],
    blockerCodes: [],
  };
}

function healthyInput(): V9ProductionScoreInput {
  return {
    assetId: "usdt-tether",
    marketRank: 1,
    identity: {
      factSetDigest: DIGEST,
      baseInputGenerationId: BASE_ID,
      evaluationBuildDigest: BUILD_DIGEST,
      asOfSec: 1_000,
      sourceGenerations: { dex: "dex:1", reserves: "reserves:1" },
    },
    pillars: {
      backing: pillar(95),
      exit: pillar(95),
      control: pillar(95, {
        structuralSignals: [signal("centralized-mint", "low")],
      }),
    },
    peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [] },
    trackRecordMonths: 141,
    parent: { required: false, score: null, propagatedReasons: [] },
    dependencyReasons: [],
    dependencyStructuralSignals: [],
    operationalResilience: operationalResilience(),
  };
}

describe("Safety Score V9 USDT market-anchor premium", () => {
  it("publishes a healthy native USDT at the A+ floor without exporting the premium", () => {
    const trace = scoreV9EvaluatedAsset(
      healthyInput(),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(trace).toMatchObject({
      finalScore: 87,
      inheritableScore: 83,
      finalGrade: "A+",
      preCapScore: 100,
      bindingCap: {
        source: "structural",
        kind: "signal:centralized-mint:low",
        limit: 87,
      },
      scoreAdjustments: [{
        source: "asset-premium",
        kind: "market-anchor-longevity",
        label: "#1 & Longevity Premium",
        configuredPoints: 12,
        appliedPoints: 5,
        scoreBefore: 95,
        scoreAfter: 100,
        publishedScoreBefore: 83,
        publishedScoreAfter: 87,
        capRelief: {
          source: "structural",
          kind: "signal:centralized-mint:low",
          fromLimit: 83,
          toLimit: 87,
        },
      }],
    });
    expect(projectV9DependencyScore(trace)).toBe(83);
  });

  it("handles the production rounding boundary while binding only the relieved cap", () => {
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
    expect(trace.bindingCap).toMatchObject({
      source: "structural",
      kind: "signal:centralized-mint:low",
      limit: 87,
    });
    expect(trace.caps).toEqual([
      expect.objectContaining({
        kind: "signal:centralized-mint:low",
        limit: 87,
        binding: true,
      }),
    ]);
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
    ["non-strong pillar evidence", (input: V9ProductionScoreInput) => {
      input.pillars.backing = pillar(95, { evidenceLevel: "adequate" });
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
    ["an operational blocker", (input: V9ProductionScoreInput) => {
      input.operationalResilience = {
        ...operationalResilience(),
        eligible: false,
        blockerCodes: ["activeDepeg"],
      };
    }],
    ["missing reserve reconciliation", (input: V9ProductionScoreInput) => {
      const resilience = operationalResilience();
      input.operationalResilience = {
        ...resilience,
        contributions: resilience.contributions.filter(
          (contribution) => contribution.component !== "reserve-reconciliation",
        ),
      };
    }],
    ["a different asset", (input: V9ProductionScoreInput) => { input.assetId = "usdc-circle"; }],
  ])("withholds the premium for %s", (_name, mutate) => {
    const input = healthyInput();
    mutate(input);
    const trace = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);
    expect(trace.scoreAdjustments).toEqual([]);
    expect(trace.finalScore).not.toBe(87);
    expect(trace.inheritableScore).toBe(trace.finalScore);
  });

  it("keeps a competing structural cap fully binding", () => {
    const input = healthyInput();
    input.pillars.control = pillar(95, {
      structuralSignals: [
        signal("centralized-mint", "low"),
        signal("unsafe-backing", "low"),
      ],
    });
    const trace = scoreV9EvaluatedAsset(input, V9_CANDIDATE_POLICY_V1);

    expect(trace.scoreAdjustments).toEqual([]);
    expect(trace.bindingCap?.kind).toBe("signal:centralized-mint:low");
    expect(trace.caps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "signal:unsafe-backing:low",
          limit: 84,
          binding: false,
        }),
      ]),
    );
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

  it("keeps premium eligibility and publication aligned to the B+ and A+ floors", () => {
    const invalid = structuredClone(
      V9_CANDIDATE_POLICY_V1.policy,
    ) as V9MethodologyPolicy;
    invalid.semantic.formula.assetPremiums[0]!.minimumBaseScore = 74;

    expect(V9MethodologyPolicySchema.safeParse(invalid).success).toBe(false);
  });

  it("requires enough configured points to cross the B+-to-A+ threshold gap", () => {
    const invalid = structuredClone(
      V9_CANDIDATE_POLICY_V1.policy,
    ) as V9MethodologyPolicy;
    invalid.semantic.formula.assetPremiums[0]!.points = 11;

    expect(V9MethodologyPolicySchema.safeParse(invalid).success).toBe(false);
  });

  it("requires cap relief to name an exact registered structural signal", () => {
    const invalid = structuredClone(
      V9_CANDIDATE_POLICY_V1.policy,
    ) as V9MethodologyPolicy;
    invalid.semantic.formula.assetPremiums[0]!.capRelief.kind =
      "signal:centralized-mint:low:ignored";

    expect(V9MethodologyPolicySchema.safeParse(invalid).success).toBe(false);
  });
});
