import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import { DIMENSION_WEIGHTS, GRADE_THRESHOLDS, PEG_MULTIPLIER_EXPONENT } from "@shared/lib/report-cards";
import { SAFETY_SCORE_METHODOLOGY_VERSION as METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";

const mockBuildReportCardsSnapshot = vi.fn();
const mockBuildFixedInputCacheEntry = vi.fn();
const mockBuildV9PegProvenanceSeed = vi.fn();
const mockCapturePegProvenance = vi.fn();
const mockSetCacheMany = vi.fn();

vi.mock("../../lib/report-cards-snapshot", () => ({
  buildReportCardsSnapshot: mockBuildReportCardsSnapshot,
}));

vi.mock("../../lib/report-cards-fixed-input", () => ({
  buildReportCardsFixedInputCacheEntry: mockBuildFixedInputCacheEntry,
}));

vi.mock("../../lib/safety-score-v9-peg-provenance", () => ({
  captureSafetyScoreV9PegProvenanceById:
    mockCapturePegProvenance,
  buildSafetyScoreV9PegProvenanceSeedCacheEntry:
    mockBuildV9PegProvenanceSeed,
}));

vi.mock("../../lib/db-cache", () => ({
  setCacheMany: mockSetCacheMany,
}));

vi.mock("@shared/lib/stablecoins/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/lib/stablecoins/registry")>()),
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
      activeAssetIds: ["usdc-circle"],
      clockSec: 1_700_000_000,
    },
    v9PegProvenanceSource: {
      clockSec: 1_700_000_000,
      eventsByCoin: new Map(),
    },
  };
}

describe("publishReportCardCache", () => {
  beforeEach(() => {
    mockBuildReportCardsSnapshot.mockReset();
    mockBuildFixedInputCacheEntry.mockReset();
    mockBuildV9PegProvenanceSeed.mockReset();
    mockCapturePegProvenance.mockReset();
    mockSetCacheMany.mockReset();
    mockSetCacheMany.mockResolvedValue(undefined);
    mockBuildFixedInputCacheEntry.mockImplementation(async (_fixedInput, safetyScoreIdentity) => ({
      key: "report-cards:fixed-input:exact",
      value: JSON.stringify({ fixed: "input-envelope", safetyScoreIdentity }),
      storedBytes: 256,
      uncompressedBytes: 512,
    }));
    mockCapturePegProvenance.mockReturnValue({
      "usdc-circle": { marker: "compact-peg-provenance" },
    });
    mockBuildV9PegProvenanceSeed.mockImplementation(
      ({ safetyScoreIdentity }) => ({
        key: "report-cards:v9-peg-provenance-seed:exact",
        value: JSON.stringify({
          fixed: "v9-peg-provenance-seed",
          safetyScoreIdentity,
        }),
        storedBytes: 320,
      }),
    );
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
    expect(mockSetCacheMany).toHaveBeenCalledTimes(1);
    const entries = mockSetCacheMany.mock.calls[0]?.[1] as Array<{ key: string; value: string }>;
    expect(entries.map((entry) => entry.key)).toEqual([
      "report-cards:snapshot",
      "report_card_cache",
      "alert:safety-source-cache",
      "report-cards:fixed-input:exact",
      "report-cards:v9-peg-provenance-seed:exact",
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
    expect(parsed[4]).toMatchObject({
      fixed: "v9-peg-provenance-seed",
    });
    expect(snapshot.payload).not.toHaveProperty("fixedInput");
    expect(snapshot.payload).not.toHaveProperty("v9PegProvenanceSource");
    expect(entries.every((entry) => !entry.value.includes("eventsByCoin"))).toBe(true);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      v9ExactSeed: {
        status: "published",
        pegProvenanceCount: 1,
        storedBytes: 320,
      },
    });
    expect(JSON.parse(result.metadata!)).not.toHaveProperty("v9Shadow");
  });

  it("rejects the cron when the canonical V8 publication batch is rejected", async () => {
    mockBuildReportCardsSnapshot.mockResolvedValue(validSnapshot());
    mockSetCacheMany.mockRejectedValueOnce(new Error("D1 publication batch rejected"));

    await expect(publishReportCardCache({} as D1Database)).rejects.toThrow("D1 publication batch rejected");

    expect(mockSetCacheMany).toHaveBeenCalledTimes(1);
  });

  it("publishes V8 and omits a stale V9 seed when compact capture fails", async () => {
    mockBuildReportCardsSnapshot.mockResolvedValue(validSnapshot());
    mockCapturePegProvenance.mockImplementation(() => {
      throw new Error("peg provenance mismatch");
    });

    const result = await publishReportCardCache({} as D1Database);

    const entries = mockSetCacheMany.mock.calls[0]?.[1] as Array<{
      key: string;
    }>;
    expect(entries.map((entry) => entry.key)).toEqual([
      "report-cards:snapshot",
      "report_card_cache",
      "alert:safety-source-cache",
      "report-cards:fixed-input:exact",
    ]);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      v9ExactSeed: {
        status: "unavailable",
        code: "Error",
      },
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
