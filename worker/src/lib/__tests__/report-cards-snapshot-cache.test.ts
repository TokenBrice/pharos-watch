import { beforeEach, describe, expect, it, vi } from "vitest";
import { METHODOLOGY_VERSION } from "@shared/lib/report-cards";

const mockGetCache = vi.fn();
const mockSetCache = vi.fn();

vi.mock("../db-cache", () => ({
  getCache: mockGetCache,
  setCache: mockSetCache,
}));

const { loadPublishedReportCardsSnapshot } = await import("../report-cards-snapshot-cache");

describe("report-cards snapshot cache", () => {
  beforeEach(() => {
    mockGetCache.mockReset();
    mockSetCache.mockReset();
  });

  it("rejects pre-live-dependency-generation envelopes", async () => {
    mockGetCache.mockResolvedValue({
      value: JSON.stringify({
        generation: 2,
        methodologyVersion: METHODOLOGY_VERSION,
        payload: {},
      }),
      updatedAt: 1_700_000_000,
    });

    await expect(loadPublishedReportCardsSnapshot({} as D1Database)).resolves.toEqual({
      kind: "error",
      reason: "generation-mismatch",
      updatedAt: 1_700_000_000,
    });
  });
});
