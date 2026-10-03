import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicApiAccess } from "@shared/lib/api-endpoints";
import { SafetyGradesResponseSchema } from "@shared/types/report-cards-v9";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { mockD1 } from "@shared/test-utils/mock-d1";

const mockLoadActiveSafetyScoreSource = vi.fn();

vi.mock("../../lib/safety-score-index", () => ({
  loadActiveSafetyScoreIndex: mockLoadActiveSafetyScoreSource,
}));

const { handleSafetyGrades } = await import("../safety-grades");
const { getRouteMatch } = await import("../../routes/registry");

describe("handleSafetyGrades", () => {
  beforeEach(() => mockLoadActiveSafetyScoreSource.mockReset());

  it("keeps pipeline-gap null grades separate from NR and preserves partial rated evidence", async () => {
    const base = makeReportCardsV9Response();
    const partial = { reasonCode: "partial-evidence-pipeline-gap" as const, excludedPillars: ["exit" as const], causes: ["A" as const] };
    const grades = [
      { id: "partial", score: 90, grade: "A" as const, ratingStatus: "rated" as const, partialEvidence: partial },
      { id: "gap", score: null, grade: null, ratingStatus: "pipeline-gap" as const,
        partialEvidence: { ...partial, excludedPillars: ["backing" as const, "exit" as const] } },
      { id: "nr", score: null, grade: "NR" as const, ratingStatus: "not-rated" as const, partialEvidence: null },
    ];
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot: { ...base, cards: grades } });
    const response = await handleSafetyGrades(mockD1([], { requireMatch: true }));
    const body = SafetyGradesResponseSchema.parse(await response.json());
    expect(body.schemaVersion).toBe(1);
    expect(body.grades).toEqual(grades);
  });

  it("serves a grade-only projection of the current V9 publication without a key", async () => {
    const snapshot = makeReportCardsV9Response();
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot: {
      ...snapshot, cards: snapshot.cards.map(({ id, score, grade, ratingStatus, partialEvidence }) => ({ id, score, grade, ratingStatus, partialEvidence })),
    } });

    const response = await handleSafetyGrades(mockD1([], { requireMatch: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Safety-Score-Status")).toBe("current");
    const body = SafetyGradesResponseSchema.parse(await response.json());
    expect(body.methodologyVersion).toBe(snapshot.methodology.version);
    expect(body.grades).toEqual(
      snapshot.cards.map(({ id, score, grade, ratingStatus, partialEvidence }) => ({ id, score, grade, ratingStatus, partialEvidence })),
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
