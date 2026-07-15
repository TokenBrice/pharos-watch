import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { loadPublicationHealth } from "../publication-contract";
import { buildDewsStablecoinIdsDigest } from "../dews-publication-pointer";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";

const NOW = 1_775_890_000;
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"a".repeat(64)}`;

function generationRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    generation_id: "generation-a",
    source_state: "published",
    started_at: NOW - 600,
    validated_at: null,
    published_at: NOW - 500,
    failed_at: null,
    candidate_rows: 10,
    published_rows: 10,
    expected_rows: 10,
    failure_reason: null,
    metadata_json: null,
    ...overrides,
  };
}

function stablecoinPayload(count = 2): string {
  return JSON.stringify({
    peggedAssets: Array.from({ length: count }, (_, index) => ({
      id: `coin-${index + 1}`,
      name: `Coin ${index + 1}`,
      symbol: `C${index + 1}`,
      pegType: "peggedUSD",
      pegMechanism: "fiat-backed",
      price: 1,
      priceSource: "test",
      circulating: { peggedUSD: 1_000_000 },
      chainCirculating: {
        Ethereum: {
          current: 1_000_000,
          circulatingPrevDay: 1_000_000,
          circulatingPrevWeek: 1_000_000,
          circulatingPrevMonth: 1_000_000,
        },
      },
      chains: ["Ethereum"],
    })),
  });
}

function v9ReportCardCachePayload(updatedAt = NOW - 180): string {
  const scoreIds = [...ACTIVE_IDS].sort();
  const publicationGenerationId = `safety-score-v9:9.0:${updatedAt}`;
  return JSON.stringify({
    scores: Object.fromEntries(scoreIds.map((id) => [id, { score: 92, grade: "A" }])),
    safetyScoreIdentity: {
      model: "v9",
      schemaVersion: 1,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      policyId: "v9-policy-2026-05",
      policyDigest: "b".repeat(64),
      evaluationBuildDigest: "c".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"d".repeat(64)}`,
      publicationGenerationId,
    },
    publicationGenerationId,
    completeness: {
      generationId: publicationGenerationId,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      expectedCount: scoreIds.length,
      scoredCount: scoreIds.length,
      notRatedCount: 0,
      notRatedIds: [],
    },
    updatedAt,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
  });
}

