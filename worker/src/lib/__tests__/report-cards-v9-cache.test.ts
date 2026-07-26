import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import {
  ReportCardsV9CompatibleResponseSchema,
  ReportCardsV9CurrentResponseSchema,
  ReportCardsV9LegacyResponseSchema,
  ReportCardsV9PreviousResponseSchema,
  ReportCardsV9ResponseSchema,
} from "@shared/types/report-cards-v9";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  parseSafetyScoreV9ShadowEnvelopeCacheValue,
  serializeSafetyScoreV9ShadowEnvelopeCacheValue,
} from "../safety-score-v9-cache-codec";
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
    schemaVersion: 4,
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
        grade: "A+",
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
        scoreTrace: {
          schemaVersion: 3,
          legacyAliases: {
            qualityScore: "weighted-pillar-mean",
            pegAdjustedScore: "post-deployment-pre-cap-score",
            score: "post-cap-public-score",
          },
          aggregation: {
            method: "smooth-bounded-headroom",
            score: 90,
            weightedPillarMean: 90,
            weakestPillar: "backing",
            weakestScore: 90,
            headroom: 45,
          },
          stages: {
            weightedPillarMean: 90,
            aggregatedQualityScore: 90,
            pegMultiplier: 1,
            baseAssetScore: 90,
            deploymentAdjustedScore: 90,
            deploymentAdjustmentPoints: 0,
            preCapScore: 90,
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
          boundedUncertaintyAttribution: {
            semantics: "causal-bounded-uncertainty-v1",
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
          scoreAdjustments: [],
          wrapperParentLimit: null,
        },
      },
    ],
  };
}

function publicationHealth(
  value: SafetyScoreV9Response = candidate(),
): V9PublicationHealth {
  return {
    schemaVersion: 1,
    status: "current",
    acceptedPublicationGenerationId: value.publicationGenerationId,
    acceptedAtSec: value.publishedAtSec,
    attemptedAtSec: value.publishedAtSec,
    heldSinceSec: null,
    reasons: [],
  };
}

