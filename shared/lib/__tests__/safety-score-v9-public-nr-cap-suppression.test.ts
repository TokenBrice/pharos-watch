import { describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  projectSafetyScoreV9Card,
  type V9PublicCardProjectionInput,
} from "../safety-score-v9/public";
import type { V9CapTrace } from "../safety-score-v9/formula";
import type { V9ProductionScoreTrace } from "../safety-score-v9/score";
import {
  SafetyScoreV9CurrentCardSchema,
} from "../../types/safety-score-v9-public";

const CAP: V9CapTrace = {
  source: "evidence",
  kind: "reason:runtime-bridge-materiality-unavailable",
  limit: 55,
  reason: "Bridge materiality is unavailable.",
  binding: true,
};

const ACCESS = {
  transfer: "permissionless" as const,
  freezeExposure: "none-known" as const,
  primaryExit: "permissionless" as const,
  governance: "distributed" as const,
  unknownFields: [],
  signals: [
    "freeze:none-known",
    "governance:distributed",
    "primary-exit:permissionless",
    "transfer:permissionless",
  ],
};

function fixture(assetId: string, rated: boolean): V9PublicCardProjectionInput {
  const score = rated ? 91.8 : null;
  const pillars = {
    backing: rated ? 92 : null,
    exit: 90,
    control: 94,
  } as const;
  const pillarContributions = [
    ...(rated
      ? [{ pillar: "backing" as const, score: 92, weight: 0.4, weightedContribution: 92 }]
      : []),
    { pillar: "exit" as const, score: 90, weight: 0.35, weightedContribution: 90 },
    { pillar: "control" as const, score: 94, weight: 0.25, weightedContribution: 94 },
  ];
  const nrReasons = rated
    ? []
    : [{ code: "missing-pillar" as const, field: "pillars.backing", message: "Backing is missing." }];
  // The trace carries V9NRReason (code/field/message); a pillar carries
  // V9PublicReason (code/path/message/responsibility). Same fact, two shapes.
  const pillarReasons = rated
    ? []
    : [
        {
          code: "missing-pillar" as const,
          path: "pillars.backing",
          message: "Backing is missing.",
          responsibility: "integration-missing" as const,
        },
      ];
  const trace: V9ProductionScoreTrace = {
    assetId,
    policyId: "safety-score-v9",
    policyDigest: "a".repeat(64),
    configName: "safety-score-v9",
    pillarContributions,
    weightedQuality: rated ? 91.8 : null,
    weakestPillar: rated ? { pillar: "exit", score: 90 } : null,
    aggregation: rated
      ? {
          method: "smooth-bounded-headroom",
          score: 91.8,
          weightedQuality: 91.8,
          weakestPillar: "exit",
          weakestScore: 90,
          headroom: 45,
        }
      : null,
    pegMultiplier: rated ? 1 : null,
    baseAssetScore: rated ? 91.8 : null,
    deploymentAdjustedScore: rated ? 91.8 : null,
    deploymentAdjustments: [],
    unresolvedDeploymentSignals: [],
    preCapScore: rated ? 91.8 : null,
    scoreAdjustments: [],
    caps: [CAP],
    bindingCap: CAP,
    structuralSignals: [],
    finalScore: score,
    inheritableScore: score,
    finalGrade: rated ? "A+" : "NR",
    adverseAttribution: [],
    boundedUncertaintyAttribution: [],
    unresolvedFacts: [],
    nrReasons,
    propagatedParentReasons: [],
    factSetDigest: "b".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
    evaluationBuildDigest: "d".repeat(64),
    asOfSec: 1_000,
    sourceGenerations: { registry: "registry:g1" },
    operationalResilience: null,
    wrapperParentLimit: null,
  };

  return {
    trace,
    policy: V9_CANDIDATE_POLICY_V1,
    scoreInput: {
      pillars: {
        backing: {
          score: pillars.backing,
          evidenceLevel: rated ? "strong" : "insufficient",
          reasons: pillarReasons,
          structuralSignals: [],
        },
        exit: { score: pillars.exit, evidenceLevel: "strong", reasons: [], structuralSignals: [] },
        control: { score: pillars.control, evidenceLevel: "strong", reasons: [], structuralSignals: [] },
      },
      peg: { applicable: true, score: rated ? 100 : null, activeDepegBps: null, reasons: [] },
      dependencyReasons: [],
      methodologyReasons: [],
    },
    access: ACCESS,
    dependencyInputs: { assetId, serial: [], basket: [], cycleBlocked: false },
    ...(rated
      ? {
          backing: {
            archetype: "fiat-cash",
            score: 92,
            contributions: [{
              componentKey: "reserve:cash",
              source: "reserve-exposure" as const,
              score: 92,
              normalizedWeight: 1,
              weightedScore: 92,
              observationState: "known" as const,
              provenance: "curated" as const,
              evidenceRefIds: [],
              failureDomains: [],
              upstreamAssetId: null,
            }],
          },
          exit: {
            score: 90,
            stressRequest: null,
            primaryRouteKey: null,
            diversificationRouteKey: null,
            diversificationBonus: 0,
            routes: [],
          },
          control: {
            score: 94,
            components: [{
              componentKey: "control:mint",
              kind: "mint" as const,
              posture: "bounded-admin" as const,
              score: 94,
              binding: true,
              controlKeys: [],
              failureDomains: [],
            }],
          },
        }
      : {}),
  };
}

describe("Safety Score v9 public NR cap suppression", () => {
  it("keeps NR cap candidates as diagnostics but suppresses all binding assertions", () => {
    const card = projectSafetyScoreV9Card(fixture("not-rated", false));

    expect(card.score).toBeNull();
    expect(card.bindingCap).toBeNull();
    expect(card.caps).toEqual([
      expect.objectContaining({
        kind: CAP.kind,
        limit: CAP.limit,
        source: CAP.source,
        binding: false,
      }),
    ]);
    expect(card.caps.every((cap) => !cap.binding)).toBe(true);
  });

  it("keeps the rated binding cap unchanged", () => {
    const card = projectSafetyScoreV9Card(fixture("rated", true));

    expect(card.score).not.toBeNull();
    expect(card.caps[0]?.binding).toBe(true);
    expect(card.bindingCap).toEqual(card.caps[0]);
  });

  it("rejects hand-built NR cards with a binding cap or binding candidate", () => {
    const card = projectSafetyScoreV9Card(fixture("not-rated", false));
    const withBindingCap = {
      ...card,
      bindingCap: { ...card.caps[0]!, binding: true },
    };
    const withBindingCandidate = {
      ...card,
      caps: card.caps.map((cap) => ({ ...cap, binding: true })),
    };

    expect(SafetyScoreV9CurrentCardSchema.safeParse(withBindingCap).success).toBe(false);
    expect(SafetyScoreV9CurrentCardSchema.safeParse(withBindingCandidate).success).toBe(false);
  });
});
