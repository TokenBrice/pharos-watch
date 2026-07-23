import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const buildReportCardsSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => ({
    cards: [
      {
        id: "usdt-tether",
        symbol: "AAA",
        overallGrade: "B",
        overallScore: 75,
        dimensions: { liquidity: { score: 80 } },
        rawInputs: { pegScore: 88, navToken: false },
        isDefunct: false,
      },
      {
        id: "usdc-circle",
        symbol: "BBB",
        overallGrade: "B+",
        overallScore: 82,
        dimensions: { liquidity: { score: 84 } },
        rawInputs: { pegScore: 91, navToken: false },
        isDefunct: false,
      },
      {
        id: "ust-terra",
        symbol: "NAV",
        overallGrade: "A",
        overallScore: 95,
        dimensions: { liquidity: { score: 90 } },
        rawInputs: { pegScore: null, navToken: true },
        isDefunct: false,
      },
      {
        id: "dead-coin",
        symbol: "DEAD",
        overallGrade: "F",
        overallScore: 0,
        dimensions: { liquidity: { score: 0 } },
        rawInputs: { pegScore: null, navToken: false },
        isDefunct: true,
      },
    ],
  })),
);
const reportCardsSnapshotUnavailableErrorCtor = vi.hoisted(
  () => class ReportCardsSnapshotUnavailableError extends Error {},
);

vi.mock("@shared/lib/stablecoins/registry", () => {
  const stablecoins = [
    {
      id: "usdt-tether",
      symbol: "AAA",
      name: "AAA Stable",
      flags: { pegCurrency: "USD", governance: "centralized", navToken: false },
    },
    {
      id: "usdc-circle",
      symbol: "BBB",
      name: "BBB Stable",
      flags: { pegCurrency: "USD", governance: "centralized-dependent", navToken: false },
    },
    {
      id: "ust-terra",
      symbol: "NAV",
      name: "NAV Token",
      flags: { pegCurrency: "USD", governance: "centralized", navToken: true },
    },
  ];
  return {
    TRACKED_STABLECOINS: stablecoins,
    ACTIVE_STABLECOINS: stablecoins,
    ACTIVE_IDS: new Set(stablecoins.map((coin) => coin.id)),
  };
});

vi.mock("../report-cards-snapshot", () => ({
  buildReportCardsSnapshot: buildReportCardsSnapshotMock,
  ReportCardsSnapshotUnavailableError: reportCardsSnapshotUnavailableErrorCtor,
}));

import { computeSafetyScoresSnapshot } from "../safety-scores";
import * as activeSafetyScoreSource from "../safety-score-active-source";
import type { StablecoinsCacheLoadOk } from "../stablecoins-cache";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";

