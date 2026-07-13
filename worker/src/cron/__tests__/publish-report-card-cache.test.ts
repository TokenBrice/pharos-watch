import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import { DIMENSION_WEIGHTS, GRADE_THRESHOLDS, PEG_MULTIPLIER_EXPONENT } from "@shared/lib/report-cards";
import { SAFETY_SCORE_METHODOLOGY_VERSION as METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";

const mockBuildReportCardsSnapshot = vi.fn();
const mockBuildFixedInputCacheEntry = vi.fn();
const mockRunSafetyScoreV9Shadow = vi.fn();
const mockPublishSafetyScoreV8ModelFamily = vi.fn();

vi.mock("../../lib/report-cards-snapshot", () => ({
  buildReportCardsSnapshot: mockBuildReportCardsSnapshot,
}));

vi.mock("../../lib/report-cards-fixed-input", () => ({
  buildReportCardsFixedInputCacheEntry: mockBuildFixedInputCacheEntry,
}));

vi.mock("../../lib/safety-score-v9-shadow-runner", () => ({
  runSafetyScoreV9ShadowAfterV8Publication: mockRunSafetyScoreV9Shadow,
}));

vi.mock("../../lib/safety-score-model-publication-store", () => ({
  publishSafetyScoreV8ModelFamily: mockPublishSafetyScoreV8ModelFamily,
}));

vi.mock("@shared/lib/stablecoins/registry", () => ({
  ACTIVE_IDS: new Set(["usdc-circle"]),
}));

const { publishReportCardCache } = await import("../publish-report-card-cache");

describe("publishReportCardCache", () => {
  beforeEach(() => {
    mockBuildReportCardsSnapshot.mockReset();
    mockBuildFixedInputCacheEntry.mockReset();
    mockRunSafetyScoreV9Shadow.mockReset();
    mockPublishSafetyScoreV8ModelFamily.mockReset();
    mockBuildFixedInputCacheEntry.mockResolvedValue({
      key: "report-cards:fixed-input:exact",
      value: '{"fixed":"input-envelope"}',
      storedBytes: 256,
      uncompressedBytes: 512,
    });
    mockRunSafetyScoreV9Shadow.mockResolvedValue({
      status: "published",
      attemptId: "safety-score-v9-shadow:scheduled:2023-11-14",
      utcDay: "2023-11-14",
      publicationGenerationId: "v9-shadow-generation",
      candidateId: "v9-candidate",
      qualifying: false,
      qualificationBlockers: ["coverage-floor-failed"],
      pendingReviewCount: 1,
    });
    mockPublishSafetyScoreV8ModelFamily.mockResolvedValue({
      status: "published",
      activeAliasesAdvanced: true,
      family: { generationId: `report-cards:${METHODOLOGY_VERSION}:1700000000` },
      manifest: {
        selection: {
          state: "v8-active-v9-shadow",
          transitionEpoch: 0,
          activeModel: "v8",
        },
      },
    });
  });

  it("writes a generation-aware alert safety source cache from the live cards", async () => {
    const dimension = { grade: "A" as const, score: 91, detail: "test" };
    mockBuildReportCardsSnapshot.mockResolvedValue({
      cards: [
        {
          id: "usdc-circle",
          name: "USD Coin",
          symbol: "USDC",
          overallGrade: "A",
          overallScore: 91,
          baseScore: 91,
          dimensions: {
            pegStability: dimension,
            liquidity: dimension,
            resilience: dimension,
            decentralization: dimension,
            dependencyRisk: dimension,
          },
          ratedDimensions: 5,
          rawInputs: createReportCardRawInputs({ canBeBlacklisted: true }),
          isDefunct: false,
        },
      ],
      methodology: {
        version: METHODOLOGY_VERSION,
        weights: DIMENSION_WEIGHTS,
        pegMultiplierExponent: PEG_MULTIPLIER_EXPONENT,
        thresholds: GRADE_THRESHOLDS,
      },
      dependencyGraph: { edges: [] },
      updatedAt: 1_700_000_000,
      liquidityStale: false,
      redemptionStale: false,
      inputFreshness: {
        dexLiquidity: { updatedAt: 1_700_000_000, ageSeconds: 0, stale: false },
        redemptionBackstops: { updatedAt: 1_700_000_000, ageSeconds: 0, stale: false },
      },
      fixedInput: {
        sourceGeneration: `report-cards:${METHODOLOGY_VERSION}:1700000000`,
      },
    });
    const result = await publishReportCardCache({} as D1Database);

    expect(result.itemCount).toBe(1);
    // The producer is the only caller allowed to publish the peg-analytics
    // aggregate cache; read paths build the snapshot without the side effect.
    expect(mockBuildReportCardsSnapshot).toHaveBeenCalledWith(expect.anything(), {
      publishPegAnalytics: true,
      captureFixedInput: true,
    });
    expect(mockPublishSafetyScoreV8ModelFamily).toHaveBeenCalledTimes(1);
    expect(mockRunSafetyScoreV9Shadow).toHaveBeenCalledTimes(1);
    expect(mockPublishSafetyScoreV8ModelFamily.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunSafetyScoreV9Shadow.mock.invocationCallOrder[0]!,
    );
    const publicationInput = mockPublishSafetyScoreV8ModelFamily.mock.calls[0]?.[0] as {
      payloads: Record<string, { key: string; value: string }>;
    };
    const entries = Object.values(publicationInput.payloads);
    expect(entries.map((entry) => entry.key)).toEqual([
      "report-cards:snapshot",
      "report_card_cache",
      "alert:safety-source-cache",
      "report-cards:fixed-input:exact",
    ]);
    const parsed = entries.map((entry) => JSON.parse(entry.value));
    expect(parsed[0].payload.publication.generationId).toBe(`report-cards:${METHODOLOGY_VERSION}:1700000000`);
    expect(parsed[1].payload.publicationGenerationId).toBe(parsed[0].payload.publication.generationId);
    expect(parsed[2].publicationGenerationId).toBe(parsed[0].payload.publication.generationId);
    expect(parsed[0].payload.publication).toMatchObject({
      expectedCount: 1,
      scoredCount: 1,
      notRatedCount: 0,
    });
    expect(entries[2]?.value).toContain('"usdc-circle"');
    expect(parsed[3]).toEqual({ fixed: "input-envelope" });
    expect(parsed[0].payload.fixedInput).toBeUndefined();
    expect(JSON.parse(result.metadata!)).toMatchObject({
      v9Shadow: {
        status: "published",
        qualifying: false,
      },
    });
  });

  it("keeps the committed v8 publication authoritative when the V9 shadow runner fails", async () => {
    const dimension = { grade: "A" as const, score: 91, detail: "test" };
    mockBuildReportCardsSnapshot.mockResolvedValue({
      cards: [
        {
          id: "usdc-circle",
          name: "USD Coin",
          symbol: "USDC",
          overallGrade: "A",
          overallScore: 91,
          baseScore: 91,
          dimensions: {
            pegStability: dimension,
            liquidity: dimension,
            resilience: dimension,
            decentralization: dimension,
            dependencyRisk: dimension,
          },
          ratedDimensions: 5,
          rawInputs: createReportCardRawInputs({ canBeBlacklisted: true }),
          isDefunct: false,
        },
      ],
      methodology: {
        version: METHODOLOGY_VERSION,
        weights: DIMENSION_WEIGHTS,
        pegMultiplierExponent: PEG_MULTIPLIER_EXPONENT,
        thresholds: GRADE_THRESHOLDS,
      },
      dependencyGraph: { edges: [] },
      updatedAt: 1_700_000_000,
      liquidityStale: false,
      redemptionStale: false,
      fixedInput: {
        sourceGeneration: `report-cards:${METHODOLOGY_VERSION}:1700000000`,
        baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      },
    });
    mockRunSafetyScoreV9Shadow.mockRejectedValue(new Error("shadow D1 unavailable"));

    const result = await publishReportCardCache({} as D1Database);

    expect(mockPublishSafetyScoreV8ModelFamily).toHaveBeenCalledTimes(1);
    expect(result.productivity?.productive).toBe(true);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      publicationGenerationId: `report-cards:${METHODOLOGY_VERSION}:1700000000`,
      v9Shadow: { status: "failed", stage: "scheduler", code: "Error" },
    });
  });

  it("rejects a shrunken active set before publishing any projection", async () => {
    mockBuildReportCardsSnapshot.mockResolvedValue({
      cards: [],
      methodology: {
        version: METHODOLOGY_VERSION,
        weights: DIMENSION_WEIGHTS,
        pegMultiplierExponent: PEG_MULTIPLIER_EXPONENT,
        thresholds: GRADE_THRESHOLDS,
      },
      dependencyGraph: { edges: [] },
      updatedAt: 1_700_000_000,
      liquidityStale: false,
      redemptionStale: false,
      inputFreshness: {
        dexLiquidity: { updatedAt: 1_700_000_000, ageSeconds: 0, stale: false },
        redemptionBackstops: { updatedAt: 1_700_000_000, ageSeconds: 0, stale: false },
      },
      fixedInput: { sourceGeneration: `report-cards:${METHODOLOGY_VERSION}:1700000000` },
    });

    await expect(publishReportCardCache({} as D1Database)).rejects.toThrow("report-card-active-set-mismatch");
    expect(mockPublishSafetyScoreV8ModelFamily).not.toHaveBeenCalled();
  });
});
