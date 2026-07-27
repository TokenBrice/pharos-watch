import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentifiedActiveSafetyScoreSource } from "../identified-active-safety-score-source";
import { makeWorkerReportCardsV9Response } from "../../test-helpers/report-cards-v9";

const mockLoadIdentifiedActiveSafetyScoreSource = vi.fn();

vi.mock("../identified-active-safety-score-source", () => ({
  loadIdentifiedActiveSafetyScoreSource: mockLoadIdentifiedActiveSafetyScoreSource,
}));

const {
  checkDigestSafetyContextForDelivery,
  digestSafetyContextFromPersistedInput,
  findUnboundDigestSafetyClaimMarkers,
} = await import("../digest-safety-context");

const identity = {
  model: "v9" as const,
  schemaVersion: 1 as const,
  methodologyVersion: "9.0",
  policyId: "safety-score-v9",
  policyDigest: "a".repeat(64),
  evaluationBuildDigest: "b".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
  publicationGenerationId: "report-cards:v9:1",
};
const authored = {
  status: "available" as const,
  expectedModel: "v9" as const,
  identity,
  publishedAt: 100,
  reason: null,
};

function activeV9(
  overrides: Partial<typeof identity> = {},
): Extract<IdentifiedActiveSafetyScoreSource, { kind: "v9" }> {
  const activeIdentity = { ...identity, ...overrides };
  return {
    kind: "v9",
    expectedModel: "v9",
    identity: activeIdentity,
    publishedAtSec: 110,
    snapshot: makeWorkerReportCardsV9Response({
      safetyScoreIdentity: activeIdentity,
      updatedAt: 110,
    }),
  };
}

describe("digest Safety Score delivery context", () => {
  beforeEach(() => {
    mockLoadIdentifiedActiveSafetyScoreSource.mockReset().mockResolvedValue(activeV9());
  });

  it("allows only the exact authored publication generation", async () => {
    await expect(
      checkDigestSafetyContextForDelivery({} as D1Database, authored),
    ).resolves.toEqual({ kind: "ok" });

    mockLoadIdentifiedActiveSafetyScoreSource.mockResolvedValueOnce(
      activeV9({ publicationGenerationId: "report-cards:v9:2" }),
    );
    await expect(
      checkDigestSafetyContextForDelivery({} as D1Database, authored),
    ).resolves.toEqual({ kind: "stale", reason: "identity-mismatch" });
  });

  it("defers delivery while the activated V9 identity is unavailable", async () => {
    mockLoadIdentifiedActiveSafetyScoreSource.mockResolvedValueOnce({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-identity-mismatch",
      detail: "marker and snapshot disagree",
    } satisfies IdentifiedActiveSafetyScoreSource);

    await expect(
      checkDigestSafetyContextForDelivery({} as D1Database, authored),
    ).resolves.toEqual({ kind: "unavailable", reason: "v9-identity-mismatch" });
  });

  it("allows a safety-free degraded digest but rejects a legacy unbound edition", async () => {
    await expect(
      checkDigestSafetyContextForDelivery({} as D1Database, {
        status: "unavailable",
        expectedModel: "v9",
        identity: null,
        publishedAt: null,
        reason: "v9-snapshot-unavailable",
      }),
    ).resolves.toEqual({ kind: "ok" });
    await expect(
      checkDigestSafetyContextForDelivery({} as D1Database, {
        status: "unavailable",
        expectedModel: "v8",
        identity: null,
        publishedAt: null,
        reason: "legacy-unbound",
      }),
    ).resolves.toEqual({ kind: "stale", reason: "legacy-unbound" });
    expect(mockLoadIdentifiedActiveSafetyScoreSource).not.toHaveBeenCalled();
  });

  it("detects report-card claims only when copy has no identified publication", () => {
    const copy = {
      title: "USDT Holds Its A Grade",
      text: "The Safety Score remains firm.",
      extended: "USDT's report card still has a binding cap.",
    };

    expect(findUnboundDigestSafetyClaimMarkers({
      status: "unavailable",
      expectedModel: "v9",
      identity: null,
      publishedAt: null,
      reason: "v9-snapshot-unavailable",
    }, copy)).toEqual([
      "safety-score",
      "report-card",
      "grade-language",
      "binding-cap",
    ]);
    expect(findUnboundDigestSafetyClaimMarkers(authored, copy)).toEqual([]);
    expect(findUnboundDigestSafetyClaimMarkers(undefined, {
      text: "Capital moved into safe havens while PSI held.",
    })).toEqual([]);
  });

  it("recovers full identity from pre-context V8 digest provenance", () => {
    const v8Identity = {
      model: "v8" as const,
      schemaVersion: 1 as const,
      methodologyVersion: "8.17",
      evaluationBuildDigest: "d".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}`,
      publicationGenerationId: "report-cards:v8:1",
    };

    expect(digestSafetyContextFromPersistedInput({
      safetyScores: {
        provenance: { ...v8Identity, publishedAt: 90 },
      },
    })).toEqual({
      status: "available",
      expectedModel: "v8",
      identity: v8Identity,
      publishedAt: 90,
      reason: null,
    });
  });
});
