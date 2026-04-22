import { beforeEach, describe, expect, it, vi } from "vitest";

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
    mockBuildReportCardsSnapshot.mockResolvedValue({
      cards: [
        {
          id: "usdc-circle",
          name: "USD Coin",
          symbol: "USDC",
          overallGrade: "A",
          overallScore: 91,
          baseScore: 91,
          dimensions: {},
          ratedDimensions: 5,
          rawInputs: {},
          isDefunct: false,
        },
      ],
      methodology: { version: "7.09" },
      updatedAt: 1_700_000_000,
      liquidityStale: false,
      redemptionStale: false,
    });
    mockWriteReportCardCache.mockResolvedValue({ writtenCount: 1 });
    mockSetCache.mockResolvedValue(undefined);

    const result = await publishReportCardCache({} as D1Database);

    expect(result.itemCount).toBe(1);
    expect(mockSetCache).toHaveBeenCalledTimes(1);
    expect(mockSetCache.mock.calls[0]?.[1]).toBe("alert:safety-source-cache");
    expect(mockSetCache.mock.calls[0]?.[2]).toContain("\"generation\"");
    expect(mockSetCache.mock.calls[0]?.[2]).toContain("\"methodologyVersion\":\"7.09\"");
    expect(mockSetCache.mock.calls[0]?.[2]).toContain("\"usdc-circle\"");
  });
});
