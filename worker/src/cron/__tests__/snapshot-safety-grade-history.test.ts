import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";

const mockLoadActiveSafetyScoreSource = vi.fn();

vi.mock("../../lib/safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mockLoadActiveSafetyScoreSource,
}));

const { snapshotSafetyGradeHistory } = await import(
  "../snapshot-safety-grade-history"
);

describe("snapshotSafetyGradeHistory", () => {
  beforeEach(() => mockLoadActiveSafetyScoreSource.mockReset());

  it("skips history writes while the canonical V9 publication is held", async () => {
    const current = makeReportCardsV9Response();
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      expectedModel: "v9",
      snapshot: makeReportCardsV9Response({
        publicationHealth: {
          ...current.publicationHealth,
          status: "held",
          attemptedAtSec: current.updatedAt + 1_800,
          heldSinceSec: current.updatedAt + 1_800,
          reasons: [{ code: "dex-stale" }],
        },
      }),
    });

    const result = await snapshotSafetyGradeHistory({} as D1Database);

    expect(result).toMatchObject({ status: "degraded", itemCount: 0 });
    expect(result.metadata).toContain("v9-publication-held");
  });

  it("fails closed when V9 is unavailable", async () => {
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-snapshot-unavailable",
      snapshot: null,
      detail: "missing",
    });

    const result = await snapshotSafetyGradeHistory({} as D1Database);

    expect(result).toMatchObject({ status: "error", itemCount: 0 });
  });
});