const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"a".repeat(64)}`;

function v8PublicationIdentity(publicationGenerationId: string) {
  return buildSafetyScoreV8PublicationIdentity({
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    publicationGenerationId,
  });
}

describe("computeSafetyScoresSnapshot", () => {
  let db: D1Database;

  beforeEach(() => {
    db = mockD1();
    buildReportCardsSnapshotMock.mockClear();
  });

  it("returns map mode and excludes NAV tokens when requested", async () => {
    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: false,
      outputMode: "map",
    });

    expect(result.kind).toBe("ok");
    expect(result.mode).toBe("map");
    expect(result.scores.get("usdt-tether")).toEqual({ score: 75, grade: "B" });
    expect(result.scores.get("usdc-circle")).toEqual({ score: 82, grade: "B+" });
    expect(result.scores.has("ust-terra")).toBe(false);
    expect(buildReportCardsSnapshotMock).toHaveBeenCalledWith(db);
  });

  it("returns full-grades mode including NAV tokens when enabled", async () => {
    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: true,
      outputMode: "full-grades",
    });

    expect(result.kind).toBe("ok");
    expect(result.mode).toBe("full-grades");
    expect(result.scores.get("ust-terra")).toEqual({ score: 95, grade: "A" });
    expect(result.grades).toEqual([
      { id: "usdt-tether", symbol: "AAA", grade: "B", score: 75, pegScore: 88, liqScore: 80 },
      { id: "usdc-circle", symbol: "BBB", grade: "B+", score: 82, pegScore: 91, liqScore: 84 },
      { id: "ust-terra", symbol: "NAV", grade: "A", score: 95, pegScore: null, liqScore: 90 },
    ]);
  });

  it("passes a preloaded stablecoins cache through to the report-card builder", async () => {
    const preloadedStablecoinsCache: StablecoinsCacheLoadOk = {
      kind: "ok",
      payload: { peggedAssets: [] },
      updatedAt: 123,
    };

    await computeSafetyScoresSnapshot(db, {
      includeNavTokens: true,
      outputMode: "map",
      preloadedStablecoinsCache,
    });

    expect(buildReportCardsSnapshotMock).toHaveBeenCalledWith(db, { preloadedStablecoinsCache });
  });

  it("returns degraded result when report-card snapshot build fails", async () => {
    buildReportCardsSnapshotMock.mockRejectedValueOnce(new Error("Cached stablecoins data is corrupt"));

    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: false,
      outputMode: "map",
    });

    expect(result.kind).toBe("degraded");
    expect(result.coveredCount).toBe(0);
    expect(result.reason).toBe("Cached stablecoins data is corrupt");
  });

  it("preserves typed snapshot-unavailable reasons in degraded mode", async () => {
    buildReportCardsSnapshotMock.mockRejectedValueOnce(
      new reportCardsSnapshotUnavailableErrorCtor("Redemption backstop snapshot unavailable"),
    );

    const result = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: false,
      outputMode: "map",
    });

    expect(result.kind).toBe("degraded");
    expect(result.reason).toBe("Redemption backstop snapshot unavailable");
  });

  it("loads V8 yield safety from one exact published report-card generation when the activation marker is absent", async () => {
    const updatedAt = Math.floor(Date.now() / 1000);
    const generationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`;
    db = mockD1([{
      match: "FROM cache WHERE key = ?",
      matchBinds: ["report_card_cache"],
      rows: [{
        key: "report_card_cache",
        value: JSON.stringify({
          scores: {
            "usdt-tether": { score: 75, grade: "B" },
            "usdc-circle": { score: 82, grade: "B+" },
          },
          updatedAt,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          safetyScoreIdentity: v8PublicationIdentity(generationId),
          publicationGenerationId: generationId,
          completeness: {
            generationId,
            methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
            expectedCount: 3,
            scoredCount: 2,
            notRatedCount: 1,
            notRatedIds: ["ust-terra"],
          },
        }),
        updated_at: updatedAt,
      }],
    }]);

    const result = await computeSafetyScoresSnapshot(db, {
      outputMode: "map",
      sourceMode: "published-cache",
    });

    expect(result).toMatchObject({
      kind: "ok",
      source: "report-card-cache",
      expectedModel: "v8",
      publicationGenerationId: generationId,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
      coveredCount: 2,
      trackedCount: 3,
    });
    expect(result.scores.get("usdc-circle")).toEqual({ score: 82, grade: "B+" });
    expect(buildReportCardsSnapshotMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "valid V9 activation",
      {
        kind: "v9",
        expectedModel: "v9",
        snapshot: { completeness: { expectedCount: 2 } },
      },
      "active-safety-score:v9",
      2,
    ],
    [
      "malformed activation marker",
      {
        kind: "error",
        expectedModel: "v9",
        reason: "activation-marker-invalid",
        snapshot: null,
      },
      "active-safety-score:activation-marker-invalid",
      3,
    ],
    [
      "mismatched V9 activation identity",
      {
        kind: "error",
        expectedModel: "v9",
        reason: "v9-identity-mismatch",
        snapshot: { completeness: { expectedCount: 2 } },
      },
      "active-safety-score:v9-identity-mismatch",
      2,
    ],
  ] as const)("fails the compact V8 score source closed for %s", async (
    _label,
    activeSource,
    reason,
    trackedCount,
  ) => {
    const activeSourceSpy = vi
      .spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
      .mockResolvedValueOnce(activeSource as never);

    const result = await computeSafetyScoresSnapshot(db, {
      outputMode: "map",
      sourceMode: "published-cache",
    });

    expect(result).toMatchObject({
      kind: "degraded",
      source: "report-card-cache",
      expectedModel: "v9",
      reason,
      coveredCount: 0,
      trackedCount,
      safetyScoreIdentity: null,
      publicationGenerationId: null,
      methodologyVersion: null,
      publishedAt: null,
    });
    expect(result.scores.size).toBe(0);
    expect(buildReportCardsSnapshotMock).not.toHaveBeenCalled();
    activeSourceSpy.mockRestore();
  });

  it("fails closed when a compact cache V8 identity is from a different evaluation build", async () => {
    const updatedAt = Math.floor(Date.now() / 1000);
    const generationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`;
    const currentIdentity = v8PublicationIdentity(generationId);
    const nonCurrentIdentity = {
      ...currentIdentity,
      evaluationBuildDigest: currentIdentity.evaluationBuildDigest === "b".repeat(64) ? "c".repeat(64) : "b".repeat(64),
    };
    db = mockD1([{
      match: "FROM cache WHERE key = ?",
      matchBinds: ["report_card_cache"],
      rows: [{
        key: "report_card_cache",
        value: JSON.stringify({
          scores: {
            "usdt-tether": { score: 75, grade: "B" },
            "usdc-circle": { score: 82, grade: "B+" },
          },
          updatedAt,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          safetyScoreIdentity: nonCurrentIdentity,
          publicationGenerationId: generationId,
          completeness: {
            generationId,
            methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
            expectedCount: 3,
            scoredCount: 2,
            notRatedCount: 1,
            notRatedIds: ["ust-terra"],
          },
        }),
        updated_at: updatedAt,
      }],
    }]);

    const result = await computeSafetyScoresSnapshot(db, {
      outputMode: "map",
      sourceMode: "published-cache",
    });

    expect(result).toMatchObject({
      kind: "degraded",
      source: "report-card-cache",
      reason: "report-card-cache:identity-mismatch",
      safetyScoreIdentity: nonCurrentIdentity,
      publicationGenerationId: generationId,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
      coveredCount: 0,
      trackedCount: 3,
    });
    expect(result.scores.size).toBe(0);
    expect(buildReportCardsSnapshotMock).not.toHaveBeenCalled();
  });

  it("fails closed when a compact cache carries an unsupported V9 identity", async () => {
    const updatedAt = Math.floor(Date.now() / 1000);
    const generationId = `safety-score-v9:9.0:${updatedAt}`;
    db = mockD1([{
      match: "FROM cache WHERE key = ?",
      matchBinds: ["report_card_cache"],
      rows: [{
        key: "report_card_cache",
        value: JSON.stringify({
          scores: {
            "usdt-tether": { score: 75, grade: "B" },
            "usdc-circle": { score: 82, grade: "B+" },
          },
          updatedAt,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          safetyScoreIdentity: {
            model: "v9",
            schemaVersion: 1,
            methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
            policyId: "v9-policy-2026-05",
            policyDigest: "b".repeat(64),
            evaluationBuildDigest: "c".repeat(64),
            baseInputGenerationId: `report-cards-input:v1:${"d".repeat(64)}`,
            publicationGenerationId: generationId,
          },
          publicationGenerationId: generationId,
          completeness: {
            generationId,
            methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
            expectedCount: 3,
            scoredCount: 2,
            notRatedCount: 1,
            notRatedIds: ["ust-terra"],
          },
        }),
        updated_at: updatedAt,
      }],
    }]);

    const result = await computeSafetyScoresSnapshot(db, {
      outputMode: "map",
      sourceMode: "published-cache",
    });

    expect(result).toMatchObject({
      kind: "degraded",
      source: "report-card-cache",
      reason: "report-card-cache:invalid-payload",
      safetyScoreIdentity: null,
      publicationGenerationId: null,
      methodologyVersion: null,
      coveredCount: 0,
      trackedCount: 3,
    });
    expect(result.scores.size).toBe(0);
    expect(buildReportCardsSnapshotMock).not.toHaveBeenCalled();
  });

  it("degrades yield safety when the compact cache manifest swaps an active identity", async () => {
    const updatedAt = Math.floor(Date.now() / 1000);
    const generationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`;
    db = mockD1([{
      match: "FROM cache WHERE key = ?",
      matchBinds: ["report_card_cache"],
      rows: [{
        key: "report_card_cache",
        value: JSON.stringify({
          scores: {
            "usdt-tether": { score: 75, grade: "B" },
            "unexpected-stablecoin": { score: 82, grade: "B+" },
          },
          updatedAt,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          safetyScoreIdentity: v8PublicationIdentity(generationId),
          publicationGenerationId: generationId,
          completeness: {
            generationId,
            methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
            expectedCount: 3,
            scoredCount: 2,
            notRatedCount: 1,
            notRatedIds: ["ust-terra"],
          },
        }),
        updated_at: updatedAt,
      }],
    }]);

    const result = await computeSafetyScoresSnapshot(db, {
      outputMode: "map",
      sourceMode: "published-cache",
    });

    expect(result).toMatchObject({
      kind: "degraded",
      source: "report-card-cache",
      publicationGenerationId: null,
      reason: "report-card-cache:completeness-mismatch",
    });
    expect(result.scores.size).toBe(0);
    expect(buildReportCardsSnapshotMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing cache", null, "report-card-cache:missing-cache"],
    [
      "legacy cache without identity",
      {
        scores: { "usdt-tether": { score: 75, grade: "B" } },
        updatedAt: Math.floor(Date.now() / 1000),
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      },
      "report-card-cache:identity-missing",
    ],
  ])("fails closed for %s", async (_label, payload, reason) => {
    if (payload) {
      db = mockD1([{
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [{
          key: "report_card_cache",
          value: JSON.stringify(payload),
          updated_at: payload.updatedAt,
        }],
      }]);
    }

    const result = await computeSafetyScoresSnapshot(db, {
      outputMode: "map",
      sourceMode: "published-cache",
    });

    expect(result).toMatchObject({
      kind: "degraded",
      source: "report-card-cache",
      publicationGenerationId: null,
      methodologyVersion: null,
      reason,
      coveredCount: 0,
      trackedCount: 3,
    });
    expect(result.scores.size).toBe(0);
    expect(buildReportCardsSnapshotMock).not.toHaveBeenCalled();
  });

  it("fails closed for a canonical identity without completeness", async () => {
    const updatedAt = Math.floor(Date.now() / 1000);
    const generationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`;
    db = mockD1([{
      match: "FROM cache WHERE key = ?",
      matchBinds: ["report_card_cache"],
      rows: [{
        key: "report_card_cache",
        value: JSON.stringify({
          scores: { "usdt-tether": { score: 75, grade: "B" } },
          updatedAt,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          safetyScoreIdentity: v8PublicationIdentity(generationId),
          publicationGenerationId: generationId,
        }),
        updated_at: updatedAt,
      }],
    }]);

    const result = await computeSafetyScoresSnapshot(db, {
      outputMode: "map",
      sourceMode: "published-cache",
    });

    expect(result).toMatchObject({
      kind: "degraded",
      source: "report-card-cache",
      reason: "report-card-cache:completeness-missing",
      publicationGenerationId: null,
      methodologyVersion: null,
      publishedAt: updatedAt,
      coveredCount: 0,
      trackedCount: 3,
    });
    expect(result.scores.size).toBe(0);
  });

  it("preserves the exact generation while degrading stale report-card inputs", async () => {
    const updatedAt = Math.floor(Date.now() / 1000);
    const generationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${updatedAt}`;
    db = mockD1([{
      match: "FROM cache WHERE key = ?",
      matchBinds: ["report_card_cache"],
      rows: [{
        key: "report_card_cache",
        value: JSON.stringify({
          scores: {
            "usdt-tether": { score: 75, grade: "B" },
            "usdc-circle": { score: 82, grade: "B+" },
          },
          updatedAt,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          safetyScoreIdentity: v8PublicationIdentity(generationId),
          publicationGenerationId: generationId,
          completeness: {
            generationId,
            methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
            expectedCount: 3,
            scoredCount: 2,
            notRatedCount: 1,
            notRatedIds: ["ust-terra"],
          },
          degradedInputs: {
            inputsStale: true,
            liquidityStale: true,
            redemptionStale: false,
            staleInputs: ["dexLiquidity"],
          },
        }),
        updated_at: updatedAt,
      }],
    }]);

    const result = await computeSafetyScoresSnapshot(db, {
      outputMode: "map",
      sourceMode: "published-cache",
    });

    expect(result).toMatchObject({
      kind: "degraded",
      source: "report-card-cache",
      publicationGenerationId: generationId,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      publishedAt: updatedAt,
      reason: "report-card-cache:degraded-inputs",
      coveredCount: 2,
      trackedCount: 3,
    });
  });

  it("rejects full-grade output for the compact published source", async () => {
    await expect(computeSafetyScoresSnapshot(db, {
      outputMode: "full-grades",
      sourceMode: "published-cache",
    } as never)).rejects.toThrow("published-cache safety scores support map output only");
    expect(buildReportCardsSnapshotMock).not.toHaveBeenCalled();
  });
});
