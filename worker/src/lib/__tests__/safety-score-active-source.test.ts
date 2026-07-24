import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const mockLoadPublishedReportCardsV9Snapshot = vi.fn();

class MockV9UnavailableError extends Error {}

vi.mock("../report-cards-v9-cache", () => ({
  loadPublishedReportCardsV9Snapshot: mockLoadPublishedReportCardsV9Snapshot,
  ReportCardsV9SnapshotUnavailableError: MockV9UnavailableError,
}));

const {
  loadActiveSafetyScoreSource,
  REPORT_CARDS_V9_ACTIVATION_CACHE_KEY,
} = await import("../safety-score-active-source");

const digest = (character: string) => character.repeat(64);

function snapshot(): ReportCardsV9Response {
  return {
    model: "v9",
    schemaVersion: 3,
    lifecycle: "shadow",
    safetyScoreIdentity: {
      model: "v9",
      schemaVersion: 1,
      methodologyVersion: "9.0",
      policyId: "safety-score-v9-policy",
      policyDigest: digest("a"),
      evaluationBuildDigest: digest("b"),
      baseInputGenerationId: `report-cards-input:v1:${digest("c")}`,
      publicationGenerationId: "safety-score-v9:test",
    },
    methodology: {
      version: "9.0",
      policy: { id: "safety-score-v9-policy", semanticDigest: digest("a") },
    },
    asOfSec: 1_700_000_000,
    updatedAt: 1_700_000_030,
    completeness: { expectedCount: 0, ratedCount: 0, notRatedCount: 0, notRatedIds: [] },
    source: {
      candidateId: "candidate-v9-active-source-test",
      factSetDigest: digest("d"),
      resultDigest: digest("e"),
      sourceGenerations: { registry: "registry:active-source-test" },
    },
    cards: [],
    dependencyGraph: { edges: [] },
  };
}

function markerValue(overrides: Record<string, unknown> = {}): string {
  const identity = snapshot().safetyScoreIdentity;
  return JSON.stringify({
    policyId: identity.policyId,
    policyDigest: identity.policyDigest,
    evaluationBuildDigest: identity.evaluationBuildDigest,
    methodologyVersion: identity.methodologyVersion,
    ...overrides,
  });
}

function markerDb(value: string) {
  return mockD1([
    {
      match: "FROM cache WHERE key = ?",
      matchBinds: [REPORT_CARDS_V9_ACTIVATION_CACHE_KEY],
      rows: [{ value, updated_at: 1_700_000_000 }],
    },
  ]);
}

describe("active Safety Score source", () => {
  beforeEach(() => {
    mockLoadPublishedReportCardsV9Snapshot.mockReset();
  });

  it("treats a missing activation marker as the explicit V8 rollback expectation", async () => {
    const result = await loadActiveSafetyScoreSource(mockD1());

    expect(result).toEqual({
      kind: "v8",
      expectedModel: "v8",
      reason: "activation-marker-missing",
      activationUpdatedAt: null,
    });
    expect(mockLoadPublishedReportCardsV9Snapshot).not.toHaveBeenCalled();
  });

  it("fails closed for a present malformed marker without reading V9", async () => {
    const result = await loadActiveSafetyScoreSource(markerDb('{"policyId":"incomplete"}'));

    expect(result).toMatchObject({
      kind: "error",
      expectedModel: "v9",
      reason: "activation-marker-invalid",
      activationUpdatedAt: 1_700_000_000,
    });
    expect(mockLoadPublishedReportCardsV9Snapshot).not.toHaveBeenCalled();
  });

  it("returns V9 only when the canonical snapshot matches every bound identity field", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockResolvedValue(snapshot());

    await expect(loadActiveSafetyScoreSource(markerDb(markerValue()))).resolves.toMatchObject({
      kind: "v9",
      expectedModel: "v9",
      marker: {
        policyId: "safety-score-v9-policy",
        methodologyVersion: "9.0",
      },
      snapshot: snapshot(),
    });

    await expect(
      loadActiveSafetyScoreSource(markerDb(markerValue({ policyDigest: digest("d") }))),
    ).resolves.toMatchObject({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-identity-mismatch",
      snapshot: snapshot(),
    });
  });

  it("reports an identity-bound marker with no canonical V9 snapshot as unavailable", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockRejectedValue(
      new MockV9UnavailableError("Canonical Safety Score V9 shadow cache is unavailable"),
    );

    await expect(loadActiveSafetyScoreSource(markerDb(markerValue()))).resolves.toMatchObject({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-snapshot-unavailable",
      detail: "Canonical Safety Score V9 shadow cache is unavailable",
    });
  });

  it("fails closed when activation resolves only a previous report contract", async () => {
    mockLoadPublishedReportCardsV9Snapshot.mockResolvedValue({
      ...snapshot(),
      schemaVersion: 1,
    });

    await expect(loadActiveSafetyScoreSource(markerDb(markerValue()))).resolves.toMatchObject({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-snapshot-unavailable",
      detail: "Canonical Safety Score V9 snapshot does not satisfy the current report contract",
    });
  });
});
