import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveSafetyScoreIndex } from "../safety-score-index";
import { makeWorkerReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../safety-score-v9/consumer-freshness";

const mockLoadActiveSafetyScoreIndex = vi.fn();

vi.mock("../safety-score-index", () => ({
  loadActiveSafetyScoreIndex: mockLoadActiveSafetyScoreIndex,
}));

const {
  checkDigestSafetyContextForDelivery,
  digestSafetyContextFromPersistedInput,
  digestSafetyContextFromSource,
  findDigestSafetyClaimMarkers,
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
): Extract<ActiveSafetyScoreIndex, { kind: "v9" }> {
  const activeIdentity = { ...identity, ...overrides };
  return {
    kind: "v9",
    snapshot: makeWorkerReportCardsV9Response({
      safetyScoreIdentity: activeIdentity,
      updatedAt: 110,
    }),
  };
}

describe("digest Safety Score delivery context", () => {
  beforeEach(() => {
    mockLoadActiveSafetyScoreIndex.mockReset().mockResolvedValue(activeV9());
  });

  it("allows only the exact authored publication generation", async () => {
    await expect(
      checkDigestSafetyContextForDelivery({} as D1Database, authored, undefined, 200),
    ).resolves.toEqual({ kind: "ok" });

    mockLoadActiveSafetyScoreIndex.mockResolvedValueOnce(
      activeV9({ publicationGenerationId: "report-cards:v9:2" }),
    );
    await expect(
      checkDigestSafetyContextForDelivery({} as D1Database, authored),
    ).resolves.toEqual({ kind: "stale", reason: "identity-mismatch" });
  });

  it("expires an exact-identity delivery once the accepted publication leaves the consumer budget", async () => {
    const boundary = 110 + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC;
    await expect(
      checkDigestSafetyContextForDelivery({} as D1Database, authored, undefined, boundary),
    ).resolves.toEqual({ kind: "ok" });
    await expect(
      checkDigestSafetyContextForDelivery({} as D1Database, authored, undefined, boundary + 1),
    ).resolves.toEqual({ kind: "unavailable", reason: "v9-snapshot-stale" });
    await expect(
      checkDigestSafetyContextForDelivery({} as D1Database, authored, undefined, 109),
    ).resolves.toEqual({ kind: "unavailable", reason: "v9-snapshot-stale" });
  });

  it("binds authored context only to an accepted publication inside the consumer budget", () => {
    const boundary = 110 + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC;
    expect(digestSafetyContextFromSource(activeV9(), boundary)).toMatchObject({
      status: "available", identity, publishedAt: 110, reason: null,
    });
    for (const nowSec of [boundary + 1, 109, Number.NaN]) {
      expect(digestSafetyContextFromSource(activeV9(), nowSec)).toEqual({
        status: "unavailable", expectedModel: "v9", identity: null, publishedAt: null, reason: "v9-snapshot-stale",
      });
    }
    const held = activeV9();
    expect(digestSafetyContextFromSource({
      kind: "held", reason: "v9-publication-held", detail: "held", snapshot: held.snapshot,
    }, 110)).toMatchObject({ status: "unavailable", reason: "v9-publication-held" });
  });

  it("defers delivery while the activated V9 identity is unavailable", async () => {
    mockLoadActiveSafetyScoreIndex.mockResolvedValueOnce({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      detail: "marker and snapshot disagree",
      snapshot: null,
    } satisfies ActiveSafetyScoreIndex);

    await expect(
      checkDigestSafetyContextForDelivery({} as D1Database, authored),
    ).resolves.toEqual({ kind: "unavailable", reason: "v9-snapshot-unavailable" });
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
    expect(mockLoadActiveSafetyScoreIndex).not.toHaveBeenCalled();
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

  it("detects signed and transferred grade claims in symbol copy", () => {
    // A sign is a non-word character, so the grade cannot be anchored with \b;
    // A+/A- and bare A are ordinary published grades.
    expect(findDigestSafetyClaimMarkers({ text: "USDT remains at A- while USDC holds an A+" }))
      .toContain("symbol-grade");
    expect(findDigestSafetyClaimMarkers({ text: "USDC slipped to B+." })).toContain("symbol-grade");
    expect(findDigestSafetyClaimMarkers({ text: "USDT fell from A to B." })).toContain("symbol-grade");
    expect(findUnboundDigestSafetyClaimMarkers({
      status: "unavailable", expectedModel: "v9", identity: null, publishedAt: null,
      reason: "v9-snapshot-unavailable",
    }, { title: "Tier check", text: "USDT remains at A- while USDC holds an A+" }))
      .toContain("symbol-grade");
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
