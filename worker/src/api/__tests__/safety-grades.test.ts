import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicApiAccess } from "@shared/lib/api-endpoints";
import { SafetyGradesResponseSchema } from "@shared/types/report-cards-v9";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { mockD1 } from "@shared/test-utils/mock-d1";

const mockLoadActiveSafetyScoreSource = vi.fn();

vi.mock("../../lib/safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mockLoadActiveSafetyScoreSource,
}));

const { handleSafetyGrades } = await import("../safety-grades");
const { getRouteMatch } = await import("../../routes/registry");

describe("handleSafetyGrades", () => {
  beforeEach(() => mockLoadActiveSafetyScoreSource.mockReset());

  it("serves a grade-only projection of the current V9 publication without a key", async () => {
    const snapshot = makeReportCardsV9Response();
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot });

    const response = await handleSafetyGrades(mockD1([], { requireMatch: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Safety-Score-Status")).toBe("current");
    const body = SafetyGradesResponseSchema.parse(await response.json());
    expect(body.methodologyVersion).toBe(snapshot.methodology.version);
    expect(body.grades).toEqual(
      snapshot.cards.map((card) => ({ id: card.id, score: card.score, grade: card.grade })),
    );
    expect(getRouteMatch("/api/safety-grades")?.endpoint?.key).toBe("safety-grades");
    expect(getPublicApiAccess("/api/safety-grades")).toBe("exempt");
  });

  it("serves held publications uncached", async () => {
    const current = makeReportCardsV9Response();
    const snapshot = makeReportCardsV9Response({
      publicationHealth: {
        ...current.publicationHealth,
        status: "held",
        attemptedAtSec: current.updatedAt + 1_800,
        heldSinceSec: current.updatedAt + 1_800,
        reasons: [{ code: "dex-stale" }],
      },
    });
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot });

    const response = await handleSafetyGrades(mockD1([], { requireMatch: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Safety-Score-Status")).toBe("held");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ publicationStatus: "held" });
  });

  it("fails closed when the publication is unavailable", async () => {
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      snapshot: null,
      detail: "Canonical Safety Score V9 publication is unavailable",
    });

    const response = await handleSafetyGrades(mockD1([], { requireMatch: true }));

    expect(response.status).toBe(503);
  });
});
