import { describe, expect, it } from "vitest";
import type { V9CapTrace, V9NRReason } from "../safety-score-v9/formula";
import type { V9PublicCardProjectionInput } from "../safety-score-v9/public";
import { buildSafetyScoreV9Response, projectSafetyScoreV9Card } from "../safety-score-v9/public";
import type { V9ProductionScoreTrace } from "../safety-score-v9/score";

const DIGESTS = {
  policy: "a".repeat(64),
  facts: "b".repeat(64),
  base: `report-cards-input:v1:${"c".repeat(64)}`,
  build: "d".repeat(64),
  stress: "e".repeat(64),
} as const;

const freshness = { backing: "current", exit: "current", control: "current" } as const;
const access = {
  transfer: "permissionless" as const,
  freezeExposure: "none-known" as const,
  primaryExit: "permissionless" as const,
  governance: "distributed" as const,
  unknownFields: [],
  signals: ["freeze:none-known", "governance:distributed", "primary-exit:permissionless", "transfer:permissionless"],
};

interface FixtureOptions {
  score: number | null;
  grade: V9ProductionScoreTrace["finalGrade"];
  pillars?: { backing: number | null; exit: number | null; control: number | null };
  qualityScore?: number | null;
  pegAdjustedScore?: number | null;
  caps?: readonly V9CapTrace[];
  nrReasons?: readonly V9NRReason[];
  dependency?: V9PublicCardProjectionInput["dependencyInputs"];
}

function fixture(assetId: string, options: FixtureOptions): V9PublicCardProjectionInput {
  const pillars = options.pillars ?? { backing: 92, exit: 90, control: 94 };
  const qualityScore =
    options.qualityScore === undefined ? (options.score === null ? null : 91.8) : options.qualityScore;
  const pegAdjustedScore =
    options.pegAdjustedScore === undefined ? (options.score === null ? null : qualityScore) : options.pegAdjustedScore;
  const caps = options.caps ?? [];
  const nrReasons = options.nrReasons ?? [];
  const pillarContributions = (["backing", "exit", "control"] as const).flatMap((pillar) => {
    const score = pillars[pillar];
    return score === null
      ? []
      : [
          {
            pillar,
            score,
            weight: pillar === "backing" ? 0.4 : pillar === "exit" ? 0.35 : 0.25,
            weightedContribution: score,
          },
        ];
  });
  const trace: V9ProductionScoreTrace = {
    assetId,
    policyId: "safety-score-v9-candidate-v1",
    policyDigest: DIGESTS.policy,
    configName: "safety-score-v9-candidate-v1",
    pillarContributions,
    weightedQuality: qualityScore,
    weakestPillar: Object.values(pillars).some((score) => score === null)
      ? null
      : { pillar: "exit", score: pillars.exit! },
    pegMultiplier: pegAdjustedScore === null ? null : 1,
    preCapScore: pegAdjustedScore,
    caps,
    bindingCap: caps.find((cap) => cap.binding) ?? null,
    structuralSignals: [],
    finalScore: options.score,
    finalGrade: options.grade,
    nrReasons,
    propagatedParentReasons: [],
    factSetDigest: DIGESTS.facts,
    baseInputGenerationId: DIGESTS.base,
    evaluationBuildDigest: DIGESTS.build,
    asOfSec: 1_000,
    sourceGenerations: { dex: "dex:g1", registry: "registry:g1" },
  };
  const dependencyInputs = options.dependency ?? { assetId, serial: [], basket: [], cycleBlocked: false };
  const dependencyReasons = dependencyInputs.serial.some((dependency) => dependency.blocked)
    ? [
        {
          code: "missing-parent-score" as const,
          path: `dependency:serial:${dependencyInputs.serial[0]!.upstreamAssetId}`,
          message: "Required upstream is not rateable.",
        },
      ]
    : [];

  return {
    trace,
    scoreInput: {
      pillars: {
        backing: {
          score: pillars.backing,
          evidenceLevel: pillars.backing === null ? "insufficient" : "strong",
          reasons:
            pillars.backing === null
              ? [{ code: "missing-pillar-evidence", path: "backing", message: "Backing evidence is missing." }]
              : [],
          structuralSignals: [],
        },
        exit: { score: pillars.exit, evidenceLevel: "strong", reasons: [], structuralSignals: [] },
        control: { score: pillars.control, evidenceLevel: "strong", reasons: [], structuralSignals: [] },
      },
      peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [] },
      dependencyReasons,
      methodologyReasons: [],
    },
    access,
    dependencyInputs,
    stressState: { stateDigest: DIGESTS.stress },
    freshness,
  };
}

function cap(args: Pick<V9CapTrace, "kind" | "limit" | "source" | "reason" | "binding">): V9CapTrace {
  return args;
}

