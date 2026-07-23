import { describe, expect, it } from "vitest";
import {
  SafetyScoreV9CurrentResponseSchema,
  SafetyScoreV9LegacyResponseSchema,
  SafetyScoreV9ResponseSchema,
} from "../safety-score-v9-public";

const DIGEST = "a".repeat(64);

function pillar(score: number) {
  return {
    score,
    evidenceLevel: "strong",
    freshness: "current",
    components: [],
    reasons: [],
  } as const;
}

function response() {
  return {
    model: "v9-critical-path",
    schemaVersion: 1,
    lifecycle: "candidate",
    candidateId: "candidate-v1",
    policyVersion: "candidate-v1",
    publicationGenerationId: "safety-score:v9:1",
    baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
    factSetDigest: DIGEST,
    resultDigest: "c".repeat(64),
    policy: { id: "safety-score-v9-candidate-v1", semanticDigest: "d".repeat(64) },
    evaluationBuildDigest: "e".repeat(64),
    sourceGenerations: { dex: "dex:g1", registry: "registry:g1" },
    asOfSec: 100,
    publishedAtSec: 101,
    completeness: { expectedCount: 1, ratedCount: 1, notRatedCount: 0, notRatedIds: [] },
    cards: [
      {
        id: "asset",
        score: 90,
        grade: "A+",
        qualityScore: 92,
        pegMultiplier: 1,
        pegAdjustedScore: 92,
        pillars: { backing: pillar(90), exit: pillar(92), control: pillar(94) },
        weakestPillar: { pillar: "backing", score: 90 },
        caps: [
          {
            kind: "bounded-compensability",
            limit: 98,
            source: "bounded-compensability",
            reason: "Weakest-pillar headroom.",
            binding: false,
          },
          { kind: "track-record", limit: 90, source: "track-record", reason: "Track record binds.", binding: true },
        ],
        bindingCap: {
          kind: "track-record",
          limit: 90,
          source: "track-record",
          reason: "Track record binds.",
          binding: true,
        },
        nrReasons: [],
        reasonCodes: [],
        evidence: { level: "strong", freshness: "current", reasons: [] },
        accessPosture: {
          transfer: "restrictable",
          freezeExposure: "direct",
          primaryExit: "eligibility-gated",
          governance: "single-entity",
          unknownFields: [],
          signals: [
            "freeze:direct",
            "governance:single-entity",
            "primary-exit:eligibility-gated",
            "transfer:restrictable",
          ],
          reasons: [],
        },
        dependencies: { serial: [], basket: [], cycleBlocked: false, reasonCodes: [] },
        stressStateDigest: "f".repeat(64),
      },
    ],
  } as const;
}

