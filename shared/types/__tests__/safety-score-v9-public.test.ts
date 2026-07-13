import { describe, expect, it } from "vitest";
import { SafetyScoreModelManifestSchema, SafetyScoreV9ResponseSchema } from "../safety-score-v9-public";

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
    publicationEpoch: 3,
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

describe("SafetyScoreV9ResponseSchema", () => {
  it("accepts a strict candidate V9 critical-path envelope", () => {
    const parsed = SafetyScoreV9ResponseSchema.parse(response());
    expect(parsed.cards[0]?.grade).toBe("A+");
    expect(parsed.lifecycle).toBe("candidate");
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

describe("SafetyScoreModelManifestSchema", () => {
  it("enforces state-authorized active aliases", () => {
    expect(
      SafetyScoreModelManifestSchema.parse({
        schemaVersion: 1,
        state: "v8-active-v9-shadow",
        activeModel: "v8",
        activeGenerationId: "v8:1",
        v8GenerationId: "v8:1",
        v9GenerationId: "v9:1",
        transitionEpoch: 0,
        updatedAtSec: 1,
      }).activeModel,
    ).toBe("v8");
    expect(() =>
      SafetyScoreModelManifestSchema.parse({
        schemaVersion: 1,
        state: "v8-active-v9-shadow",
        activeModel: "v9",
        activeGenerationId: "v9:1",
        v8GenerationId: "v8:1",
        v9GenerationId: "v9:1",
        transitionEpoch: 0,
        updatedAtSec: 1,
      }),
    ).toThrow(/requires v8 active/);
  });
});