function project(value: SafetyScoreV9Response = candidate()) {
  return projectSafetyScoreV9CandidateToPublicSnapshot(
    value,
    publicationHealth(value),
  );
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
        rows: [
          { key: SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope, value },
          {
            key: SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.publicationHealth,
            value: stableJsonStringifyV1(publicationHealth(candidateValue)),
            updated_at: candidateValue.publishedAtSec,
          },
        ],
      },
    ]);

    const snapshot = await loadPublishedReportCardsV9Snapshot(db);

    expect(snapshot).toEqual(ReportCardsV9ResponseSchema.parse(snapshot));
    expect(snapshot).toEqual(ReportCardsV9CurrentResponseSchema.parse(snapshot));
    expect(snapshot).toMatchObject({
      model: "v9",
      schemaVersion: 3,
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

  it("fails closed when publication health is missing or malformed", async () => {
    const candidateValue = candidate();
    const envelope = buildSafetyScoreV9ShadowEnvelope({
      candidate: candidateValue,
      expectedActiveIds: ["alpha"],
      compilerFactSchemaDigest: digest("f"),
      producerCapabilityDigest: digest("1"),
      coverageFloors: [],
    });
    const value = await serializeSafetyScoreV9ShadowEnvelopeCacheValue(envelope);
    const missingHealth = mockD1([
      {
        match: "cache",
        rows: [
          {
            key: SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope,
            value,
            updated_at: candidateValue.publishedAtSec,
          },
        ],
      },
    ]);
    const malformedHealth = mockD1([
      {
        match: "cache",
        rows: [
          {
            key: SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope,
            value,
            updated_at: candidateValue.publishedAtSec,
          },
          {
            key: SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.publicationHealth,
            value: "not-json",
            updated_at: candidateValue.publishedAtSec,
          },
        ],
      },
    ]);

    await expect(
      loadPublishedReportCardsV9Snapshot(missingHealth),
    ).rejects.toBeInstanceOf(ReportCardsV9SnapshotUnavailableError);
    await expect(
      loadPublishedReportCardsV9Snapshot(malformedHealth),
    ).rejects.toBeInstanceOf(ReportCardsV9SnapshotUnavailableError);
  });

  it("rejects an identity or dependency graph projection mismatch", () => {
    const snapshot = project();

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

  it("rejects a public V9 card that omits the current or retained trace", () => {
    const traceLess = structuredClone(candidate());
    traceLess.schemaVersion = 1;
    delete (traceLess.cards[0] as { scoreTrace?: unknown }).scoreTrace;

    expect(() => project(traceLess)).toThrow(/scoreTrace/);
  });

  it("cannot downgrade a report-v3 envelope by relabeling only its traces", () => {
    const downgraded = structuredClone(
      project(),
    );
    const trace = (
      downgraded.cards[0] as { scoreTrace: Record<string, unknown> }
    ).scoreTrace;
    trace.schemaVersion = 1;
    delete trace.boundedUncertaintyAttribution;
    delete trace.scoreAdjustments;

    expect(() => ReportCardsV9CurrentResponseSchema.parse(downgraded)).toThrow();
    expect(() => ReportCardsV9ResponseSchema.parse(downgraded)).toThrow();
  });

  it("retains an explicit report-v1 reader for persisted trace-v1 snapshots", () => {
    const previous = structuredClone(
      project(),
    ) as unknown as Record<string, unknown> & {
      cards: Array<{ scoreTrace: Record<string, unknown> }>;
    };
    previous.schemaVersion = 1;
    delete previous.publicationHealth;
    const trace = previous.cards[0]!.scoreTrace;
    trace.schemaVersion = 1;
    delete trace.boundedUncertaintyAttribution;

    delete trace.scoreAdjustments;

    expect(() => ReportCardsV9LegacyResponseSchema.parse(previous)).not.toThrow();
    expect(() => ReportCardsV9CompatibleResponseSchema.parse(previous)).not.toThrow();
    expect(() => ReportCardsV9CurrentResponseSchema.parse(previous)).toThrow();
    expect(() => ReportCardsV9ResponseSchema.parse(previous)).toThrow();
  });

  it("retains an explicit report-v2 reader for causal trace-v2 snapshots", () => {
    const previous = structuredClone(
      project(),
    ) as unknown as Record<string, unknown> & {
      cards: Array<{ scoreTrace: Record<string, unknown> }>;
    };
    previous.schemaVersion = 2;
    delete previous.publicationHealth;
    const trace = previous.cards[0]!.scoreTrace;
    trace.schemaVersion = 2;
    delete trace.scoreAdjustments;

    expect(() => ReportCardsV9PreviousResponseSchema.parse(previous)).not.toThrow();
    expect(() => ReportCardsV9CompatibleResponseSchema.parse(previous)).not.toThrow();
    expect(() => ReportCardsV9CurrentResponseSchema.parse(previous)).toThrow();
  });

  it("round-trips retained candidate-v3 and trace-v2 cache bytes without injecting fields", async () => {
    const causalCandidate = structuredClone(candidate()) as unknown as {
      schemaVersion: number;
      cards: Array<{ scoreTrace: Record<string, unknown> }>;
    } & SafetyScoreV9Response;
    causalCandidate.schemaVersion = 3;
    causalCandidate.cards[0]!.scoreTrace.schemaVersion = 2;
    delete causalCandidate.cards[0]!.scoreTrace.scoreAdjustments;
    const envelope = buildSafetyScoreV9ShadowEnvelope({
      candidate: causalCandidate,
      expectedActiveIds: ["alpha"],
      compilerFactSchemaDigest: digest("f"),
      producerCapabilityDigest: digest("1"),
      coverageFloors: [],
    });

    const stored = await serializeSafetyScoreV9ShadowEnvelopeCacheValue(envelope);
    const parsed = await parseSafetyScoreV9ShadowEnvelopeCacheValue(stored);

    expect(parsed).toEqual(envelope);
    const parsedCard = parsed.candidate.cards[0]!;
    expect(
      "scoreTrace" in parsedCard &&
      "scoreAdjustments" in parsedCard.scoreTrace,
    ).toBe(false);
  });

  it("rejects report-v1 restamping and stale candidate projection", () => {
    const restamped = structuredClone(
      project(),
    ) as unknown as Record<string, unknown>;
    restamped.schemaVersion = 1;
    expect(() => ReportCardsV9CompatibleResponseSchema.parse(restamped)).toThrow();

    const previousCandidate = structuredClone(candidate());
    previousCandidate.schemaVersion = 2;
    const trace = (
      previousCandidate.cards[0] as unknown as {
        scoreTrace: Record<string, unknown>;
      }
    ).scoreTrace;
    trace.schemaVersion = 1;
    delete trace.boundedUncertaintyAttribution;
    delete trace.scoreAdjustments;
    expect(() => project(previousCandidate)).toThrow();
  });
});
