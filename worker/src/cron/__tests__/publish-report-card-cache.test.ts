import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import { DIMENSION_WEIGHTS, GRADE_THRESHOLDS, PEG_MULTIPLIER_EXPONENT } from "@shared/lib/report-cards";
import { SAFETY_SCORE_METHODOLOGY_VERSION as METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";

const mockBuildReportCardsSnapshot = vi.fn();
const mockBuildFixedInputCacheEntry = vi.fn();
const mockBuildV9FixedInputCacheEntry = vi.fn();
const mockNormalizeFixedInput = vi.fn();
const mockEnrichV9FixedInput = vi.fn();
const mockLoadEvidenceJournal = vi.fn();
const mockRunSafetyScoreV9Shadow = vi.fn();
const mockSetCacheMany = vi.fn();

vi.mock("../../lib/report-cards-snapshot", () => ({
  buildReportCardsSnapshot: mockBuildReportCardsSnapshot,
}));

vi.mock("../../lib/report-cards-fixed-input", () => ({
  buildReportCardsFixedInputCacheEntry: mockBuildFixedInputCacheEntry,
  buildSafetyScoreV9FixedInputCacheEntry: mockBuildV9FixedInputCacheEntry,
  normalizeFixedInput: mockNormalizeFixedInput,
}));

vi.mock("../../lib/safety-score-v9-supply-attribution", () => ({
  enrichSafetyScoreV9FixedInputSupply: mockEnrichV9FixedInput,
}));

vi.mock("../../lib/report-card-evidence-journal-store", () => ({
  loadReportCardEvidenceJournalByIdV1: mockLoadEvidenceJournal,
}));

vi.mock("../../lib/safety-score-v9-shadow-runner", () => ({
  SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC: 30 * 60,
  runSafetyScoreV9ShadowAfterV8Publication: mockRunSafetyScoreV9Shadow,
}));

vi.mock("../../lib/db-cache", () => ({
  setCacheMany: mockSetCacheMany,
}));

vi.mock("@shared/lib/stablecoins/registry", () => ({
  ACTIVE_IDS: new Set(["usdc-circle"]),
}));

const { publishReportCardCache } = await import("../publish-report-card-cache");
const { parsePublishedReportCardsSnapshotCacheValue } = await import("../../lib/report-cards-snapshot-cache");

function validSnapshot() {
  const dimension = { grade: "A" as const, score: 91, detail: "test" };
  return {
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
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
    },
  };
}

