import { describe, expect, it } from "vitest";
import type { SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";
import { ReportCardsV9ResponseSchema } from "@shared/types/report-cards-v9";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { serializeSafetyScoreV9ShadowEnvelopeCacheValue } from "../safety-score-v9-cache-codec";
import { buildSafetyScoreV9ShadowEnvelope } from "../safety-score-v9-shadow";
import {
  loadPublishedReportCardsV9Snapshot,
  projectSafetyScoreV9CandidateToPublicSnapshot,
  ReportCardsV9SnapshotUnavailableError,
} from "../report-cards-v9-cache";
import { SAFETY_SCORE_V9_SHADOW_CACHE_KEYS } from "../safety-score-v9-store";

const digest = (character: string) => character.repeat(64);
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${digest("a")}`;

function candidate(): SafetyScoreV9Response {
  const pillar = {
    score: 90,
    evidenceLevel: "strong" as const,
    freshness: "current" as const,
    components: [],
    reasons: [],
  };
  return {
    model: "v9-critical-path",
    schemaVersion: 1,
    lifecycle: "candidate",
    candidateId: "candidate-v9-public-wire",
    policyVersion: "candidate-v9-public-wire",
    publicationGenerationId: "report-cards:v9:candidate:public-wire",
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    factSetDigest: digest("b"),
    resultDigest: digest("c"),
    policy: { id: "safety-score-v9-public-wire", semanticDigest: digest("d") },
    evaluationBuildDigest: digest("e"),
    sourceGenerations: { registry: "registry:public-wire" },
    asOfSec: 1_700_000_000,
    publishedAtSec: 1_700_000_030,
    completeness: { expectedCount: 1, ratedCount: 1, notRatedCount: 0, notRatedIds: [] },
    cards: [
      {
        id: "alpha",
        score: 90,
        grade: "A",
        qualityScore: 90,
        pegMultiplier: 1,
        pegAdjustedScore: 90,
        pillars: { backing: pillar, exit: pillar, control: pillar },
        weakestPillar: { pillar: "backing", score: 90 },
        caps: [],
        bindingCap: null,
        nrReasons: [],
        reasonCodes: [],
        evidence: { level: "strong", freshness: "current", reasons: [] },
        accessPosture: {
          transfer: "permissionless",
          freezeExposure: "none-known",
          primaryExit: "permissionless",
          governance: "distributed",
          unknownFields: [],
          signals: [],
          reasons: [],
        },
        dependencies: {
          serial: [{ upstreamAssetId: "serial-upstream", score: 75, blocked: false }],
          basket: [{ upstreamAssetId: "basket-upstream", weight: 0.25, score: null, boundedUnknown: true }],
          cycleBlocked: false,
          reasonCodes: [],
        },
        stressStateDigest: null,
      },
    ],
  };
}

describe("published V9 report-card cache", () => {
  it("round-trips the canonical shadow cache into the owned V9 identity contract", async () => {
    const candidateValue = candidate();
    const envelope = buildSafetyScoreV9ShadowEnvelope({
      candidate: candidateValue,
      expectedActiveIds: ["alpha"],
      compilerFactSchemaDigest: digest("f"),
      producerCapabilityDigest: digest("1"),
      coverageFloors: [],
    });
    const value = await serializeSafetyScoreV9ShadowEnvelopeCacheValue(envelope);
    const db = mockD1([
      {
        match: "cache",
        rows: [{ key: SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope, value }],
      },
    ]);

    const snapshot = await loadPublishedReportCardsV9Snapshot(db);

    expect(snapshot).toEqual(ReportCardsV9ResponseSchema.parse(snapshot));
    expect(snapshot).toMatchObject({
      model: "v9",
      schemaVersion: 1,
      lifecycle: "shadow",
      safetyScoreIdentity: {
        model: "v9",
        schemaVersion: 1,
        methodologyVersion: candidateValue.policyVersion,
        policyId: candidateValue.policy.id,
        policyDigest: candidateValue.policy.semanticDigest,
        evaluationBuildDigest: candidateValue.evaluationBuildDigest,
        baseInputGenerationId: candidateValue.baseInputGenerationId,
        publicationGenerationId: candidateValue.publicationGenerationId,
      },
    });
    expect(snapshot.cards).toEqual(candidateValue.cards);
    expect(snapshot.dependencyGraph.edges).toEqual([
      {
        from: "basket-upstream",
        to: "alpha",
        kind: "basket",
        materiality: "basket-bounded-unknown",
        weight: 0.25,
        upstreamScore: null,
      },
      {
        from: "serial-upstream",
        to: "alpha",
        kind: "serial",
        materiality: "serial",
        weight: null,
        upstreamScore: 75,
      },
    ]);
  });

  it("fails closed for malformed or missing canonical V9 cache rows", async () => {
    const malformedDb = mockD1([
      {
        match: "cache",
        rows: [{ key: SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope, value: "not-json" }],
      },
    ]);

    await expect(loadPublishedReportCardsV9Snapshot(malformedDb)).rejects.toBeInstanceOf(
      ReportCardsV9SnapshotUnavailableError,
    );
    await expect(loadPublishedReportCardsV9Snapshot(mockD1())).rejects.toBeInstanceOf(
      ReportCardsV9SnapshotUnavailableError,
    );
  });

  it("rejects an identity or dependency graph projection mismatch", () => {
    const snapshot = projectSafetyScoreV9CandidateToPublicSnapshot(candidate());

    expect(() =>
      ReportCardsV9ResponseSchema.parse({
        ...snapshot,
        safetyScoreIdentity: { ...snapshot.safetyScoreIdentity, policyDigest: digest("0") },
      }),
    ).toThrow(/identity/i);
    expect(() =>
      ReportCardsV9ResponseSchema.parse({
        ...snapshot,
        dependencyGraph: { edges: [] },
      }),
    ).toThrow(/dependency graph/i);
  });
});
