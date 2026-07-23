import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveSafetyScoreSource } from "../safety-score-active-source";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const mockLoadActiveSafetyScoreSource = vi.fn();

vi.mock("../safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mockLoadActiveSafetyScoreSource,
}));

const { checkReportCardCacheMethodology } = await import("../canary-checks");
const { loadPublicationHealth } = await import("../publication-contract");
const { getDatasetFreshness } = await import("../status/derived-data");

const NOW = 1_775_900_000;
const digest = (character: string) => character.repeat(64);

function activeV9(): Extract<ActiveSafetyScoreSource, { kind: "v9" }> {
  const marker = {
    policyId: "safety-score-v9-policy",
    policyDigest: digest("a"),
    evaluationBuildDigest: digest("b"),
    methodologyVersion: "9.0",
  };
  return {
    kind: "v9",
    expectedModel: "v9",
    activationUpdatedAt: NOW - 90,
    marker,
    snapshot: {
      updatedAt: NOW - 60,
      methodology: {
        version: marker.methodologyVersion,
        policy: { id: marker.policyId, semanticDigest: marker.policyDigest },
      },
      safetyScoreIdentity: {
        model: "v9",
        schemaVersion: 1,
        ...marker,
        baseInputGenerationId: `report-cards-input:v1:${digest("c")}`,
        publicationGenerationId: "safety-score-v9:test-generation",
      },
      completeness: {
        expectedCount: 1,
        ratedCount: 1,
        notRatedCount: 0,
        notRatedIds: [],
      },
      cards: [{ id: "test-coin", score: 90, grade: "A" }],
    },
  } as unknown as Extract<ActiveSafetyScoreSource, { kind: "v9" }>;
}

describe("activation-aware Safety Score consumers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1_000));
    mockLoadActiveSafetyScoreSource.mockReset();
    mockLoadActiveSafetyScoreSource.mockResolvedValue(activeV9());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates the active V9 identity and freshness in the report-card canary", async () => {
    await expect(checkReportCardCacheMethodology(mockD1())).resolves.toMatchObject({
      status: "ok",
      severity: "info",
      metadata: {
        expectedModel: "v9",
        updatedAt: NOW - 60,
        scoreCount: 1,
        safetyScoreIdentity: {
          model: "v9",
          publicationGenerationId: "safety-score-v9:test-generation",
        },
      },
    });
  });

  it("fails the report-card canary closed on an unsatisfied V9 activation identity", async () => {
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-identity-mismatch",
      activationUpdatedAt: NOW - 90,
      marker: activeV9().marker,
      snapshot: activeV9().snapshot,
      detail: "identity mismatch",
    } satisfies ActiveSafetyScoreSource);

    await expect(checkReportCardCacheMethodology(mockD1())).resolves.toMatchObject({
      status: "error",
      severity: "error",
      error: "active Safety Score source v9-identity-mismatch",
      metadata: {
        expectedModel: "v9",
        reason: "v9-identity-mismatch",
      },
    });
  });

  it("publishes C23 health from the activated V9 generation instead of the V8 ledger/cache", async () => {
    const health = await loadPublicationHealth(mockD1(), NOW);

    expect(health.surfaces["report-card-cache"]).toMatchObject({
      sourceOfTruth: "cache[safety-score-v9:public-activation]+cache[report-cards:v9-shadow]",
      lastPublishedGeneration: {
        generationId: "safety-score-v9:test-generation",
        state: "published",
        publishedRows: 1,
        metadata: {
          expectedModel: "v9",
          safetyScoreIdentity: {
            model: "v9",
            publicationGenerationId: "safety-score-v9:test-generation",
          },
        },
      },
      dependencyWatermarks: {
        reportCardCache: NOW - 60,
        safetyScoreActivation: NOW - 90,
      },
    });
  });

  it("derives safety-grade freshness from the activated V9 snapshot", async () => {
    const freshness = await getDatasetFreshness(mockD1());

    expect(freshness.safetyGrades).toBe(NOW - 60);
  });
});
