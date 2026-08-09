import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";

const mockLoadActiveSafetyScoreSource = vi.fn();

vi.mock("../safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mockLoadActiveSafetyScoreSource,
}));

const { computeSafetyScoresSnapshot } = await import("../safety-scores");

describe("canonical published safety scores", () => {
  beforeEach(() => mockLoadActiveSafetyScoreSource.mockReset());

  it("projects the current V9 publication into the downstream score map", async () => {
    const snapshot = makeReportCardsV9Response();
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      snapshot,
    });

    const result = await computeSafetyScoresSnapshot({} as D1Database);

    expect(result).toMatchObject({
      kind: "ok",
      source: "safety-score-v9-publication",
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
  });

  it("fails closed while publication is held", async () => {
    const current = makeReportCardsV9Response();
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "held",
      reason: "v9-publication-held",
      detail:
        "Canonical Safety Score V9 ratings are held at the last verified snapshot",
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

    const result = await computeSafetyScoresSnapshot({} as D1Database);

    expect(result.kind).toBe("degraded");
    expect(result.reason).toBe("v9-publication-held");
    expect(result.scores.size).toBe(0);
  });
});