function currentResponse() {
  const current = structuredClone(response()) as unknown as {
    schemaVersion: number;
    cards: Array<{ scoreTrace?: unknown }>;
  };
  current.schemaVersion = 2;
  current.cards[0]!.scoreTrace = {
    schemaVersion: 1,
    legacyAliases: {
      qualityScore: "weighted-pillar-mean",
      pegAdjustedScore: "post-deployment-pre-cap-score",
      score: "post-cap-public-score",
    },
    aggregation: {
      method: "smooth-bounded-headroom",
      score: 92,
      weightedPillarMean: 92,
      weakestPillar: "backing",
      weakestScore: 90,
      headroom: 45,
    },
    stages: {
      weightedPillarMean: 92,
      aggregatedQualityScore: 92,
      pegMultiplier: 1,
      baseAssetScore: 92,
      deploymentAdjustedScore: 92,
      deploymentAdjustmentPoints: 0,
      preCapScore: 92,
      publishedScore: 90,
    },
    deploymentRisk: {
      method: "holder-slice-exposure-weighted-v2",
      totalAdjustmentPoints: 0,
      adjustments: [],
      unresolvedExposures: [],
    },
    adverseAttribution: {
      semantics: "causal-measured-adverse-v1",
      items: [],
    },
    evidenceResponsibility: {
      semantics: "limiting-fact-owner-v1",
      totalFactCount: 0,
      summaries: [
        { responsibility: "integration-missing", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
        { responsibility: "issuer-undisclosed", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
        { responsibility: "measured-adverse", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
        { responsibility: "method-unsupported", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
        { responsibility: "producer-failed", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
      ],
    },
    wrapperParentLimit: null,
  };
  return current;
}

describe("SafetyScoreV9ResponseSchema", () => {
  it("retains a strict schema-v1 reader for persisted candidate artifacts", () => {
    const parsed = SafetyScoreV9LegacyResponseSchema.parse(response());
    expect(parsed.cards[0]?.grade).toBe("A+");
    expect(parsed.lifecycle).toBe("candidate");
    expect(SafetyScoreV9ResponseSchema.parse(parsed).schemaVersion).toBe(1);
  });

  it("requires the self-describing score trace on every current candidate card", () => {
    const parsed = SafetyScoreV9CurrentResponseSchema.parse(currentResponse());
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.cards[0]?.scoreTrace.aggregation?.method).toBe("smooth-bounded-headroom");
    expect(parsed.cards[0]?.scoreTrace.legacyAliases.pegAdjustedScore).toBe(
      "post-deployment-pre-cap-score",
    );
    expect(SafetyScoreV9ResponseSchema.parse(parsed).schemaVersion).toBe(2);

    const missingTrace = currentResponse();
    delete missingTrace.cards[0]!.scoreTrace;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(missingTrace)).toThrow();

    const inconsistentTrace = currentResponse();
    const scoreTrace = inconsistentTrace.cards[0]!.scoreTrace as {
      stages: { preCapScore: number };
    };
    scoreTrace.stages.preCapScore = 91;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(inconsistentTrace)).toThrow(
      /explicit preCapScore must match/,
    );
  });

  it("allows bounded D without measured attribution but keeps F danger-attributed", () => {
    const bounded = currentResponse() as unknown as {
      cards: Array<{
        score: number;
        grade: string;
        scoreTrace: {
          stages: { publishedScore: number };
          adverseAttribution: { items: unknown[] };
        };
      }>;
    };
    bounded.cards[0]!.score = 45;
    bounded.cards[0]!.grade = "D";
    bounded.cards[0]!.scoreTrace.stages.publishedScore = 45;
    expect(SafetyScoreV9CurrentResponseSchema.parse(bounded).cards[0]?.grade).toBe("D");

    const unattributedDanger = structuredClone(bounded);
    unattributedDanger.cards[0]!.score = 35;
    unattributedDanger.cards[0]!.grade = "F";
    unattributedDanger.cards[0]!.scoreTrace.stages.publishedScore = 35;
    expect(() => SafetyScoreV9CurrentResponseSchema.parse(unattributedDanger)).toThrow(
      /F card requires causal measured-adverse attribution/,
    );
  });

  it("does not permit an active lifecycle or a final 9.0 policy label", () => {
    const invalid = structuredClone(response()) as Record<string, unknown>;
    invalid.lifecycle = "active";
    invalid.policyVersion = "9.0";
    expect(() => SafetyScoreV9ResponseSchema.parse(invalid)).toThrow();
  });

  it("requires null scores to agree with NR membership and reasons", () => {
    const invalid = structuredClone(response());
    Object.assign(invalid.cards[0], { score: null });
    expect(() => SafetyScoreV9ResponseSchema.parse(invalid)).toThrow(/NR grade and null score must agree/);
  });

  it("requires binding-cap and access-unknown summaries to be exact", () => {
    const invalidCap = structuredClone(response());
    Object.assign(invalidCap.cards[0], { bindingCap: null });
    expect(() => SafetyScoreV9ResponseSchema.parse(invalidCap)).toThrow(/binding cap must match/);

    const invalidAccess = structuredClone(response());
    Object.assign(invalidAccess.cards[0].accessPosture, { governance: "unknown", unknownFields: [] });
    expect(() => SafetyScoreV9ResponseSchema.parse(invalidAccess)).toThrow(/unknown fields must exactly match/);
  });
});
