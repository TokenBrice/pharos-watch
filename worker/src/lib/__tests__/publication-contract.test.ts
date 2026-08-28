import { describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import * as activeSafetyScoreSource from "../safety-score-active-source";
import { loadPublicationHealth } from "../publication-contract";

const NOW = 1_775_890_000;

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

function normalizedGeneration(overrides: Record<string, unknown>): Record<string, unknown> {
  const row = generationRow(overrides);
  const metadata = row.metadata_json == null ? null : JSON.parse(String(row.metadata_json));
  return {
    generationId: row.generation_id,
    sourceState: row.source_state,
    state: row.source_state === "staged" ? "candidate" : row.source_state,
    startedAt: row.started_at,
    validatedAt: row.validated_at,
    publishedAt: row.published_at,
    failedAt: row.failed_at,
    candidateRows: row.candidate_rows,
    publishedRows: row.published_rows,
    expectedRows: row.expected_rows,
    failureReason: row.failure_reason,
    ...(metadata ? { metadata } : {}),
  };
}

const EMPTY_PUBLICATION_TABLES: MockTableConfig[] = [
  { match: "FROM dex_liquidity_publication_generations", rows: [], first: null },
  { match: "FROM yield_publication_generations", rows: [], first: null },
  { match: "FROM surface_publication_generations", rows: [], first: null },
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
];

function mockPublicationD1(tables: MockTableConfig[] = []): MockD1Database {
  return mockD1([...tables, ...EMPTY_PUBLICATION_TABLES]);
}

describe("loadPublicationHealth", () => {
  it("maps existing DEX and yield publication ledgers into shared surface health", async () => {
    const db = mockPublicationD1([
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

    const lifecycleHistory = db.getHistory().filter((entry) =>
      entry.sql.includes("FROM dex_liquidity_publication_generations") ||
      entry.sql.includes("FROM yield_publication_generations"),
    );
    expect(lifecycleHistory.map((entry) => JSON.stringify({ sql: entry.sql, binds: entry.binds })))
      .toEqual([
        ["dex_liquidity_publication_generations", "written_row_count", "current_row_count", "expected_row_count"],
        ["dex_liquidity_publication_generations", "written_row_count", "current_row_count", "expected_row_count"],
        ["dex_liquidity_publication_generations", "written_row_count", "current_row_count", "expected_row_count"],
        ["yield_publication_generations", "source_row_count", "ranking_count", "best_row_count"],
        ["yield_publication_generations", "source_row_count", "ranking_count", "best_row_count"],
        ["yield_publication_generations", "source_row_count", "ranking_count", "best_row_count"],
      ].map(([table, candidateRows, publishedRows, expectedRows], index) => JSON.stringify({
        sql: `SELECT \n    generation_id,\n    state AS source_state,\n    started_at,\n    NULL AS validated_at,\n    published_at,\n    failed_at,\n    ${candidateRows} AS candidate_rows,\n    ${publishedRows} AS published_rows,\n    ${expectedRows} AS expected_rows,\n    failure_reason,\n    metadata_json\n         FROM ${table}\n        ${index % 3 === 0
          ? "ORDER BY started_at DESC"
          : index % 3 === 1
            ? "WHERE state = 'published'\n        ORDER BY COALESCE(published_at, started_at) DESC, started_at DESC"
            : "WHERE state = 'failed'\n        ORDER BY COALESCE(failed_at, started_at) DESC, started_at DESC"}\n        LIMIT 1`,
        binds: [],
      })));
    expect(JSON.stringify({
      dex: health.surfaces["dex-liquidity"],
      yield: health.surfaces["yield-rankings"],
    })).toBe(JSON.stringify({
      dex: {
        surface: "dex-liquidity",
        label: "DEX liquidity",
        sourceOfTruth: "dex_liquidity_publication_generations",
        lastPublishedGeneration: normalizedGeneration({
          generation_id: "dex-published",
          started_at: NOW - 3_600,
          published_at: NOW - 3_500,
          candidate_rows: 407,
          published_rows: 407,
          expected_rows: 407,
        }),
        lastAttemptedGeneration: normalizedGeneration({
          generation_id: "dex-candidate",
          source_state: "staged",
          started_at: NOW - 1_200,
          published_at: null,
          candidate_rows: 400,
          published_rows: null,
          expected_rows: 407,
          metadata_json: JSON.stringify({ inputWatermarks: { dexDiscovery: NOW - 2_000 } }),
        }),
        lastFailureReason: "candidate-row-count-mismatch",
        candidateAgeSec: 1_200,
        dependencyWatermarks: { dexDiscovery: NOW - 2_000 },
      },
      yield: {
        surface: "yield-rankings",
        label: "Yield rankings",
        sourceOfTruth: "yield_publication_generations",
        lastPublishedGeneration: normalizedGeneration({
          generation_id: "yield-published",
          started_at: NOW - 7_200,
          published_at: NOW - 7_100,
          candidate_rows: 118,
          published_rows: 118,
          expected_rows: 118,
        }),
        lastAttemptedGeneration: normalizedGeneration({
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
        lastFailureReason: "cache-newer-than-generation",
        candidateAgeSec: null,
        dependencyWatermarks: null,
      },
    }));

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
    const db = mockPublicationD1([
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

  it("keeps successful surfaces when one surface query throws", async () => {
    const db = mockPublicationD1([
      {
        match: "FROM yield_publication_generations",
        rows: [],
        throwError: new Error("D1_ERROR: query failed: yield publication ledger unavailable"),
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.surfaces["dex-liquidity"]).toBeDefined();
    expect(health.surfaces.stablecoins).toBeUndefined();
    expect(health.surfaces["yield-rankings"]).toBeUndefined();
    expect(health.failedSurfaces).toEqual([
      {
        surface: "yield-rankings",
        code: "publication_surface_query_failed",
        message: "Publication surface query failed.",
      },
    ]);
  });

  it("reports a missing mandatory generic publication table", async () => {
    const db = mockPublicationD1([
      {
        match: "FROM surface_publication_generations",
        rows: [],
        throwError: new Error("D1_ERROR: no such table: surface_publication_generations"),
      },
    ]);

    const health = await loadPublicationHealth(db, NOW);

    expect(health.surfaces.stablecoins).toBeUndefined();
    expect(health.failedSurfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: "stablecoins",
          code: "publication_surface_table_missing",
        }),
      ]),
    );
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM surface_publication_generations"))).toBe(true);
  });

  it("derives canonical V9 publication health from its current source", async () => {
    const reportCardsAt = NOW - 180;
    const snapshot = makeWorkerReportCardsV9Response({
      asOfSec: reportCardsAt - 60,
      updatedAt: reportCardsAt,
      cards: [
        makeWorkerV9Card({ id: "usdc-circle", score: 92, grade: "A" }),
        makeWorkerV9Card({ id: "usdt-tether", score: 90, grade: "A" }),
      ],
    });
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
      .mockResolvedValueOnce({
        kind: "v9",
        snapshot,
      });
    const db = mockPublicationD1();

    const health = await loadPublicationHealth(db, NOW);

    expect(health.surfaces["safety-score-v9"]).toMatchObject({
      sourceOfTruth: "cache[report-cards:v9]+cache[report-cards:v9:publication-health]",
      lastPublishedGeneration: {
        generationId: snapshot.safetyScoreIdentity.publicationGenerationId,
        state: "published",
        publishedRows: 2,
      },
      dependencyWatermarks: {
        reportCardCache: reportCardsAt,
      },
    });
  });

  it("does not synthesize stablecoins, DEWS, or PSI surfaces when the generic ledger is empty", async () => {
    const health = await loadPublicationHealth(mockPublicationD1(), NOW);

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
    expect(health.surfaces.stablecoins).toBeUndefined();
    expect(health.surfaces.dews).toBeUndefined();
    expect(health.surfaces.psi).toBeUndefined();
    expect(health.failedSurfaces).toBeUndefined();
  });
});
