import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const mockLoadPublishedReportCardsV9Snapshot = vi.fn();
const mockBuildReportCardsSnapshot = vi.fn();

class MockV9UnavailableError extends Error {}

vi.mock("../../lib/report-cards-v9-cache", () => ({
  loadPublishedReportCardsV9Snapshot: mockLoadPublishedReportCardsV9Snapshot,
  ReportCardsV9SnapshotUnavailableError: MockV9UnavailableError,
}));

vi.mock("../../lib/report-cards-snapshot", () => ({
  buildReportCardsSnapshot: mockBuildReportCardsSnapshot,
}));

const { handleReportCardsV9 } = await import("../report-cards-v9");
const { getRouteMatch } = await import("../../routes/registry");

const digest = (character: string) => character.repeat(64);

function snapshot(): ReportCardsV9Response {
  return {
    model: "v9",
    schemaVersion: 1,
    lifecycle: "shadow",
    safetyScoreIdentity: {
      model: "v9",
      schemaVersion: 1,
      methodologyVersion: "candidate-v9-handler-test",
      policyId: "safety-score-v9-handler-test",
      policyDigest: digest("a"),
      evaluationBuildDigest: digest("b"),
      baseInputGenerationId: `report-cards-input:v1:${digest("c")}`,
      publicationGenerationId: "report-cards:v9:candidate:handler-test",
    },
    methodology: {
      version: "candidate-v9-handler-test",
      policy: { id: "safety-score-v9-handler-test", semanticDigest: digest("a") },
    },
    asOfSec: 1_700_000_000,
    updatedAt: 1_700_000_030,
    completeness: { expectedCount: 0, ratedCount: 0, notRatedCount: 0, notRatedIds: [] },
    source: {
      candidateId: "candidate-v9-handler-test",
      factSetDigest: digest("d"),
      resultDigest: digest("e"),
      sourceGenerations: { registry: "registry:handler-test" },
    },
    cards: [],
    dependencyGraph: { edges: [] },
  };
}

describe("handleReportCardsV9", () => {
  beforeEach(() => {
    mockLoadPublishedReportCardsV9Snapshot.mockReset();
    mockBuildReportCardsSnapshot.mockReset();
  });

  const activatedDb = () =>
    mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["safety-score-v9:public-activation"],
        rows: [{ value: "activated", updated_at: 1700000000 }],
        first: { value: "activated", updated_at: 1700000000 },
      },
    ]);

  it("stays dark (404) until the owner-gated activation marker exists", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockResolvedValue(snapshot());

    const response = await handleReportCardsV9(mockD1());

    expect(response.status).toBe(404);
    expect(mockLoadPublishedReportCardsV9Snapshot).not.toHaveBeenCalled();
  });

  it("is registered at the versioned endpoint and returns the strict V9 shadow contract", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockResolvedValue(snapshot());

    const response = await handleReportCardsV9(activatedDb());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      model: "v9",
      schemaVersion: 1,
      lifecycle: "shadow",
      safetyScoreIdentity: snapshot().safetyScoreIdentity,
    });
    expect(getRouteMatch("/api/report-cards/v9")?.endpoint?.key).toBe("report-cards-v9");
  });

  it("returns explicit unavailability without reading or recomputing V8", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockRejectedValue(
      new MockV9UnavailableError("Canonical Safety Score V9 shadow cache is unavailable"),
    );

    const response = await handleReportCardsV9(activatedDb());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Canonical Safety Score V9 shadow cache is unavailable" });
    expect(mockBuildReportCardsSnapshot).not.toHaveBeenCalled();
  });
});