describe("publishReportCardCache", () => {
  beforeEach(() => {
    mockBuildReportCardsSnapshot.mockReset();
    mockBuildFixedInputCacheEntry.mockReset();
    mockBuildV9FixedInputCacheEntry.mockReset();
    mockNormalizeFixedInput.mockReset();
    mockEnrichV9FixedInput.mockReset();
    mockLoadEvidenceJournal.mockReset();
    mockRunSafetyScoreV9Shadow.mockReset();
    mockSetCacheMany.mockReset();
    mockSetCacheMany.mockResolvedValue(undefined);
    mockBuildFixedInputCacheEntry.mockImplementation(async (_fixedInput, safetyScoreIdentity) => ({
      key: "report-cards:fixed-input:exact",
      value: JSON.stringify({ fixed: "input-envelope", safetyScoreIdentity }),
      storedBytes: 256,
      uncompressedBytes: 512,
    }));
    mockBuildV9FixedInputCacheEntry.mockImplementation(async (_fixedInput, safetyScoreIdentity) => ({
      key: "report-cards:v9-fixed-input:exact",
      value: JSON.stringify({ fixed: "v9-input-envelope", safetyScoreIdentity }),
      storedBytes: 320,
      uncompressedBytes: 640,
    }));
    mockEnrichV9FixedInput.mockImplementation(async (fixedInput) => ({
      ...fixedInput,
      safetyScoreV9SupplyAttributionById: {},
    }));
    mockLoadEvidenceJournal.mockResolvedValue({});
    mockNormalizeFixedInput.mockImplementation((value) => value);
    mockRunSafetyScoreV9Shadow.mockImplementation(async (shadowInput) => {
      await shadowInput.prepareFixedInput?.(shadowInput.fixedInput, new AbortController().signal);
      return {
        status: "published",
        attemptId: "safety-score-v9-shadow:scheduled:2023-11-14",
        utcDay: "2023-11-14",
        publicationGenerationId: "v9-shadow-generation",
        candidateId: "v9-candidate",
        pendingReviewCount: 1,
      };
    });
  });

  it("writes a generation-aware alert safety source cache from the live cards", async () => {
    mockBuildReportCardsSnapshot.mockResolvedValue(validSnapshot());
    const result = await publishReportCardCache({} as D1Database);

    expect(result.itemCount).toBe(1);
    // The producer is the only caller allowed to publish the peg-analytics
    // aggregate cache; read paths build the snapshot without the side effect.
    expect(mockBuildReportCardsSnapshot).toHaveBeenCalledWith(expect.anything(), {
      publishPegAnalytics: true,
      captureFixedInput: true,
    });
    expect(mockSetCacheMany).toHaveBeenCalledTimes(2);
    expect(mockRunSafetyScoreV9Shadow).toHaveBeenCalledTimes(1);
    expect(mockSetCacheMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnrichV9FixedInput.mock.invocationCallOrder[0]!,
    );
    expect(mockLoadEvidenceJournal).toHaveBeenCalledTimes(1);
    expect(mockBuildV9FixedInputCacheEntry).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceJournalById: {} }),
      expect.anything(),
    );
    const entries = mockSetCacheMany.mock.calls[0]?.[1] as Array<{ key: string; value: string }>;
    expect(entries.map((entry) => entry.key)).toEqual([
      "report-cards:snapshot",
      "report_card_cache",
      "alert:safety-source-cache",
      "report-cards:fixed-input:exact",
    ]);
    const parsed = entries.map((entry) => JSON.parse(entry.value));
    const snapshot = await parsePublishedReportCardsSnapshotCacheValue({
      value: entries[0]!.value,
      updatedAt: 1_700_000_000,
    });
    expect(snapshot.kind).toBe("ok");
    if (snapshot.kind !== "ok") throw new Error(`Snapshot parse failed: ${snapshot.reason}`);
    expect(parsed[0]).toMatchObject({
      encoding: "gzip-base64",
      model: "v8",
      publicationGenerationId: `report-cards:${METHODOLOGY_VERSION}:1700000000`,
    });
    expect(snapshot.payload.publication?.generationId).toBe(`report-cards:${METHODOLOGY_VERSION}:1700000000`);
    expect(parsed[1].payload.publicationGenerationId).toBe(snapshot.payload.publication?.generationId);
    expect(parsed[2].publicationGenerationId).toBe(snapshot.payload.publication?.generationId);
    expect(snapshot.payload.safetyScoreIdentity).toEqual(parsed[1].payload.safetyScoreIdentity);
    expect(parsed[1].payload.safetyScoreIdentity).toEqual(parsed[2].safetyScoreIdentity);
    expect(parsed[3].safetyScoreIdentity).toEqual(snapshot.payload.safetyScoreIdentity);
    expect(snapshot.payload.safetyScoreIdentity).toMatchObject({
      model: "v8",
      schemaVersion: 1,
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
    });
    expect(snapshot.payload.publication).toMatchObject({
      expectedCount: 1,
      scoredCount: 1,
      notRatedCount: 0,
    });
    expect(entries[2]?.value).toContain('"usdc-circle"');
    expect(parsed[3]).toMatchObject({ fixed: "input-envelope" });
    const v9Entries = mockSetCacheMany.mock.calls[1]?.[1] as Array<{ key: string; value: string }>;
    expect(v9Entries.map((entry) => entry.key)).toEqual(["report-cards:v9-fixed-input:exact"]);
    expect(JSON.parse(v9Entries[0]!.value)).toMatchObject({ fixed: "v9-input-envelope" });
    expect(snapshot.payload).not.toHaveProperty("fixedInput");
    expect(JSON.parse(result.metadata!)).toMatchObject({
      v9FixedInputCacheBytes: 320,
      v9FixedInputUncompressedBytes: 640,
      v9Shadow: {
        status: "published",
        pendingReviewCount: 1,
      },
    });
  });

  it("does not start V9 shadow when the canonical V8 publication batch is rejected", async () => {
    mockBuildReportCardsSnapshot.mockResolvedValue(validSnapshot());
    mockSetCacheMany.mockRejectedValueOnce(new Error("D1 publication batch rejected"));

    await expect(publishReportCardCache({} as D1Database)).rejects.toThrow("D1 publication batch rejected");

    expect(mockSetCacheMany).toHaveBeenCalledTimes(1);
    expect(mockRunSafetyScoreV9Shadow).not.toHaveBeenCalled();
  });

  it("keeps the committed v8 publication authoritative when the V9 shadow runner fails", async () => {
    mockBuildReportCardsSnapshot.mockResolvedValue(validSnapshot());
    mockRunSafetyScoreV9Shadow.mockRejectedValue(new Error("shadow D1 unavailable"));

    const result = await publishReportCardCache({} as D1Database);

    expect(mockSetCacheMany).toHaveBeenCalledTimes(1);
    expect(result.productivity?.productive).toBe(true);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      publicationGenerationId: `report-cards:${METHODOLOGY_VERSION}:1700000000`,
      v9Shadow: { status: "failed", stage: "scheduler", code: "Error" },
    });
  });

  it("keeps the committed V8 publication authoritative when V9 input enrichment fails", async () => {
    mockBuildReportCardsSnapshot.mockResolvedValue(validSnapshot());
    mockEnrichV9FixedInput.mockRejectedValue(new Error("shadow RPC unavailable"));

    const result = await publishReportCardCache({} as D1Database);

    expect(mockSetCacheMany).toHaveBeenCalledTimes(1);
    expect(result.productivity?.productive).toBe(true);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      publicationGenerationId: `report-cards:${METHODOLOGY_VERSION}:1700000000`,
      v9FixedInputCacheBytes: null,
      v9Shadow: { status: "failed", stage: "scheduler", code: "Error" },
    });
  });

  it("keeps the committed V8 publication authoritative when the diagnostic journal read fails", async () => {
    mockBuildReportCardsSnapshot.mockResolvedValue(validSnapshot());
    mockLoadEvidenceJournal.mockRejectedValue(new Error("journal D1 unavailable"));

    const result = await publishReportCardCache({} as D1Database);

    expect(mockSetCacheMany).toHaveBeenCalledTimes(1);
    expect(result.productivity?.productive).toBe(true);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      publicationGenerationId: `report-cards:${METHODOLOGY_VERSION}:1700000000`,
      v9FixedInputCacheBytes: null,
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
    expect(mockSetCacheMany).not.toHaveBeenCalled();
  });
});