describe("Safety Score v9 public projection", () => {
  it("publishes complete, capped, dependency-bound, and NR candidate fixtures", () => {
    const complete = fixture("complete", { score: 91.8, grade: "A+" });
    const capped = fixture("capped", {
      score: 64,
      grade: "C+",
      caps: [
        cap({
          kind: "bounded-compensability",
          limit: 98,
          source: "bounded-compensability",
          reason: "Weakest-pillar headroom.",
          binding: false,
        }),
        cap({
          kind: "signal:material-bridge:high",
          limit: 64,
          source: "structural",
          reason: "A material bridge binds.",
          binding: true,
        }),
      ],
    });
    const dependency = fixture("dependency", {
      score: 75,
      grade: "B+",
      caps: [cap({ kind: "parent", limit: 75, source: "parent", reason: "Required parent ceiling.", binding: true })],
      dependency: {
        assetId: "dependency",
        serial: [{ upstreamAssetId: "upstream", score: 75, blocked: false }],
        basket: [],
        cycleBlocked: false,
      },
    });
    const notRated = fixture("not-rated", {
      score: null,
      grade: "NR",
      pillars: { backing: null, exit: 90, control: 94 },
      nrReasons: [{ code: "missing-pillar", field: "pillars.backing", message: "Backing is missing." }],
    });

    const response = buildSafetyScoreV9Response({
      candidateId: "candidate-v1",
      policyVersion: "candidate-v1",
      publicationGenerationId: "report-cards:v9:candidate:1000",
      publishedAtSec: 1_001,
      results: [notRated, dependency, complete, capped],
    });

    expect(response.model).toBe("v9-critical-path");
    expect(response.lifecycle).toBe("candidate");
    expect(response.cards.map((card) => card.id)).toEqual(["capped", "complete", "dependency", "not-rated"]);
    expect(response.completeness).toEqual({
      expectedCount: 4,
      ratedCount: 3,
      notRatedCount: 1,
      notRatedIds: ["not-rated"],
    });
    expect(response.cards[0]?.caps).toHaveLength(2);
    expect(response.cards[0]?.bindingCap?.kind).toBe("signal:material-bridge:high");
    expect(response.cards[2]?.dependencies.serial[0]?.upstreamAssetId).toBe("upstream");
    expect(response.cards[2]?.bindingCap?.source).toBe("parent");
    expect(response.cards[3]?.nrReasons).toEqual([
      { code: "missing-pillar", field: "pillars.backing", message: "Backing is missing.", origin: "asset" },
    ]);
    expect(response.resultDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps access unknowns, signals, reasons, evidence, and all score stages explicit", () => {
    const input = fixture("unknown-access", { score: 91.8, grade: "A+" });
    input.access = {
      transfer: "unknown",
      freezeExposure: "possible",
      primaryExit: "permissionless",
      governance: "unknown",
      unknownFields: ["governance", "transfer"],
      signals: ["freeze:possible", "governance:unknown", "primary-exit:permissionless", "transfer:unknown"],
      reasons: [
        { code: "unresolved-control-identity", path: "access:governance", message: "Governance is unresolved." },
      ],
    };
    input.freshness = { backing: "current", exit: "stale", control: "current" };
    input.evidenceReasons = [{ code: "historical-critical-input", path: "exit", message: "Exit evidence is stale." }];

    const card = projectSafetyScoreV9Card(input);

    expect(card).toMatchObject({
      qualityScore: 91.8,
      pegMultiplier: 1,
      pegAdjustedScore: 91.8,
      evidence: { level: "strong", freshness: "stale" },
      accessPosture: { unknownFields: ["governance", "transfer"] },
      stressStateDigest: DIGESTS.stress,
    });
    expect(card.reasonCodes).toEqual(["historical-critical-input", "unresolved-control-identity"]);
  });

  it("rejects duplicate assets and mixed evaluator identities", () => {
    const base = fixture("alpha", { score: 91.8, grade: "A+" });
    expect(() =>
      buildSafetyScoreV9Response({
        candidateId: "candidate-v1",
        policyVersion: "candidate-v1",
        publicationGenerationId: "candidate:1",
        publishedAtSec: 1_001,
        results: [base, base],
      }),
    ).toThrow(/Duplicate/);

    const mixed = fixture("beta", { score: 90, grade: "A+" });
    mixed.trace.evaluationBuildDigest = "f".repeat(64);
    expect(() =>
      buildSafetyScoreV9Response({
        candidateId: "candidate-v1",
        policyVersion: "candidate-v1",
        publicationGenerationId: "candidate:1",
        publishedAtSec: 1_001,
        results: [base, mixed],
      }),
    ).toThrow(/mixes evaluation build/);
  });
});
