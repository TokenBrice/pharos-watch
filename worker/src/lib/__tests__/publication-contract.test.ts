import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import * as activeSafetyScoreSource from "../safety-score-active-source";
import { loadPublicationHealth } from "../publication-contract";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

const NOW = 1_775_890_000;


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
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
      (generation_id, state, started_at, created_at, published_at, failed_at,
       written_row_count, current_row_count, expected_row_count, failure_reason, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("dex-candidate", "staged", NOW - 1_200, NOW - 1_200, null, null, 400, null, 407, null,
        JSON.stringify({ inputWatermarks: { dexDiscovery: NOW - 2_000 } }));
    sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
      (generation_id, state, started_at, created_at, published_at, failed_at,
       written_row_count, current_row_count, expected_row_count, failure_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("dex-published", "published", NOW - 3_600, NOW - 3_600, NOW - 3_500, null, 407, 407, 407, null);
    sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
      (generation_id, state, started_at, created_at, failed_at, expected_row_count, failure_reason)
      VALUES ('dex-failed', 'failed', ?, ?, ?, 407, 'candidate-row-count-mismatch')`)
      .run(NOW - 2_400, NOW - 2_400, NOW - 2_300);
    const yieldInsert = sqlite.prepare(`INSERT INTO yield_publication_generations
      (generation_id, state, started_at, created_at, published_at, failed_at,
       source_row_count, ranking_count, best_row_count, failure_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    yieldInsert.run("yield-failed", "failed", NOW - 900, NOW - 900, null, NOW - 880, 120, null, 118, "cache-newer-than-generation");
    yieldInsert.run("yield-published", "published", NOW - 7_200, NOW - 7_200, NOW - 7_100, null, 118, 118, 118, null);

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

  it("selects publication time over start time and supersedes a different latest attempt", async () => {
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO surface_publication_generations
      (surface, generation_id, state, started_at, published_at, candidate_rows, published_rows, expected_rows, input_watermarks_json)
      VALUES ('stablecoins', ?, 'published', ?, ?, 407, 407, 407, ?)`);
    insert.run("older-start-later-publish", NOW - 1_200, NOW - 100,
      JSON.stringify({ stablecoinsCache: NOW - 900 }));
    insert.run("newer-start-earlier-publish", NOW - 600, NOW - 500, null);

    const health = await loadPublicationHealth(db, NOW);
    expect(health.surfaces.stablecoins).toMatchObject({
      lastPublishedGeneration: { generationId: "older-start-later-publish", state: "published", publishedRows: 407 },
      lastAttemptedGeneration: { generationId: "newer-start-earlier-publish", state: "superseded", candidateRows: 407 },
      dependencyWatermarks: { stablecoinsCache: NOW - 900 },
      candidateAgeSec: null,
    });
    sqlite.prepare(`INSERT INTO surface_publication_generations
      (surface, generation_id, state, started_at, candidate_rows, expected_rows)
      VALUES ('stablecoins', 'candidate', 'candidate', ?, 408, 407)`).run(NOW - 30);
    expect((await loadPublicationHealth(db, NOW)).surfaces.stablecoins).toMatchObject({
      lastAttemptedGeneration: { generationId: "candidate", state: "candidate", candidateRows: 408, expectedRows: 407 },
      candidateAgeSec: 30,
      dependencyWatermarks: { stablecoinsCache: NOW - 900 },
    });
  });

  it.each(["failed", "rejected"] as const)("uses the more recent %s generic failure", async (latestState) => {
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO surface_publication_generations
      (surface, generation_id, state, started_at, failure_reason)
      VALUES ('stablecoins', ?, ?, ?, ?)`);
    for (const state of ["failed", "rejected"]) {
      insert.run(state, state, NOW - (state === latestState ? 30 : 60), `${state}-reason`);
    }
    expect((await loadPublicationHealth(db, NOW)).surfaces.stablecoins).toMatchObject({
      lastAttemptedGeneration: { generationId: latestState, state: latestState },
      lastFailureReason: `${latestState}-reason`,
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
