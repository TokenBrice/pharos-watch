import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const mockLoadActiveSafetyScoreSource = vi.fn();

vi.mock("../../lib/safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mockLoadActiveSafetyScoreSource,
}));

const { handleReportCardsV9 } = await import("../report-cards-v9");
const { getRouteMatch } = await import("../../routes/registry");

describe("handleReportCardsV9", () => {
  beforeEach(() => mockLoadActiveSafetyScoreSource.mockReset());

  it("serves the canonical current V9 publication", async () => {
    const snapshot = makeReportCardsV9Response();
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      expectedModel: "v9",
      snapshot,
    });

    const response = await handleReportCardsV9(mockD1());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: "v9",
      schemaVersion: 4,
      lifecycle: "active",
      safetyScoreIdentity: snapshot.safetyScoreIdentity,
    });
    expect(getRouteMatch("/api/report-cards/v9")?.endpoint?.key).toBe(
      "report-cards-v9",
    );
    expect(getRouteMatch("/api/report-cards/v9-preview")).toBeNull();
  });

  it("serves held ratings without caching assessment details", async () => {
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
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      expectedModel: "v9",
      snapshot,
    });

    const response = await handleReportCardsV9(mockD1());

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Safety-Score-Status")).toBe("held");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("fails closed when the canonical V9 publication is unavailable", async () => {
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-snapshot-unavailable",
      snapshot: null,
      detail: "Canonical Safety Score V9 publication is unavailable",
    });

    const response = await handleReportCardsV9(mockD1());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Canonical Safety Score V9 publication is unavailable",
    });
  });
});
