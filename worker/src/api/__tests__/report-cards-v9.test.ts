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

const { handleReportCardsV9, handleReportCardsV9Preview } = await import("../report-cards-v9");
const { getRouteMatch } = await import("../../routes/registry");

const digest = (character: string) => character.repeat(64);

function snapshot(): ReportCardsV9Response {
  return {
    model: "v9",
    schemaVersion: 2,
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

  const approvedMarker = () => {
    const identity = snapshot().safetyScoreIdentity;
    return JSON.stringify({
      policyId: identity.policyId,
      policyDigest: identity.policyDigest,
      evaluationBuildDigest: identity.evaluationBuildDigest,
      methodologyVersion: identity.methodologyVersion,
    });
  };

  const markerDb = (value: string) =>
    mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["safety-score-v9:public-activation"],
        rows: [{ value, updated_at: 1700000000 }],
        first: { value, updated_at: 1700000000 },
      },
    ]);

  it("stays dark (404) until the owner-gated activation marker exists", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockResolvedValue(snapshot());

    const response = await handleReportCardsV9(mockD1());

    expect(response.status).toBe(404);
    expect(mockLoadPublishedReportCardsV9Snapshot).not.toHaveBeenCalled();
  });

  it("stays dark (404) when the marker is not an identity binding, without loading the snapshot", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockResolvedValue(snapshot());

    for (const invalid of ["activated", "{}", JSON.stringify({ policyId: "safety-score-v9-handler-test" })]) {
      const response = await handleReportCardsV9(markerDb(invalid));
      expect(response.status).toBe(404);
    }
    expect(mockLoadPublishedReportCardsV9Snapshot).not.toHaveBeenCalled();
  });

  it("stays dark (404) when the marker identity does not match the canonical snapshot", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockResolvedValue(snapshot());
    const mismatched = { ...JSON.parse(approvedMarker()), policyDigest: digest("f") };

    const response = await handleReportCardsV9(markerDb(JSON.stringify(mismatched)));

    expect(response.status).toBe(404);
    expect(mockLoadPublishedReportCardsV9Snapshot).toHaveBeenCalledTimes(1);
  });

  it("is registered at the versioned endpoint and serves the matched identity with lifecycle active", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockResolvedValue(snapshot());

    const response = await handleReportCardsV9(markerDb(approvedMarker()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      model: "v9",
      schemaVersion: 2,
      lifecycle: "active",
      safetyScoreIdentity: snapshot().safetyScoreIdentity,
    });
    const endpoint = getRouteMatch("/api/report-cards/v9")?.endpoint;
    expect(endpoint?.key).toBe("report-cards-v9");
    expect(endpoint?.cacheBypass).toBe(true);
  });

  it("returns explicit unavailability without reading or recomputing V8", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockRejectedValue(
      new MockV9UnavailableError("Canonical Safety Score V9 shadow cache is unavailable"),
    );

    const response = await handleReportCardsV9(markerDb(approvedMarker()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Canonical Safety Score V9 shadow cache is unavailable" });
    expect(mockBuildReportCardsSnapshot).not.toHaveBeenCalled();
  });
});

describe("handleReportCardsV9Preview", () => {
  beforeEach(() => {
    mockLoadPublishedReportCardsV9Snapshot.mockReset();
    mockBuildReportCardsSnapshot.mockReset();
  });

  it("serves the strict shadow projection without activating the V9 endpoint", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockResolvedValue(snapshot());

    const response = await handleReportCardsV9Preview(mockD1());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      model: "v9",
      schemaVersion: 2,
      lifecycle: "shadow",
      safetyScoreIdentity: snapshot().safetyScoreIdentity,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const endpoint = getRouteMatch("/api/report-cards/v9-preview")?.endpoint;
    expect(endpoint?.key).toBe("report-cards-v9-preview");
    expect(endpoint?.cacheBypass).toBe(true);
  });

  it("keeps the original opaque endpoint as a cache-bypassed deployment compatibility alias", () => {
    const endpoint = getRouteMatch("/api/report-cards/v9-preview-412d818c031b7bc5")?.endpoint;
    expect(endpoint?.key).toBe("report-cards-v9-preview-legacy");
    expect(endpoint?.cacheBypass).toBe(true);
  });

  it("returns explicit unavailability without reading or recomputing V8", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockRejectedValue(
      new MockV9UnavailableError("Canonical Safety Score V9 shadow cache is unavailable"),
    );

    const response = await handleReportCardsV9Preview(mockD1());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Canonical Safety Score V9 shadow cache is unavailable" });
    expect(mockBuildReportCardsSnapshot).not.toHaveBeenCalled();
  });
});
