import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";

const mockLoadActiveSafetyScoreSource = vi.fn();

vi.mock("../safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mockLoadActiveSafetyScoreSource,
}));

const { computeSafetyScoresSnapshot } = await import("../safety-scores");

describe("canonical published safety scores", () => {
  beforeEach(() => mockLoadActiveSafetyScoreSource.mockReset());

  it("projects the current V9 publication into the downstream score map", async () => {
    const snapshot = makeReportCardsV9Response({
      cards: [
        makeWorkerV9Card({ id: "rated", score: 80, grade: "A-" }),
        makeWorkerV9Card({ id: "zero", score: 0, grade: "F" }),
        makeWorkerV9Card({ id: "unrated", score: null, grade: "NR" }),
      ],
    });
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      snapshot,
    });

    const result = await computeSafetyScoresSnapshot({} as D1Database);

    expect(result).toMatchObject({
      kind: "ok",
      source: "safety-score-v9-publication",
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
      coveredCount: 2,
      trackedCount: 3,
      coverageRatio: 2 / 3,
    });
    expect([...result.scores]).toEqual([
      ["rated", { score: 80, grade: "A-" }],
      ["zero", { score: 0, grade: "F" }],
    ]);
  });

  it("keeps the accepted score map while publication is held", async () => {
    const current = makeReportCardsV9Response({
      cards: [
        makeWorkerV9Card({ id: "rated", score: 80, grade: "A-" }),
        makeWorkerV9Card({ id: "unrated", score: null, grade: "NR" }),
      ],
    });
    const heldSnapshot = makeReportCardsV9Response({
      cards: [
        makeWorkerV9Card({ id: "rated", score: 80, grade: "A-" }),
        makeWorkerV9Card({ id: "unrated", score: null, grade: "NR" }),
      ],
      publicationHealth: {
        ...current.publicationHealth,
        status: "held",
        attemptedAtSec: current.updatedAt + 1_800,
        heldSinceSec: current.updatedAt + 1_800,
        reasons: [{ code: "dex-stale" }],
      },
    });
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "held",
      reason: "v9-publication-held",
      detail:
        "Canonical Safety Score V9 ratings are held at the last verified snapshot",
      snapshot: heldSnapshot,
    });

    const result = await computeSafetyScoresSnapshot({} as D1Database);

    // A hold rejects the newest attempt; the accepted ratings stay served, so a
    // consumer that can use the accepted generation still receives its map.
    expect(result.kind).toBe("degraded");
    expect(result.reason).toBe("v9-publication-held");
    expect(result.safetyScoreIdentity).toEqual(heldSnapshot.safetyScoreIdentity);
    expect(result.coveredCount).toBe(1);
    expect([...result.scores]).toEqual([["rated", { score: 80, grade: "A-" }]]);
  });

  it("returns no scores or publication identity when the source errors", async () => {
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "error", reason: "unavailable" });
    const result = await computeSafetyScoresSnapshot({} as D1Database);
    expect(result).toMatchObject({
      kind: "degraded", reason: "unavailable", scores: new Map(),
      coveredCount: 0, trackedCount: 0, coverageRatio: 1,
      safetyScoreIdentity: null, publicationGenerationId: null,
      methodologyVersion: null, publishedAt: null,
    });
  });
});
