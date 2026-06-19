import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import {
  DIMENSION_WEIGHTS,
  GRADE_THRESHOLDS,
  PEG_MULTIPLIER_EXPONENT,
} from "@shared/lib/report-cards";
import { SAFETY_SCORE_METHODOLOGY_VERSION as METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";

const mockBuildReportCardsSnapshot = vi.fn();
const mockWriteReportCardCache = vi.fn();
const mockSetCache = vi.fn();

vi.mock("../../lib/report-cards-snapshot", () => ({
  buildReportCardsSnapshot: mockBuildReportCardsSnapshot,
}));

vi.mock("../../lib/report-card-cache", () => ({
  writeReportCardCache: mockWriteReportCardCache,
}));

vi.mock("../../lib/db-cache", () => ({
  setCache: mockSetCache,
}));

const { publishReportCardCache } = await import("../publish-report-card-cache");

describe("publishReportCardCache", () => {
  beforeEach(() => {
    mockBuildReportCardsSnapshot.mockReset();
    mockWriteReportCardCache.mockReset();
    mockSetCache.mockReset();
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
    });
    mockWriteReportCardCache.mockResolvedValue({ writtenCount: 1 });
    mockSetCache.mockResolvedValue(undefined);

    const result = await publishReportCardCache({} as D1Database);

    expect(result.itemCount).toBe(1);
    // The producer is the only caller allowed to publish the peg-analytics
    // aggregate cache; read paths build the snapshot without the side effect.
    expect(mockBuildReportCardsSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      { publishPegAnalytics: true },
    );
    expect(mockWriteReportCardCache).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ id: "usdc-circle" })]),
      1_700_000_000,
      {
        liquidityStale: false,
        redemptionStale: false,
        inputFreshness: {
          dexLiquidity: { updatedAt: 1_700_000_000, ageSeconds: 0, stale: false },
          redemptionBackstops: { updatedAt: 1_700_000_000, ageSeconds: 0, stale: false },
        },
      },
    );
    expect(mockSetCache).toHaveBeenCalledTimes(2);
    expect(mockSetCache.mock.calls[0]?.[1]).toBe("report-cards:snapshot");
    expect(mockSetCache.mock.calls[0]?.[2]).toContain("\"cards\"");
    expect(mockSetCache.mock.calls[1]?.[1]).toBe("alert:safety-source-cache");
    expect(mockSetCache.mock.calls[1]?.[2]).toContain("\"generation\"");
    expect(mockSetCache.mock.calls[1]?.[2]).toContain(`"methodologyVersion":"${METHODOLOGY_VERSION}"`);
    expect(mockSetCache.mock.calls[1]?.[2]).toContain("\"usdc-circle\"");
  });
});