describe("loadPublicationHealth", () => {
  it("maps existing DEX and yield publication ledgers into shared surface health", async () => {
    const db = mockD1([
      {
        match: "FROM dex_liquidity_publication_generations\n        ORDER BY started_at DESC",
        rows: [],
        first: generationRow({
          generation_id: "dex-candidate",
          source_state: "staged",
          started_at: NOW - 1_200,
          published_at: null,
          candidate_rows: 400,
          published_rows: null,
          expected_rows: 407,
          metadata_json: JSON.stringify({
            inputWatermarks: {
              dexDiscovery: NOW - 2_000,
            },
          }),
        }),
      },
      {
        match: "FROM dex_liquidity_publication_generations\n        WHERE state = 'published'",
        rows: [],
        first: generationRow({
          generation_id: "dex-published",
          started_at: NOW - 3_600,
          published_at: NOW - 3_500,
          candidate_rows: 407,
          published_rows: 407,
          expected_rows: 407,
        }),
      },
      {
        match: "FROM dex_liquidity_publication_generations\n        WHERE state = 'failed'",
        rows: [],
        first: generationRow({
          generation_id: "dex-failed",
          source_state: "failed",
          started_at: NOW - 2_400,
          published_at: null,
          failed_at: NOW - 2_300,
          failure_reason: "candidate-row-count-mismatch",
        }),
      },
      {
        match: "FROM yield_publication_generations\n        ORDER BY started_at DESC",
        rows: [],
        first: generationRow({
          generation_id: "yield-failed",
          source_state: "failed",
          started_at: NOW - 900,
          published_at: null,
          failed_at: NOW - 880,
          candidate_rows: 120,
          published_rows: null,
          expected_rows: 118,
          failure_reason: "cache-newer-than-generation",
        }),
      },
      {
        match: "FROM yield_publication_generations\n        WHERE state = 'published'",
        rows: [],
        first: generationRow({
          generation_id: "yield-published",
          started_at: NOW - 7_200,
          published_at: NOW - 7_100,
          candidate_rows: 118,
          published_rows: 118,
          expected_rows: 118,
        }),
      },
      {
        match: "FROM yield_publication_generations\n        WHERE state = 'failed'",
        rows: [],
        first: generationRow({
          generation_id: "yield-failed",
          source_state: "failed",
          started_at: NOW - 900,
          published_at: null,
          failed_at: NOW - 880,
          failure_reason: "cache-newer-than-generation",
        }),
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.checkedAt).toBe(NOW);
    expect(health.surfaces["dex-liquidity"]).toMatchObject({
      sourceOfTruth: "dex_liquidity_publication_generations",
      candidateAgeSec: 1_200,
      lastFailureReason: "candidate-row-count-mismatch",
      dependencyWatermarks: {
        dexDiscovery: NOW - 2_000,
      },
      lastAttemptedGeneration: {
        generationId: "dex-candidate",
        sourceState: "staged",
        state: "candidate",
        candidateRows: 400,
        expectedRows: 407,
      },
      lastPublishedGeneration: {
        generationId: "dex-published",
        state: "published",
        publishedRows: 407,
      },
    });
    expect(health.surfaces["yield-rankings"]).toMatchObject({
      sourceOfTruth: "yield_publication_generations",
      candidateAgeSec: null,
      lastFailureReason: "cache-newer-than-generation",
      lastAttemptedGeneration: {
        generationId: "yield-failed",
        state: "failed",
        failureReason: "cache-newer-than-generation",
      },
      lastPublishedGeneration: {
        generationId: "yield-published",
        state: "published",
      },
    });
  });

  it("projects stablecoins from the generic surface publication table when migrated rows exist", async () => {
    const db = mockD1([
      {
        match: "FROM surface_publication_generations\n          WHERE surface = ?\n          ORDER BY started_at DESC",
        matchBinds: ["stablecoins"],
        rows: [],
        first: generationRow({
          generation_id: "stablecoins-candidate",
          source_state: "candidate",
          started_at: NOW - 300,
          validated_at: null,
          published_at: null,
          candidate_rows: 408,
          published_rows: null,
          expected_rows: 407,
          metadata_json: JSON.stringify({
            inputWatermarks: {
              stablecoinsCache: NOW - 900,
            },
            artifactCacheKey: "stablecoins",
          }),
        }),
      },
      {
        match: "FROM surface_publication_generations\n          WHERE surface = ? AND state = 'published'",
        matchBinds: ["stablecoins"],
        rows: [],
        first: generationRow({
          generation_id: "stablecoins-published",
          source_state: "published",
          started_at: NOW - 1_200,
          validated_at: NOW - 1_190,
          published_at: NOW - 1_180,
          candidate_rows: 407,
          published_rows: 407,
          expected_rows: 407,
        }),
      },
      {
        match: "FROM surface_publication_generations\n          WHERE surface = ? AND state = 'failed'",
        matchBinds: ["stablecoins"],
        rows: [],
        first: null,
      },
      {
        match: "FROM surface_publication_generations\n          WHERE surface = ? AND state = 'rejected'",
        matchBinds: ["stablecoins"],
        rows: [],
        first: generationRow({
          generation_id: "stablecoins-rejected",
          source_state: "rejected",
          started_at: NOW - 600,
          published_at: null,
          failure_reason: "shrinkage-threshold-exceeded",
        }),
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.surfaces.stablecoins).toMatchObject({
      sourceOfTruth: "surface_publication_generations",
      candidateAgeSec: 300,
      lastFailureReason: "shrinkage-threshold-exceeded",
      dependencyWatermarks: {
        stablecoinsCache: NOW - 900,
      },
      lastAttemptedGeneration: {
        generationId: "stablecoins-candidate",
        state: "candidate",
        candidateRows: 408,
        expectedRows: 407,
      },
      lastPublishedGeneration: {
        generationId: "stablecoins-published",
        state: "published",
        publishedRows: 407,
      },
    });
  });

  it("derives stablecoins publication health from the canonical cache before generic writes exist", async () => {
    const updatedAt = NOW - 120;
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "stablecoins",
            value: stablecoinPayload(3),
            updated_at: updatedAt,
          },
          {
            key: "stablecoins:response-ready:v2",
            value: "{}",
            updated_at: updatedAt,
          },
        ],
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.surfaces.stablecoins).toMatchObject({
      sourceOfTruth: "cache[stablecoins]",
      candidateAgeSec: null,
      lastFailureReason: null,
      dependencyWatermarks: {
        stablecoinsCache: updatedAt,
        responseReadyCache: updatedAt,
      },
      lastAttemptedGeneration: {
        generationId: `stablecoins-cache:${updatedAt}`,
        sourceState: "published",
        state: "published",
        candidateRows: 3,
        publishedRows: 3,
        validatedAt: updatedAt,
        publishedAt: updatedAt,
      },
      lastPublishedGeneration: {
        generationId: `stablecoins-cache:${updatedAt}`,
        state: "published",
      },
    });
    expect(health.surfaces.stablecoins?.lastPublishedGeneration?.metadata).toMatchObject({
      cacheKey: "stablecoins",
      responseReadyMatchesCanonical: true,
    });
  });

  it("keeps successful surfaces when one surface query throws", async () => {
    const updatedAt = NOW - 120;
    const db = mockD1([
      {
        match: "FROM yield_publication_generations",
        rows: [],
        throwError: new Error("D1_ERROR: query failed: yield publication ledger unavailable"),
      },
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "stablecoins",
            value: stablecoinPayload(2),
            updated_at: updatedAt,
          },
          {
            key: "stablecoins:response-ready:v2",
            value: "{}",
            updated_at: updatedAt,
          },
        ],
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.surfaces["dex-liquidity"]).toBeDefined();
    expect(health.surfaces.stablecoins).toMatchObject({
      sourceOfTruth: "cache[stablecoins]",
      lastPublishedGeneration: {
        generationId: `stablecoins-cache:${updatedAt}`,
        state: "published",
      },
    });
    expect(health.surfaces["yield-rankings"]).toBeUndefined();
    expect(health.failedSurfaces).toEqual([
      {
        surface: "yield-rankings",
        code: "publication_surface_query_failed",
        message: "Publication surface query failed.",
      },
    ]);
  });

  it("falls back to the canonical stablecoins cache when the generic surface table is absent", async () => {
    const updatedAt = NOW - 180;
    const db = mockD1([
      {
        match: "FROM surface_publication_generations",
        rows: [],
        throwError: new Error("D1_ERROR: no such table: surface_publication_generations"),
      },
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "stablecoins",
            value: stablecoinPayload(2),
            updated_at: updatedAt,
          },
          {
            key: "stablecoins:response-ready:v2",
            value: "{}",
            updated_at: updatedAt,
          },
        ],
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.surfaces["dex-liquidity"]).toBeDefined();
    expect(health.surfaces["yield-rankings"]).toBeDefined();
    expect(health.surfaces.stablecoins).toMatchObject({
      sourceOfTruth: "cache[stablecoins]",
      lastFailureReason: null,
      dependencyWatermarks: {
        stablecoinsCache: updatedAt,
        responseReadyCache: updatedAt,
      },
      lastPublishedGeneration: {
        generationId: `stablecoins-cache:${updatedAt}`,
        state: "published",
        publishedRows: 2,
      },
    });
    expect(health.failedSurfaces).toBeUndefined();
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM surface_publication_generations"))).toBe(true);
  });

  it("derives DEWS, PSI, and report-card publication health from current fallback sources", async () => {
    const dewsAt = NOW - 300;
    const psiAt = NOW - 240;
    const reportCardsAt = NOW - 180;
    const reportCardIds = [...ACTIVE_IDS].sort();
    const reportCardGenerationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${reportCardsAt}`;
    const safetyScoreIdentity = buildSafetyScoreV8PublicationIdentity({
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      baseInputGenerationId: BASE_INPUT_GENERATION_ID,
      publicationGenerationId: reportCardGenerationId,
    });
    const dewsRows = [
      { stablecoin_id: "usdc-circle", score: 10, band: "CALM", signals_json: "{}", computed_at: dewsAt },
      { stablecoin_id: "usdt-tether", score: 20, band: "WATCH", signals_json: "{}", computed_at: dewsAt },
    ];
    const db = mockD1([
      {
        match: "pharos:stress-signals:published-exact",
        matchBinds: [dewsAt],
        rows: dewsRows,
      },
      {
        match: "FROM stability_index_samples",
        rows: [],
        first: {
          stored_at: psiAt,
          score: 82,
          band: "Calm",
          methodology_version: "psi-v1",
        },
      },
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "dews:published-generation",
            value: JSON.stringify({
              updatedAt: dewsAt,
              source: "compute-dews",
              publishStatus: "published",
              coverageVersion: 2,
              expectedRowCount: dewsRows.length,
              stablecoinIdsDigest: buildDewsStablecoinIdsDigest(dewsRows.map((row) => row.stablecoin_id)),
            }),
            updated_at: dewsAt,
          },
          {
            key: "report_card_cache",
            value: JSON.stringify({
              scores: Object.fromEntries(reportCardIds.map((id) => [id, { score: 92, grade: "A" }])),
              safetyScoreIdentity,
              publicationGenerationId: reportCardGenerationId,
              completeness: {
                generationId: reportCardGenerationId,
                methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
                expectedCount: reportCardIds.length,
                scoredCount: reportCardIds.length,
                notRatedCount: 0,
                notRatedIds: [],
              },
              updatedAt: reportCardsAt,
              methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
            }),
            updated_at: reportCardsAt,
          },
        ],
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.surfaces.dews).toMatchObject({
      sourceOfTruth: "cache[dews:published-generation]+stress_signals",
      lastPublishedGeneration: {
        generationId: `dews:${dewsAt}`,
        state: "published",
        publishedRows: 2,
      },
    });
    expect(health.surfaces.psi).toMatchObject({
      sourceOfTruth: "stability_index_samples",
      lastPublishedGeneration: {
        generationId: `psi:${psiAt}`,
        state: "published",
        publishedRows: 1,
      },
    });
    expect(health.surfaces["report-card-cache"]).toMatchObject({
      sourceOfTruth: "cache[report_card_cache]",
      lastPublishedGeneration: {
        generationId: `report-card-cache:${reportCardsAt}`,
        state: "published",
        publishedRows: ACTIVE_IDS.size,
      },
      dependencyWatermarks: {
        reportCardCache: reportCardsAt,
      },
    });
  });

  it("does not let a generic report-card publication row hide an incompatible active cache", async () => {
    const reportCardsAt = NOW - 180;
    const reportCardIds = [...ACTIVE_IDS].sort();
    const reportCardGenerationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${reportCardsAt}`;
    const currentIdentity = buildSafetyScoreV8PublicationIdentity({
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      baseInputGenerationId: BASE_INPUT_GENERATION_ID,
      publicationGenerationId: reportCardGenerationId,
    });
    const incompatibleIdentity = {
      ...currentIdentity,
      evaluationBuildDigest: "b".repeat(64),
    };
    const genericRow = generationRow({
      generation_id: reportCardGenerationId,
      metadata_json: JSON.stringify({
        validationSummary: { safetyScoreIdentity: currentIdentity },
      }),
    });
    const db = mockD1([
      {
        match: "FROM surface_publication_generations",
        matchBinds: ["report-card-cache"],
        rows: [],
        first: genericRow,
      },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [
          {
            key: "report_card_cache",
            value: JSON.stringify({
              scores: Object.fromEntries(reportCardIds.map((id) => [id, { score: 92, grade: "A" }])),
              safetyScoreIdentity: incompatibleIdentity,
              publicationGenerationId: reportCardGenerationId,
              completeness: {
                generationId: reportCardGenerationId,
                methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
                expectedCount: reportCardIds.length,
                scoredCount: reportCardIds.length,
                notRatedCount: 0,
                notRatedIds: [],
              },
              updatedAt: reportCardsAt,
              methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
            }),
            updated_at: reportCardsAt,
          },
        ],
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.surfaces["report-card-cache"]).toMatchObject({
      sourceOfTruth: "cache[report_card_cache]",
      lastPublishedGeneration: null,
      lastFailureReason: "identity-mismatch",
    });
  });

  it("reports a complete V9 compact publication as degraded on the V8 release", async () => {
    const reportCardsAt = NOW - 180;
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [
          {
            key: "report_card_cache",
            value: v9ReportCardCachePayload(reportCardsAt),
            updated_at: reportCardsAt,
          },
        ],
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.surfaces["report-card-cache"]).toMatchObject({
      sourceOfTruth: "cache[report_card_cache]",
      lastPublishedGeneration: null,
      lastFailureReason: "invalid-payload",
      lastAttemptedGeneration: {
        state: "failed",
        failureReason: "invalid-payload",
      },
    });
  });

  it("fails DEWS publication health closed when the pointed generation is partial", async () => {
    const dewsAt = NOW - 300;
    const publishedIds = ["usdc-circle", "usdt-tether"];
    const pointer = {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: dewsAt,
        source: "compute-dews",
        publishStatus: "published",
        coverageVersion: 2,
        expectedRowCount: publishedIds.length,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(publishedIds),
      }),
      updated_at: dewsAt,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [pointer],
        first: pointer,
      },
      {
        match: "pharos:stress-signals:published-exact",
        matchBinds: [dewsAt],
        rows: [{ stablecoin_id: "usdc-circle", score: 10, band: "CALM", signals_json: "{}", computed_at: dewsAt }],
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.surfaces.dews).toMatchObject({
      sourceOfTruth: "cache[dews:published-generation]+stress_signals",
      lastPublishedGeneration: null,
      lastFailureReason: "published generation coverage mismatch: rows=1/2",
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("stress_signals_latest"))).toBe(false);
  });

  it("returns present surfaces with null generation details when ledgers are empty", async () => {
    const health = await loadPublicationHealth(mockD1(), NOW);

    expect(health.surfaces["dex-liquidity"]).toMatchObject({
      lastAttemptedGeneration: null,
      lastPublishedGeneration: null,
      lastFailureReason: null,
      candidateAgeSec: null,
    });
    expect(health.surfaces["yield-rankings"]).toMatchObject({
      lastAttemptedGeneration: null,
      lastPublishedGeneration: null,
      lastFailureReason: null,
      candidateAgeSec: null,
    });
    expect(health.surfaces.stablecoins).toMatchObject({
      lastAttemptedGeneration: {
        generationId: "stablecoins-cache:missing",
        state: "failed",
        failureReason: "missing-cache",
      },
      lastPublishedGeneration: null,
      lastFailureReason: "missing-cache",
      candidateAgeSec: null,
    });
    expect(health.failedSurfaces).toBeUndefined();
  });
});
